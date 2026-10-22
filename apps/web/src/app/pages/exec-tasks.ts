import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { UiButton } from '../ui/button';
import { UiPage } from '../ui/page';
import { UiField, UiControl } from '../ui/field';
import { UiDataTable, UiTableColumn } from '../ui/data-table';
import { ProjectContext } from '../project-context';
import { UiToastService } from '../ui/toast';
import { UiBadge } from '../ui/badge';
import { UiIcon } from '../ui/icon';
import { UiModal } from '../ui/modal';
import { CamelPipe } from '../ui/camel';
import { statusMeta } from '../ui/logic';

interface PlanNode {
  id: string;
  code: string;
  title: string;
  status: string;
  display_status: string;
  parent_id: string | null;
  blocked_on: { kind: string; ref: string | null; reason: string | null; unblock_condition: string | null } | null;
  depends_on: { id: string; code: string; status: string }[];
  declared_req_ids: string[];
  criteria: { code: string; req_code: string | null; status: string }[];
  children: PlanNode[];
  canceled_by_human?: boolean;
}

interface ExecStatusDto {
  task: { code: string; title: string; status: string; allowed_paths: string[] };
  criteria: { code: string; text: string; status: string; req_code: string | null }[];
  evidence: { criterion_code: string; kind: string; ref: string; summary: string; provenance?: string }[];
  items: { code: string; title: string; type: string; status: string; blocks_completion: boolean; detail?: string }[];
  questions: { code: string; question: string; status: string; blocking: boolean; options: string[] }[];
  decisions: { code: string; title: string; status: string; approval_state: string; risk_level?: string }[];
  reviews: { round: number; verdict: string; findings: unknown[] }[];
  journal: { code: string; action: string; status: string; target?: string }[];
  requirements: { code: string; text: string; status: string }[];
  gate?: { ok: boolean; blocked_by: { rule: number; ref: string; title: string; needed: string; tool_to_call: string }[] };
  events?: { action: string; actor_type: string; created_at: string }[];
}

/** API minimums for the human endpoints: resolve notes need 20 characters, every other reason 10. */
export const MIN_NOTE = 20;
export const MIN_REASON = 10;
export const RESOLVE_STATUSES = ['resolved', 'accepted', 'deferred', 'wont_fix', 'not_applicable'] as const;
export const FACT_SOURCES = ['human', 'code', 'docs', 'tool_output'] as const;

const ACTIVE_ITEM = new Set(['open', 'blocked', 'awaiting_human']);

/**
 * Execution tasks: the plan tree, and one task's ledger detail in a modal. The modal follows the route
 * (`/exec-tasks/:code` opens it, closing returns to `/exec-tasks`), so a link, the back button and a click
 * on another task all show the right details. The human unlock forms use selects for every enum and for
 * every code the task already lists, so a typo cannot reach the API.
 */
