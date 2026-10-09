import { z } from 'zod';

/**
 * AiProvider (plan §7). generateStructured returns a JSON value validated
 * against the supplied schema; on validation failure the caller retries up to
 * 2 times with the error message appended. Implementations must never leak
 * provider keys in errors or logs.
 */
export interface GenerateRequest {
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  schema: z.ZodTypeAny;
  maxTokens?: number;
  temperature?: number;
}

export interface GenerateResult<T> {
  value: T;
  tokens_in: number;
  tokens_out: number;
  model: string;
}

export interface AiProvider {
  readonly kind: string;
  readonly model: string;
  generateStructured<T>(req: GenerateRequest): Promise<GenerateResult<T>>;
  /** Cheap connectivity/credential check used by the "test" endpoint. */
  ping?(): Promise<boolean>;
}

export class ProviderError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = retryable;
  }
}

/** Estimate tokens as ~4 chars/token (deterministic, provider-independent). */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}
