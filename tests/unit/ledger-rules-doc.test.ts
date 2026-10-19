import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const RULES = readFileSync(join(ROOT, 'docs/LEDGER_RULES.md'), 'utf8');

function section(title: string): string {
  const start = RULES.indexOf(`## ${title}`);
  if (start < 0) return '';
  const next = RULES.indexOf('\n## ', start + 1);
  return RULES.slice(start, next < 0 ? undefined : next);
}

describe('execution-control agent rules (PE-6 D.1/D.2)', () => {
  it('keeps the agent rules at or below 80 lines', () => {
    expect(RULES.trimEnd().split(/\r?\n/).length).toBeLessThanOrEqual(80);
  });

  it('maps every trigger bullet to an implemented ledger/exec/fact tool', () => {
    const triggers = section('محرک‌ها')
      .split(/\r?\n/)
      .filter((line) => line.startsWith('- '));
    expect(triggers.length).toBeGreaterThan(0);
    for (const line of triggers) {
      expect(line, `missing trigger → tool mapping: ${line}`).toMatch(/→\s+`(?:exec|ledger|fact)_[a-z_]+`/);
    }
  });

  it('states exactly four non-negotiable prohibitions and gives each a reason', () => {
    const bans = section('ممنوع')
      .split(/\r?\n/)
      .filter((line) => line.startsWith('- ممنوع:'));
    expect(bans).toHaveLength(4);
    expect(bans.every((line) => line.includes('چون'))).toBe(true);
    expect(bans.join('\n')).toContain('سطح ریسک را خودت تعیین یا جعل نکن');
    expect(bans.join('\n')).toContain('تصمیم `approval` را پیش از تأیید انسان اعمال نکن');
    expect(bans.join('\n')).toContain('blocker را نرم نبند');
    expect(bans.join('\n')).toContain('وقتی ابزار Ledger در دسترس نیست ادامه نده و جایگزین نساز');
  });
});