@Component({
  selector: 'page-exec-tasks',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiBadge, FormsModule, UiButton, UiPage, UiField, UiControl, UiDataTable, UiIcon, UiModal, CamelPipe],
  styles: [`.ui-row--blocked{border-inline-start:4px solid var(--color-error)} .ui-row--awaiting{border-inline-start:4px solid var(--color-warning)}`],
  template: `
    <ui-page data-testid="exec-tasks" [title]="i18n.instant('exec.title')">
      <div class="ui-card-head">
        <div class="ui-card-title">
          <h2><ui-icon name="check-square" [size]="18" [inline]="false" /> {{ i18n.instant('exec.tasks') }}</h2>
          <ui-badge size="sm" data-testid="exec-task-count">{{ taskCount() }}</ui-badge>
        </div>
        @if (nextCursor()) {
          <button type="button" ui-button variant="secondary" size="sm" (click)="loadMore()" [disabled]="loading()" data-testid="exec-next-page">{{ i18n.instant('table.next') }}</button>
        }
      </div>

      <ui-data-table
        testid="exec-tasks-list"
        emptyTestid="exec-tasks-empty"
        [columns]="columns"
        [rows]="flatRows()"
        [trackKey]="keyOf"
        [loading]="loading()"
        [emptyMessage]="i18n.instant('common.empty')"
        [rowTestid]="rowTestid"
        [rowClass]="rowClass"
      />

      <ui-modal [open]="!!selectedCode()" (openChange)="$event || closeDrawer()" size="lg" icon="check-square" [title]="modalTitle()" data-testid="exec-drawer">
        <section class="ui-detail-section">
          <h3 data-testid="exec-criteria-title"><ui-icon name="check-circle" [size]="14" [inline]="false" /> {{ i18n.instant('exec.criteria') }}
            <ui-badge size="sm">{{ detail()?.criteria?.length ?? 0 }}</ui-badge></h3>
          <ul data-testid="exec-criteria-list">
            @for (c of detail()?.criteria ?? []; track c.code) {
              <li data-testid="exec-criterion-row">
                <span>{{ c.code }}: {{ c.text }} <ui-badge size="sm" [status]="c.status" /></span>
                @if (c.req_code) { <ui-badge size="sm" icon="flag" [label]="c.req_code" data-testid="exec-criterion-req" /> }
                <ul>
                  @for (e of evidenceFor(c.code); track e.ref) {
                    <li data-testid="exec-evidence-row">{{ e.kind }} {{ e.ref }} {{ e.summary }} @if (e.provenance) { <span data-testid="exec-evidence-provenance">{{ e.provenance }}</span> }</li>
                  }
                </ul>
              </li>
            }
          </ul>
        </section>

        <section class="ui-detail-section">
          <h3 data-testid="exec-open-items-title"><ui-icon name="alert" [size]="14" [inline]="false" /> {{ i18n.instant('exec.open_items') }}
            <ui-badge size="sm">{{ detail()?.items?.length ?? 0 }}</ui-badge></h3>
          <ul data-testid="exec-open-items">
            @for (it of detail()?.items ?? []; track it.code) {
              <li data-testid="exec-open-item-row">{{ it.code }} {{ it.title }} <ui-badge size="sm" [status]="it.status" /></li>
            }
          </ul>
        </section>

        <section class="ui-detail-section">
          <h3 data-testid="exec-decisions-title"><ui-icon name="shield" [size]="14" [inline]="false" /> {{ i18n.instant('exec.decisions') }}
            <ui-badge size="sm">{{ detail()?.decisions?.length ?? 0 }}</ui-badge></h3>
          <ul data-testid="exec-decisions">
            @for (d of detail()?.decisions ?? []; track d.code) {
              <li data-testid="exec-decision-row">{{ d.code }} {{ d.title }} <ui-badge size="sm" [status]="d.approval_state" /></li>
            }
          </ul>
        </section>

        <section class="ui-detail-section">
          <h3 data-testid="exec-questions-title"><ui-icon name="help-circle" [size]="14" [inline]="false" /> {{ i18n.instant('exec.questions') }}
            <ui-badge size="sm">{{ detail()?.questions?.length ?? 0 }}</ui-badge></h3>
          <ul data-testid="exec-questions">
            @for (q of detail()?.questions ?? []; track q.code) {
              <li data-testid="exec-question-row">{{ q.code }} {{ q.question }} <ui-badge size="sm" [status]="q.status" /></li>
            }
          </ul>
        </section>

        <section class="ui-detail-section">
          <h3 data-testid="exec-reviews-title"><ui-icon name="eye" [size]="14" [inline]="false" /> {{ i18n.instant('exec.reviews') }}
            <ui-badge size="sm">{{ detail()?.reviews?.length ?? 0 }}</ui-badge></h3>
          <ul data-testid="exec-reviews">
            @for (r of detail()?.reviews ?? []; track r.round) {
              <li data-testid="exec-review-row">round {{ r.round }} <ui-badge size="sm" [status]="r.verdict" /></li>
            }
          </ul>
        </section>

        <section class="ui-detail-section">
          <h3 data-testid="exec-journal-title"><ui-icon name="activity" [size]="14" [inline]="false" /> {{ i18n.instant('exec.journal') }}
            <ui-badge size="sm">{{ detail()?.journal?.length ?? 0 }}</ui-badge></h3>
          <ul data-testid="exec-journal">
            @for (j of detail()?.journal ?? []; track j.code) {
              <li data-testid="exec-journal-row">{{ j.code }} {{ j.action }} <ui-badge size="sm" [status]="j.status" /></li>
            }
          </ul>
        </section>

        <section class="ui-detail-section">
          <h3 data-testid="exec-reqs-title"><ui-icon name="flag" [size]="14" [inline]="false" /> {{ i18n.instant('exec.requirements') }}
            <ui-badge size="sm">{{ detail()?.requirements?.length ?? 0 }}</ui-badge></h3>
          <ul data-testid="exec-reqs">
            @for (r of detail()?.requirements ?? []; track r.code) {
              <li data-testid="exec-req-row">{{ r.code }} {{ r.text }} <ui-badge size="sm" [status]="r.status" /></li>
            }
          </ul>
        </section>

        <section class="ui-detail-section" data-testid="exec-gate-section">
          <div>
            <button type="button" ui-button variant="primary" size="sm" (click)="dryRun()" [loading]="gateLoading()" data-testid="exec-dry-run">{{ i18n.instant('exec.dry_run') }}</button>
          </div>
          @if (gateResult(); as g) {
            <div data-testid="exec-gate-result">
              <ui-badge size="sm" [status]="g.ok ? 'approved' : 'blocked'" [label]="g.ok ? 'ok' : 'blocked'" data-testid="exec-gate-ok" />
              <ul data-testid="exec-blocked-by">
                @for (b of g.blocked_by; track b.ref) {
                  <li data-testid="exec-blocked-row">{{ b.rule }} {{ b.ref }} {{ b.title }} → {{ b.tool_to_call }}</li>
                }
              </ul>
            </div>
          }
        </section>

        <section class="ui-detail-section" data-testid="exec-unlock-forms">
          <h3><ui-icon name="lock" [size]="14" [inline]="false" /> {{ i18n.instant('exec.unlock') }}</h3>

          <form class="ui-unlock-form" (ngSubmit)="resolveItem()" data-testid="exec-resolve-form">
            <ui-field [label]="i18n.instant('exec.open_items')">
              <select uiControl name="rcode" [(ngModel)]="formResolve.code" required data-testid="exec-resolve-code">
                <option value="">{{ i18n.instant('exec.pick') }}</option>
                @for (it of activeItems(); track it.code) { <option [value]="it.code">{{ it.code }} — {{ it.title }}</option> }
              </select>
            </ui-field>
            <ui-field [label]="i18n.instant('exec.status')">
              <select uiControl name="rstatus" [(ngModel)]="formResolve.status" data-testid="exec-resolve-status">
                @for (s of resolveStatuses; track s) { <option [value]="s">{{ s | camel }}</option> }
              </select>
            </ui-field>
            <ui-field [label]="i18n.instant('exec.reason')" required [hint]="minHint(formResolve.note, minNote)">
              <textarea uiControl name="rnote" [(ngModel)]="formResolve.note" required rows="2" data-testid="exec-resolve-note"></textarea>
            </ui-field>
            <button type="submit" ui-button variant="primary" size="sm" [disabled]="!formResolve.code || formResolve.note.trim().length < minNote" data-testid="exec-resolve-submit">{{ i18n.instant('exec.resolve') }}</button>
          </form>

          <form class="ui-unlock-form" (ngSubmit)="answerQuestion()" data-testid="exec-answer-form">
            <ui-field [label]="i18n.instant('exec.questions')">
              <select uiControl name="qcode" [(ngModel)]="formAnswer.code" required data-testid="exec-answer-code">
                <option value="">{{ i18n.instant('exec.pick') }}</option>
                @for (q of openQuestions(); track q.code) { <option [value]="q.code">{{ q.code }} — {{ q.question }}</option> }
              </select>
            </ui-field>
            <ui-field [label]="i18n.instant('exec.answer')" required>
              <input uiControl name="ans" [(ngModel)]="formAnswer.answer" required data-testid="exec-answer-input" />
            </ui-field>
            <button type="submit" ui-button variant="primary" size="sm" [disabled]="!formAnswer.code || !formAnswer.answer.trim()" data-testid="exec-answer-submit">{{ i18n.instant('exec.answer') }}</button>
          </form>

          <form class="ui-unlock-form" (ngSubmit)="decideDecision('approved')" data-testid="exec-decide-form">
            <ui-field [label]="i18n.instant('exec.decisions')">
              <select uiControl name="dcode" [(ngModel)]="formDecide.code" required data-testid="exec-decide-code">
                <option value="">{{ i18n.instant('exec.pick') }}</option>
                @for (d of pendingDecisions(); track d.code) { <option [value]="d.code">{{ d.code }} — {{ d.title }}</option> }
              </select>
            </ui-field>
            <ui-field [label]="i18n.instant('exec.reason')" required>
              <input uiControl name="dreason" [(ngModel)]="formDecide.reason" required data-testid="exec-decide-reason" />
            </ui-field>
            <button type="button" ui-button variant="primary" size="sm" (click)="decideDecision('approved')" [disabled]="!formDecide.code || !formDecide.reason.trim()" data-testid="exec-decide-approve">{{ i18n.instant('exec.approve') }}</button>
            <button type="button" ui-button variant="destructive" size="sm" (click)="decideDecision('rejected')" [disabled]="!formDecide.code || !formDecide.reason.trim()" data-testid="exec-decide-reject">{{ i18n.instant('exec.reject') }}</button>
          </form>

          <form class="ui-unlock-form" (ngSubmit)="waiveCriterion()" data-testid="exec-waive-form">
            <ui-field [label]="i18n.instant('exec.criteria')">
              <select uiControl name="wcode" [(ngModel)]="formWaive.code" required data-testid="exec-waive-code">
                <option value="">{{ i18n.instant('exec.pick') }}</option>
                @for (c of waivableCriteria(); track c.code) { <option [value]="c.code">{{ c.code }} — {{ c.text }}</option> }
              </select>
            </ui-field>
            <ui-field [label]="i18n.instant('exec.reason')" required [hint]="minHint(formWaive.reason, minReason)">
              <input uiControl name="wreason" [(ngModel)]="formWaive.reason" required data-testid="exec-waive-reason" />
            </ui-field>
            <button type="submit" ui-button variant="primary" size="sm" [disabled]="!formWaive.code || formWaive.reason.trim().length < minReason" data-testid="exec-waive-submit">{{ i18n.instant('exec.waive') }}</button>
          </form>

          <form class="ui-unlock-form" (ngSubmit)="dropRequirement()" data-testid="exec-drop-form">
            <ui-field [label]="i18n.instant('exec.requirements')">
              <select uiControl name="dropcode" [(ngModel)]="formDrop.code" required data-testid="exec-drop-code">
                <option value="">{{ i18n.instant('exec.pick') }}</option>
                @for (r of droppableRequirements(); track r.code) { <option [value]="r.code">{{ r.code }} — {{ r.text }}</option> }
              </select>
            </ui-field>
            <ui-field [label]="i18n.instant('exec.reason')" required [hint]="minHint(formDrop.reason, minReason)">
              <input uiControl name="dropreason" [(ngModel)]="formDrop.reason" required data-testid="exec-drop-reason" />
            </ui-field>
            <button type="submit" ui-button variant="destructive" size="sm" [disabled]="!formDrop.code || formDrop.reason.trim().length < minReason" data-testid="exec-drop-submit">{{ i18n.instant('exec.drop_req') }}</button>
          </form>

          <form class="ui-unlock-form" (ngSubmit)="approveScope()" data-testid="exec-scope-form">
            <ui-field [label]="i18n.instant('exec.paths')" [hint]="i18n.instant('exec.paths_hint')">
              <input uiControl name="spaths" [(ngModel)]="formScope.paths" required placeholder="apps/web/src/**, docs/**" data-testid="exec-scope-paths" />
            </ui-field>
            <ui-field [label]="i18n.instant('exec.reason')" required [hint]="minHint(formScope.reason, minReason)">
              <input uiControl name="sreason" [(ngModel)]="formScope.reason" required data-testid="exec-scope-reason" />
            </ui-field>
            <button type="submit" ui-button variant="primary" size="sm" [disabled]="!formScope.paths.trim() || formScope.reason.trim().length < minReason" data-testid="exec-scope-submit">{{ i18n.instant('exec.approve_scope') }}</button>
          </form>

          <form class="ui-unlock-form" (ngSubmit)="promoteFact()" data-testid="exec-promote-form">
            <ui-field [label]="i18n.instant('exec.fact_code')">
              <input uiControl name="fcode" [(ngModel)]="formPromote.code" required placeholder="F-001" data-testid="exec-promote-code" />
            </ui-field>
            <ui-field [label]="i18n.instant('exec.fact_source')">
              <select uiControl name="fsrc" [(ngModel)]="formPromote.source" data-testid="exec-promote-source">
                @for (s of factSources; track s) { <option [value]="s">{{ s | camel }}</option> }
              </select>
            </ui-field>
            <ui-field [label]="i18n.instant('exec.fact_source_ref')">
              <input uiControl name="fsref" [(ngModel)]="formPromote.source_ref" required data-testid="exec-promote-ref" />
            </ui-field>
            <ui-field [label]="i18n.instant('exec.reason')" required [hint]="minHint(formPromote.reason, minReason)">
              <input uiControl name="freason" [(ngModel)]="formPromote.reason" required data-testid="exec-promote-reason" />
            </ui-field>
            <button type="submit" ui-button variant="primary" size="sm" [disabled]="!formPromote.code.trim() || !formPromote.source_ref.trim() || formPromote.reason.trim().length < minReason" data-testid="exec-promote-submit">{{ i18n.instant('exec.promote_fact') }}</button>
          </form>
        </section>
      </ui-modal>
    </ui-page>
  `,
})
export class ExecTasksPage implements OnInit {
  private readonly toast = inject(UiToastService);
  private readonly api = inject(ApiClient);
  readonly i18n = inject(I18n);
  private readonly ctx = inject(ProjectContext);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly minNote = MIN_NOTE;
  readonly minReason = MIN_REASON;
  readonly resolveStatuses = RESOLVE_STATUSES;
  readonly factSources = FACT_SOURCES;

