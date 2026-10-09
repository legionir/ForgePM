import { describe, it, expect, vi } from 'vitest';
import { loggerOptions, LOG_REDACT } from './logging';
import { QUEUES, OUTBOX_DISPATCH_JOB, type QueueName } from './queue/queues';
import { withOrg, scopedDb } from './db/scoped';

describe('logging (plan §14 masking)', () => {
  it('redacts credential-ish keys', () => {
    expect(LOG_REDACT.censor).toBe('[REDACTED]');
    expect(LOG_REDACT.paths).toContain('req.headers.authorization');
    const opts = loggerOptions('info', { component: 'api' });
    expect(opts.level).toBe('info');
    expect(opts.base).toMatchObject({ app: 'forgepm', component: 'api' });
  });
});

describe('queue constants', () => {
  it('exposes the logical queue names', () => {
    const names: QueueName[] = [QUEUES.default, QUEUES.review];
    expect(names).toEqual(['forgepm.default', 'forgepm.review']);
    expect(OUTBOX_DISPATCH_JOB).toBe('outbox.dispatch');
  });
});

describe('withOrg', () => {
  it('forces the organization filter onto the query', () => {
    const where = vi.fn();
    const query = { where } as never;
    const scoped = scopedDb({} as never, { organizationId: 'org-9', requestId: 'r-9' });
    withOrg(scoped, query as { where: (c: string, o: string, v: unknown) => never });
    expect(where).toHaveBeenCalledWith('organization_id', '=', 'org-9');
  });
});
