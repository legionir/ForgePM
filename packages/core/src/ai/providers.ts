import { z } from 'zod';
import type { AiProvider, GenerateRequest, GenerateResult } from './provider';
import { ProviderError, estimateTokens } from './provider';

/**
 * FakeProvider (plan §7): deterministic, offline. Its output is supplied at
 * construction (a fixture list or a function of the request). Used by every
 * Planner/Review test so no network/real provider is required.
 */
export class FakeProvider implements AiProvider {
  readonly kind = 'fake';
  readonly model: string;
  private responses: unknown[] = [];
  private cursor = 0;
  private producer?: (req: GenerateRequest) => unknown;

  constructor(opts: { model?: string; responses: unknown[] | ((req: GenerateRequest) => unknown) }) {
    this.model = opts.model ?? 'fake-1';
    if (typeof opts.responses === 'function') this.producer = opts.responses;
    else this.responses = opts.responses;
  }

  async generateStructured<T>(req: GenerateRequest): Promise<GenerateResult<T>> {
    const raw = this.producer ? this.producer(req) : this.responses[this.cursor++];
    if (!this.producer && this.cursor > this.responses.length) {
      throw new ProviderError('FakeProvider: no more fixture responses');
    }
    return validate<T>(req, raw, this.model);
  }

  async ping() {
    return true;
  }
}

function validate<T>(req: GenerateRequest, raw: unknown, model: string): GenerateResult<T> {
  if (raw === undefined) throw new ProviderError('FakeProvider: no more fixture responses');
  const parsed = req.schema.safeParse(typeof raw === 'string' ? JSON.parse(raw) : raw);
  if (!parsed.success) {
    throw new ProviderError(`fake output invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const input = estimateTokens(req.system + req.messages.map((m) => m.content).join(''));
  const output = estimateTokens(JSON.stringify(parsed.data));
  return { value: parsed.data as T, tokens_in: input, tokens_out: output, model };
}

/**
 * OpenAI-compatible chat-completions provider (also used for Ollama/vLLM via
 * base_url). Network is only touched when a real call is made — never in the
 * offline test suite.
 */
export class OpenAiCompatibleProvider implements AiProvider {
  readonly kind: string;
  readonly model: string;
  constructor(private cfg: { baseUrl: string; apiKey: string; model: string; kind?: string }) {
    this.kind = cfg.kind ?? 'openai_compatible';
    this.model = cfg.model;
  }

  async generateStructured<T>(req: GenerateRequest): Promise<GenerateResult<T>> {
    const body = {
      model: this.model,
      messages: [{ role: 'system', content: req.system }, ...req.messages],
      temperature: req.temperature ?? 0,
      max_tokens: req.maxTokens,
      response_format: { type: 'json_object' },
    };
    const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new ProviderError(`provider HTTP ${res.status}`, res.status >= 500);
    const json = (await res.json()) as {
      choices: { message: { content: string } }[];
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new ProviderError('provider returned no content');
    return finish(req, content, json.usage?.prompt_tokens, json.usage?.completion_tokens, this.model);
  }
}

/** Anthropic messages API provider (plan §7). Network only on a real call. */
export class AnthropicProvider implements AiProvider {
  readonly kind = 'anthropic';
  readonly model: string;
  constructor(private cfg: { baseUrl: string; apiKey: string; model: string }) {
    this.model = cfg.model;
  }

  async generateStructured<T>(req: GenerateRequest): Promise<GenerateResult<T>> {
    const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.cfg.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: this.model,
        system: req.system,
        messages: req.messages,
        max_tokens: req.maxTokens ?? 4096,
        temperature: req.temperature ?? 0,
      }),
    });
    if (!res.ok) throw new ProviderError(`provider HTTP ${res.status}`, res.status >= 500);
    const json = (await res.json()) as {
      content: { type: string; text: string }[];
      usage?: { input_tokens: number; output_tokens: number };
    };
    const text = json.content.map((c) => c.text).join('');
    if (!text) throw new ProviderError('provider returned no content');
    return finish(req, text, json.usage?.input_tokens, json.usage?.output_tokens, this.model);
  }
}

function finish<T>(req: GenerateRequest, content: string, tin?: number, tout?: number, model = 'model'): GenerateResult<T> {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new ProviderError('provider output is not valid JSON');
  }
  const parsed = req.schema.safeParse(value);
  if (!parsed.success) throw new ProviderError('provider output invalid');
  return {
    value: parsed.data as T,
    tokens_in: tin ?? estimateTokens(req.system + req.messages.map((m) => m.content).join('')),
    tokens_out: tout ?? estimateTokens(content),
    model,
  };
}

export function buildProvider(
  kind: string,
  cfg: { apiKey?: string; baseUrl?: string; model: string; fixture?: unknown[] },
): AiProvider {
  switch (kind) {
    case 'fake':
      return new FakeProvider({ model: cfg.model, responses: cfg.fixture ?? [] });
    case 'anthropic':
      return new AnthropicProvider({ baseUrl: cfg.baseUrl ?? 'https://api.anthropic.com/v1', apiKey: cfg.apiKey ?? '', model: cfg.model });
    case 'openai':
    case 'openai_compatible':
      return new OpenAiCompatibleProvider({ baseUrl: cfg.baseUrl ?? 'https://api.openai.com/v1', apiKey: cfg.apiKey ?? '', model: cfg.model, kind });
    default:
      throw new ProviderError(`unknown provider kind '${kind}'`);
  }
}

export { z };