  readonly loading = signal(false);
  readonly gateLoading = signal(false);
  readonly roots = signal<PlanNode[]>([]);
  readonly taskCount = signal(0);
  readonly nextCursor = signal<string | null>(null);
  readonly selectedCode = signal<string | null>(null);
  readonly detail = signal<ExecStatusDto | null>(null);
  readonly gateResult = signal<{ ok: boolean; blocked_by: { rule: number; ref: string; title: string; tool_to_call: string }[] } | null>(null);

  readonly modalTitle = computed(() => {
    const code = this.selectedCode();
    const title = this.detail()?.task?.title ?? '';
    return title ? `${code} · ${title}` : (code ?? '');
  });
  readonly activeItems = computed(() => (this.detail()?.items ?? []).filter((i) => ACTIVE_ITEM.has(i.status)));
  readonly openQuestions = computed(() => (this.detail()?.questions ?? []).filter((q) => q.status === 'open'));
  readonly pendingDecisions = computed(() => (this.detail()?.decisions ?? []).filter((d) => d.approval_state === 'pending'));
  readonly waivableCriteria = computed(() => (this.detail()?.criteria ?? []).filter((c) => c.status !== 'verified' && c.status !== 'waived'));
  readonly droppableRequirements = computed(() => (this.detail()?.requirements ?? []).filter((r) => r.status !== 'dropped'));

