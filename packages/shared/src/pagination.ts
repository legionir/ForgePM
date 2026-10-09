import { z } from 'zod';

/** Cursor pagination contract (plan §13): default 50, max 200. */
export const PAGINATION_MAX_LIMIT = 200;

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(PAGINATION_MAX_LIMIT).default(50),
  cursor: z.string().min(1).max(512).optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export function paginatedResponseSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    next_cursor: z.string().nullable(),
  });
}

/**
 * Opaque cursor over (created_at DESC, id DESC) keyset paging.
 * Hex encoding of the UTF-8 bytes of `${created_at}|${id}` — portable
 * (no Buffer) since this package is also imported by the browser panel.
 * Clients treat it as opaque.
 */
function toHex(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function fromHex(hex: string): string {
  if (!/^([0-9a-fA-F]{2})+$/.test(hex)) throw new Error('invalid cursor');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(bytes);
}

export function encodeCursor(createdAt: string, id: string): string {
  return toHex(`${createdAt}|${id}`);
}

export function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const raw = fromHex(cursor);
  const idx = raw.indexOf('|');
  if (idx < 0) throw new Error('invalid cursor');
  return { createdAt: raw.slice(0, idx), id: raw.slice(idx + 1) };
}
