import { ERROR_CODES, type ErrorCode } from './error-codes';

/**
 * Domain error carried through REST, MCP and services.
 * `details` must never contain stack traces or secrets (plan §8.11).
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly httpStatus: number;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
    this.httpStatus = ERROR_CODES[code];
  }

  toJSON(requestId?: string) {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
        ...(requestId ? { request_id: requestId } : {}),
      },
    };
  }
}