  formResolve = { code: '', status: 'resolved' as string, note: '' };
  formAnswer = { code: '', answer: '' };
  formDecide = { code: '', reason: '' };
  formWaive = { code: '', reason: '' };
  formDrop = { code: '', reason: '' };
  formScope = { paths: '', reason: '' };
  formPromote = { code: '', source: 'human' as string, source_ref: '', reason: '' };

  /** "7/10" style hint while a reason is shorter than the API minimum; empty once it is long enough. */
  minHint(text: string, min: number): string {
    const n = text.trim().length;
    return n >= min ? '' : this.i18n.instant('exec.min_chars', { n: String(n), min: String(min) });
  }

  get columns(): UiTableColumn<FlatRow>[] {
    return [
      { key: 'code', label: this.i18n.instant('exec.code'), sortable: true, link: (r) => ['/exec-tasks', r.code], linkTestid: 'exec-task-link' },
      { key: 'title', label: this.i18n.instant('common.title'), sortable: true },
      { key: 'status', label: this.i18n.instant('exec.status'), sortable: true, badge: (r) => ({ text: r.status, variant: statusMeta(r.status).variant }) },
      { key: 'open_items', label: this.i18n.instant('exec.open_items'), value: (r) => String(r.open_items ?? 0) },
      { key: 'blocked_on', label: this.i18n.instant('exec.blocked_on'), value: (r) => r.blocked_on ?? '—' },
      { key: 'unblock', label: this.i18n.instant('exec.unblock_condition'), value: (r) => r.unblock_condition ?? '—' },
      { key: 'gate', label: this.i18n.instant('exec.gate_summary'), value: (r) => r.gate_summary ?? '—' },
    ];
  }

