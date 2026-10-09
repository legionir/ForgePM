import { describe, it, expect, afterAll } from 'vitest';
import http from 'node:http';
import { z } from 'zod';
import { OpenAiCompatibleProvider, AnthropicProvider, FakeProvider, buildProvider } from './providers';
import { ProviderError } from './provider';

/**
 * A local mock server stands in for OpenAI/Anthropic so the HTTP provider
 * adapters are exercised end-to-end WITHOUT external network (plan §15:
 * "no test needs the internet"). Each request is answered from a queue.
 */
function startMock(responses: { status?: number; body: unknown }[]): Promise<{ url: string; close: () => Promise<void>; seen: () => { path: string; auth: string | undefined }[] }> {
  const seen: { path: string; auth: string | undefined }[] = [];
  let i = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      seen.push({ path: req.url ?? '', auth: req.headers.authorization });
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
        seen: () => seen,
      });
    });
  });
}

const schema = z.object({ answer: z.string() });

describe('OpenAI-compatible provider (plan §7)', () => {
  it('returns validated structured output + token usage', async () => {
    const mock = await startMock([{ body: { choices: [{ message: { content: JSON.stringify({ answer: 'hi' }) } }], usage: { prompt_tokens: 5, completion_tokens: 3 } } }]);
    const p = new OpenAiCompatibleProvider({ baseUrl: mock.url, apiKey: 'sk-test', model: 'gpt-x' });
    const r = await p.generateStructured({ system: 's', messages: [{ role: 'user', content: 'q' }], schema });
    expect(r.value).toEqual({ answer: 'hi' });
    expect(r.tokens_in).toBe(5);
    expect(r.tokens_out).toBe(3);
    expect(mock.seen()[0].auth).toBe('Bearer sk-test');
    await mock.close();
  });

  it('non-2xx => ProviderError (retryable on 5xx)', async () => {
    const mock = await startMock([{ status: 500, body: {} }]);
    const p = new OpenAiCompatibleProvider({ baseUrl: mock.url, apiKey: 'k', model: 'm' });
    await expect(p.generateStructured({ system: 's', messages: [], schema })).rejects.toBeInstanceOf(ProviderError);
    await mock.close();
  });

  it('invalid schema output => ProviderError', async () => {
    const mock = await startMock([{ body: { choices: [{ message: { content: '{"wrong":1}' } }] } }]);
    const p = new OpenAiCompatibleProvider({ baseUrl: mock.url, apiKey: 'k', model: 'm' });
    await expect(p.generateStructured({ system: 's', messages: [], schema })).rejects.toThrow(/invalid/);
    await mock.close();
  });
});

describe('Anthropic provider (plan §7)', () => {
  it('returns validated output from content blocks', async () => {
    const mock = await startMock([{ body: { content: [{ type: 'text', text: '{"answer":"yo"}' }], usage: { input_tokens: 2, output_tokens: 4 } } }]);
    const p = new AnthropicProvider({ baseUrl: mock.url, apiKey: 'sk-ant', model: 'claude-x' });
    const r = await p.generateStructured({ system: 's', messages: [{ role: 'user', content: 'q' }], schema });
    expect(r.value).toEqual({ answer: 'yo' });
    expect(r.tokens_in).toBe(2);
    await mock.close();
  });
});

describe('buildProvider dispatch + FakeProvider (plan §7)', () => {
  it('fake from fixture list is deterministic', async () => {
    const p = buildProvider('fake', { model: 'f', fixture: [{ answer: 'a' }, { answer: 'b' }] });
    expect((await p.generateStructured({ system: '', messages: [], schema })).value).toEqual({ answer: 'a' });
    expect((await p.generateStructured({ system: '', messages: [], schema })).value).toEqual({ answer: 'b' });
    expect(p.kind).toBe('fake');
  });
  it('fake producer function form', async () => {
    const p = new FakeProvider({ responses: () => ({ answer: 'made' }) });
    expect((await p.generateStructured({ system: '', messages: [], schema })).value).toEqual({ answer: 'made' });
    expect(await p.ping!()).toBe(true);
  });
  it('unknown kind throws', () => {
    expect(() => buildProvider('nope', { model: 'm' })).toThrow(/unknown provider kind/);
  });
  it('builds openai_compatible + anthropic adapters', () => {
    expect(buildProvider('openai_compatible', { apiKey: 'k', baseUrl: 'http://127.0.0.1:1/v1', model: 'm' }).kind).toBe('openai_compatible');
    expect(buildProvider('anthropic', { apiKey: 'k', model: 'm' }).kind).toBe('anthropic');
  });
});

afterAll(async () => {
  /* mocks closed inline per test */
});
