import pino, { type LoggerOptions } from 'pino';
import type { Logger } from 'pino';

/**
 * Structured logger with automatic secret masking (plan §14:
 * redact authorization/password/token/key). Never log raw API keys.
 */
type RedactConfig = Extract<NonNullable<LoggerOptions['redact']>, { paths: unknown }>;

export const LOG_REDACT: RedactConfig = {
  paths: [
    'req.headers.authorization',
    'password',
    '*.password',
    'token',
    '*.token',
    'api_key',
    '*.api_key',
    'secret',
    '*.secret',
    'key',
    '*.key',
  ],
  censor: '[REDACTED]',
};

export function loggerOptions(level: string, bindings: Record<string, string> = {}): LoggerOptions {
  return { level, base: { app: 'forgepm', ...bindings }, redact: LOG_REDACT };
}

export function createLogger(level: string, bindings: Record<string, string> = {}): Logger {
  return pino(loggerOptions(level, bindings));
}

export type { Logger };
