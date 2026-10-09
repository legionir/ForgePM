import { runRetention, recordAudit, SYSTEM_ACTOR_ID, type Db, type Logger, type RetentionResult } from '@forgepm/core';

/**
 * Nightly retention job (plan §14). Wraps the core `runRetention` pass with the
 * worker's audit emission (every mutation audited) and an interval timer.
 * `tick()` is exposed for tests; `start()/stop()` drive the schedule.
 */
export class RetentionJob {
  private timer?: NodeJS.Timeout;

  constructor(
    private db: Db,
    private log: Logger,
    private intervalMs = 24 * 60 * 60 * 1000, // nightly default
  ) {}

  get running(): boolean {
    return this.timer !== undefined;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.log.error({ err }, 'retention tick failed'));
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<RetentionResult> {
    return runRetention(this.db, async (orgId, table, count) => {
      await recordAudit(this.db, {
        organization_id: orgId,
        actor_type: 'system',
        actor_id: SYSTEM_ACTOR_ID,
        action: 'system.retention',
        resource_type: 'retention',
        resource_id: orgId,
        summary: { table, deleted: count },
      });
      this.log.info({ orgId, table, deleted: count }, 'retention pruned rows');
    });
  }
}
