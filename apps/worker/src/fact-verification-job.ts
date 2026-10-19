import { sql } from 'kysely';
import {
  SYSTEM_ACTOR_ID,
  applyFactVerification,
  prepareFactVerification,
  recordAudit,
  unitOfWork,
  type Db,
  type ExecFactFileSource,
  type Logger,
} from '@forgepm/core';

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

/** Periodically re-hash active fact sources on the worker's read-only repository mount. */
export class FactVerificationJob {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private inFlight?: Promise<unknown>;

  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    private readonly source: ExecFactFileSource,
    private readonly intervalMs = DEFAULT_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.runPeriodicTick(), this.intervalMs);
    this.runPeriodicTick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight?.catch(() => undefined);
  }

  private runPeriodicTick(): void {
    if (this.inFlight) return;
    const run = this.tick();
    this.inFlight = run;
    void run
      .catch((err) => this.log.error({ err }, 'fact verification tick failed'))
      .finally(() => {
        if (this.inFlight === run) this.inFlight = undefined;
      });
  }

  async tick(): Promise<{ projects_checked: number; facts_checked: number; facts_stale: number }> {
    if (this.busy) return { projects_checked: 0, facts_checked: 0, facts_stale: 0 };
    this.busy = true;
    let factsChecked = 0;
    let factsStale = 0;
    let projectsChecked = 0;
    try {
      const projects = await sql<{ organization_id: string; project_id: string }>`
        SELECT DISTINCT organization_id::text AS organization_id, project_id::text AS project_id
        FROM exec_facts
        WHERE status = 'active'
        ORDER BY organization_id, project_id
      `.execute(this.db as never);
      projectsChecked = projects.rows.length;
      for (const project of projects.rows) {
        const actor = {
          organizationId: project.organization_id,
          projectId: project.project_id,
          actorType: 'system' as const,
          actorId: SYSTEM_ACTOR_ID,
          tool: 'exec.verify_facts',
        };
        try {
          const prepared = await prepareFactVerification(this.db, actor, this.source);
          let projectFactsChecked = 0;
          let projectFactsStale = 0;
          await unitOfWork(this.db, async ({ tx }) => {
            const result = await applyFactVerification(tx, actor, prepared);
            projectFactsChecked = result.checked;
            for (const change of result.changes) {
              if (change.from !== 'active' || change.to !== 'stale') continue;
              projectFactsStale += 1;
              await recordAudit(tx, {
                organization_id: project.organization_id,
                actor_type: 'system',
                actor_id: SYSTEM_ACTOR_ID,
                action: 'exec.fact.stale',
                resource_type: 'exec_fact',
                resource_id: change.id,
                summary: {
                  code: change.code,
                  changed_files: change.changed_files,
                  warning: change.warning,
                  trigger: 'exec.verify_facts',
                },
              });
            }
          });
          factsChecked += projectFactsChecked;
          factsStale += projectFactsStale;
        } catch (err) {
          this.log.error({ err, projectId: project.project_id }, 'could not verify project facts');
        }
      }
      return { projects_checked: projectsChecked, facts_checked: factsChecked, facts_stale: factsStale };
    } finally {
      this.busy = false;
    }
  }
}