  keyOf = (r: FlatRow) => r.code;
  rowTestid = () => 'exec-task-row';
  rowClass = (r: FlatRow) => r.status === 'blocked' ? 'ui-row--blocked' : r.status === 'awaiting_human' ? 'ui-row--awaiting' : '';

  flatRows = computed(() => flatten(this.roots()));

  evidenceFor(criterionCode: string): ExecStatusDto['evidence'] {
    return (this.detail()?.evidence ?? []).filter((e) => e.criterion_code === criterionCode);
  }

  async ngOnInit(): Promise<void> {
    await this.ctx.ensureLoaded();
    // The route parameter is the source of truth: a link, the back button and a click on another
    // task all arrive here, including when Angular reuses this component for the next code.
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const code = params.get('code');
      if (code) void this.openDrawer(code);
      else this.resetDetail();
    });
    await this.load();
  }

  async load(): Promise<void> {
    const pid = this.ctx.selectedId();
    if (!pid) return;
    this.loading.set(true);
    try {
      const res = await this.api.get<{ roots: PlanNode[]; task_count: number; next_cursor: string | null }>(`/api/v1/exec/plan?project_ref=${pid}`);
      this.roots.set(res.roots);
      this.taskCount.set(res.task_count);
      this.nextCursor.set(res.next_cursor);
    } catch (e) {
      this.toast.error((e as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  async loadMore(): Promise<void> {
    const pid = this.ctx.selectedId();
    const cur = this.nextCursor();
    if (!pid || !cur) return;
    this.loading.set(true);
    try {
      const res = await this.api.get<{ roots: PlanNode[]; next_cursor: string | null }>(`/api/v1/exec/plan?project_ref=${pid}&cursor=${cur}`);
      this.roots.update((r) => [...r, ...res.roots]);
      this.nextCursor.set(res.next_cursor);
    } catch (e) { this.toast.error((e as Error).message); }
    finally { this.loading.set(false); }
  }

  async openDrawer(code: string): Promise<void> {
    this.selectedCode.set(code);
    this.detail.set(null);
    this.gateResult.set(null);
    try {
      const pid = this.ctx.selectedId();
      const qs = pid ? `?project_ref=${pid}&task_ref=${code}` : `?task_ref=${code}`;
      const detail = await this.api.get<ExecStatusDto>(`/api/v1/exec/status${qs}`);
      if (this.selectedCode() === code) this.detail.set(detail); // a newer click wins over a slow answer
    } catch (e) { this.toast.error((e as Error).message); }
  }

  private resetDetail(): void {
    this.selectedCode.set(null);
    this.detail.set(null);
    this.gateResult.set(null);
  }

  /** Closing is navigation: the URL goes back to the list, and the route subscription clears the detail. */
  closeDrawer(): void {
    void this.router.navigate(['/exec-tasks']);
  }

  async dryRun(): Promise<void> {
    const code = this.selectedCode();
    if (!code) return;
    this.gateLoading.set(true);
    try {
      const res = await this.api.post<{ ok: boolean; blocked_by: { rule: number; ref: string; title: string; tool_to_call: string }[] }>(`/api/v1/exec/gate/${code}`, {});
      this.gateResult.set(res);
    } catch (e) { this.toast.error((e as Error).message); }
    finally { this.gateLoading.set(false); }
  }

  private async submit(path: string, body: Record<string, unknown>, reset: () => void): Promise<void> {
    const code = this.selectedCode();
    if (!code) return;
    try {
      await this.api.post(path, body);
      reset();
      this.toast.ok(this.i18n.instant('common.saved'));
      await this.openDrawer(code);
    } catch (e) { this.toast.error((e as Error).message); }
  }

  resolveItem(): Promise<void> {
    if (!this.formResolve.code || this.formResolve.note.trim().length < MIN_NOTE) return Promise.resolve();
    return this.submit(`/api/v1/exec/items/${this.formResolve.code}/resolve`, { status: this.formResolve.status, note: this.formResolve.note.trim() }, () => (this.formResolve = { code: '', status: 'resolved', note: '' }));
  }

  answerQuestion(): Promise<void> {
    if (!this.formAnswer.code || !this.formAnswer.answer.trim()) return Promise.resolve();
    return this.submit(`/api/v1/exec/questions/${this.formAnswer.code}/answer`, { answer: this.formAnswer.answer.trim() }, () => (this.formAnswer = { code: '', answer: '' }));
  }

  decideDecision(decision: 'approved' | 'rejected'): Promise<void> {
    if (!this.formDecide.code || !this.formDecide.reason.trim()) return Promise.resolve();
    return this.submit(`/api/v1/exec/decisions/${this.formDecide.code}/decide`, { decision, reason: this.formDecide.reason.trim() }, () => (this.formDecide = { code: '', reason: '' }));
  }

  waiveCriterion(): Promise<void> {
    if (!this.formWaive.code || this.formWaive.reason.trim().length < MIN_REASON) return Promise.resolve();
    return this.submit(`/api/v1/exec/criteria/${this.formWaive.code}/waive`, { reason: this.formWaive.reason.trim() }, () => (this.formWaive = { code: '', reason: '' }));
  }

  dropRequirement(): Promise<void> {
    if (!this.formDrop.code || this.formDrop.reason.trim().length < MIN_REASON) return Promise.resolve();
    return this.submit(`/api/v1/exec/requirements/${this.formDrop.code}/drop`, { reason: this.formDrop.reason.trim() }, () => (this.formDrop = { code: '', reason: '' }));
  }

  approveScope(): Promise<void> {
    const paths = this.formScope.paths.split(',').map((s) => s.trim()).filter(Boolean);
    const task = this.selectedCode();
    if (!task || !paths.length || this.formScope.reason.trim().length < MIN_REASON) return Promise.resolve();
    return this.submit(`/api/v1/exec/scope/${task}/expand`, { paths, reason: this.formScope.reason.trim() }, () => (this.formScope = { paths: '', reason: '' }));
  }

  promoteFact(): Promise<void> {
    const f = this.formPromote;
    if (!f.code.trim() || !f.source_ref.trim() || f.reason.trim().length < MIN_REASON) return Promise.resolve();
    return this.submit(`/api/v1/exec/facts/${f.code.trim()}/promote`, { source: f.source, source_ref: f.source_ref.trim(), reason: f.reason.trim() }, () => (this.formPromote = { code: '', source: 'human', source_ref: '', reason: '' }));
  }
}

interface FlatRow {
  code: string;
  title: string;
  status: string;
  open_items: number;
  blocked_on: string | null;
  unblock_condition: string | null;
  gate_summary: string | null;
  _node: PlanNode;
}

function flatten(nodes: PlanNode[], out: FlatRow[] = [], depth = 0): FlatRow[] {
  for (const n of nodes) {
    out.push({
      code: n.code,
      title: n.title,
      status: n.display_status ?? n.status,
      open_items: 0,
      blocked_on: n.blocked_on?.ref ?? n.blocked_on?.kind ?? null,
      unblock_condition: n.blocked_on?.unblock_condition ?? null,
      gate_summary: n.blocked_on?.reason ?? null,
      _node: n,
    });
    if (n.children?.length) flatten(n.children, out, depth + 1);
  }
  return out;
}
