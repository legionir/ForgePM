import { createDb, rotateDbSecrets } from '@forgepm/core';

/**
 * scripts/rotate-secret.ts — FORGEPM_SECRET_KEY rotation (plan §14, RUNBOOK).
 *
 * Usage:
 *   tsx scripts/rotate-secret.ts --old <base64-or-env:VAR> --new <base64-or-env:VAR>
 *     [--new-version <int, default 2>] [--dry]
 *
 * Re-encrypts every `secrets.ciphertext` + `ai_providers.encrypted_key` row
 * from the OLD key to the NEW key, tagging rows with the new key_version.
 * Idempotent: already-current rows are skipped. Real secrets never print.
 */
function decodeKey(spec: string): Buffer {
  const raw = spec.startsWith('env:') ? process.env[spec.slice(4)] ?? '' : spec;
  if (!raw) throw new Error(`empty key value for "${spec}"`);
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('key must be 32 bytes, base64-encoded');
  return buf;
}

function parse(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      if (key === 'dry') out.dry = '1';
      else out[key] = argv[++i] ?? '';
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  if (!args.old || !args.new) {
    process.stderr.write('usage: rotate-secret.ts --old <base64|env:VAR> --new <base64|env:VAR> [--new-version 2] [--dry]\n');
    process.exit(2);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    process.stderr.write('rotate-secret: DATABASE_URL is required\n');
    process.exit(1);
  }
  const db = createDb(url);
  try {
    const oldKey = decodeKey(args.old);
    const newKey = decodeKey(args.new);
    const newVersion = Number(args['new-version'] ?? '2');
    if (Buffer.compare(oldKey, newKey) === 0) {
      process.stderr.write('rotate-secret: old and new keys are identical; nothing to do\n');
      process.exit(0);
    }
    if (args.dry) {
      process.stdout.write(`rotate-secret: dry-run would re-encrypt rows to key_version=${newVersion}\n`);
      return;
    }
    const res = await rotateDbSecrets(db, oldKey, newKey, newVersion);
    process.stdout.write(
      `rotate-secret: re-encrypted ${res.secrets} secret(s), ${res.ai_providers} provider key(s); skipped ${res.skipped}\n`,
    );
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});
