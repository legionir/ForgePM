import type { AiProvider, GenerateRequest, GenerateResult } from '../ai/provider';

/**
 * Deterministic fake provider FOR TESTS + offline default (plan §10: review
 * runs execute with a `fake` provider). Lives in core so the worker and test
 * suites can install it via setReviewProviderResolver without importing the
 * api app. `producer(req)` returns the raw fixture object for each stage call.
 */
export class StubProvider implements AiProvider {
  readonly kind = 'fake';
  readonly model: string;
  calls = 0;
  requests: GenerateRequest[] = [];

  constructor(private producer: (req: GenerateRequest) => unknown, model = 'stub-1') {
    this.model = model;
  }

  async generateStructured<T>(req: GenerateRequest): Promise<GenerateResult<T>> {
    this.calls++;
    this.requests.push(req);
    const raw = this.producer(req);
    const parsed = req.schema.safeParse(typeof raw === 'string' ? JSON.parse(raw) : raw);
    if (!parsed.success) throw new Error(`stub output invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    return { value: parsed.data as T, tokens_in: 10, tokens_out: 20, model: this.model };
  }

  async ping(): Promise<boolean> {
    return true;
  }
}
