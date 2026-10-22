import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { devNull } from '../../../../src/modules/exec/review-source';

describe('git null device', () => {
  it('null device per platform: NUL on win32, /dev/null elsewhere', () => {
    expect(devNull).toBe(process.platform === 'win32' ? 'NUL' : '/dev/null');
  });

  it('git accepts it as GIT_CONFIG_GLOBAL and core.hooksPath', () => {
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_COUNT: '0' };
    const out = execFileSync('git', ['-c', `core.hooksPath=${devNull}`, '--version'], { env, encoding: 'utf8' });
    expect(out).toMatch(/^git version/);
  });
});
