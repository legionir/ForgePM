import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isBlockedPrivateHostAll } from '../../app/ssrf';

const MAX_CI_RESPONSE_BYTES = 1_048_576;
const CI_TIMEOUT_MS = 8_000;

const ciEnvelopeSchema = z.strictObject({
  sha: z.string().regex(/^[0-9a-f]{40,64}$/i),
  run_id: z.string().min(1).max(200),
  job: z.string().min(1).max(200),
  provider: z.string().min(1).max(100).optional(),
  log: z.string().min(1).max(MAX_CI_RESPONSE_BYTES),
});

export interface CiLogSnapshot {
  provider: string;
  run_id: string;
  job: string;
  sha: string;
  log: string;
  sha256_log: string;
}

export type CiLogReadResult =
  | { ok: true; snapshot: CiLogSnapshot }
  | { ok: false; reason: string };

/**
 * Read a CI log through an administrator-configured, SHA-addressed endpoint.
 * The endpoint must return a JSON envelope (sha, run_id, job, log), so a log
 * for a different commit can never be passed off as the requested baseline.
 * Redirects are refused and response size/time are bounded.
 */
export async function readCiLog(input: {
  endpoint: string;
  sha: string;
  secret: string;
  allowPrivateTargets?: boolean;
  fetcher?: typeof fetch;
  privateHostGuard?: typeof isBlockedPrivateHostAll;
}): Promise<CiLogReadResult> {
  const sha = input.sha.trim().toLowerCase();
  if (!/^[0-9a-f]{40,64}$/.test(sha)) return { ok: false, reason: 'CI commit SHA is invalid' };
  if (!input.endpoint.trim()) return { ok: false, reason: 'exec.ci_log_endpoint is not configured' };
  if (!input.secret.trim()) return { ok: false, reason: 'read-only CI log secret is not configured' };
  if (hasInvalidHeaderCharacter(input.secret)) return { ok: false, reason: 'CI log secret contains invalid header characters' };

  let url: URL;
  try {
    const hasShaToken = input.endpoint.includes('{sha}');
    const expanded = hasShaToken ? input.endpoint.replaceAll('{sha}', encodeURIComponent(sha)) : input.endpoint;
    url = new URL(expanded);
    if (!hasShaToken) url.searchParams.set('sha', sha);
  } catch {
    return { ok: false, reason: 'exec.ci_log_endpoint is not a valid URL template' };
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    return { ok: false, reason: 'CI endpoint must be HTTPS without userinfo or a fragment' };
  }

  const guardHost = input.privateHostGuard ?? isBlockedPrivateHostAll;
  try {
    if (await guardHost(url.toString(), input.allowPrivateTargets ?? false)) {
      return { ok: false, reason: 'CI endpoint is blocked by the SSRF policy' };
    }
  } catch {
    return { ok: false, reason: 'CI endpoint could not be validated by the SSRF policy' };
  }

  let response: Response;
  try {
    response = await (input.fetcher ?? fetch)(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(CI_TIMEOUT_MS),
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${input.secret}`,
      },
    });
  } catch {
    return { ok: false, reason: 'CI log request failed or timed out' };
  }
  if (!response.ok) return { ok: false, reason: `CI log endpoint returned HTTP ${response.status}` };
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') return { ok: false, reason: 'CI endpoint did not return a JSON log envelope' };

  let body: string;
  try {
    body = await readBoundedBody(response, MAX_CI_RESPONSE_BYTES);
  } catch {
    return { ok: false, reason: 'CI log response exceeded the safe size limit or could not be read' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { ok: false, reason: 'CI endpoint returned invalid JSON' };
  }
  const parsed = ciEnvelopeSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'CI response is missing sha, run_id, job or log' };
  const envelope = parsed.data;
  if (envelope.sha.toLowerCase() !== sha) {
    return { ok: false, reason: 'CI log SHA does not match the requested commit SHA' };
  }
  const snapshot: CiLogSnapshot = {
    provider: envelope.provider ?? 'generic',
    run_id: envelope.run_id,
    job: envelope.job,
    sha,
    log: envelope.log,
    sha256_log: createHash('sha256').update(envelope.log, 'utf8').digest('hex'),
  };
  return { ok: true, snapshot };
}

function hasInvalidHeaderCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) throw new Error('empty response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error('response too large');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('invalid UTF-8');
  return text;
}
