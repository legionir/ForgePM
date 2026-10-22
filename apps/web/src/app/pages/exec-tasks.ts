import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { UiButton } from '../ui/button';
import { UiPage } from '../ui/page';
import { UiField, UiControl } from '../ui/field';
import { UiDataTable, UiTableColumn } from '../ui/data-table';
import { ProjectContext } from '../project-context';
import { UiToastService } from '../ui/toast';

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

@Component({
  selector: 'page-exec-tasks',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, UiButton, UiPage, UiField, UiControl, UiDataTable],
  styles: [`.ui-row--blocked{border-inline-start:4px solid var(--color-error)} .ui-row--awaiting{border-inline-start:4px solid var(--color-warning)}`],
  template: `
    <ui-page data-testid="exec-tasks" [title]="i18n.instant('exec.title')">

      <!-- Plan tree table -->
      <div class="ui-exec-toolbar">
        <span data-testid="exec-task-count">{{ i18n.instant('exec.task_count') }}: {{ taskCount() }}</span>
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

      <!-- Drawer for selected task -->
      @if (selectedCode()) {
        <section class="ui-drawer" data-testid="exec-drawer">
          <header class="ui-drawer-head">
            <h2 data-testid="exec-drawer-title">{{ selectedCode() }} · {{ statusDetail()?.task?.title ?? '' }}</h2>
            <button type="button" ui-button variant="ghost" size="sm" (click)="closeDrawer()" data-testid="exec-drawer-close">{{ i18n.instant('common.cancel') }}</button>
          </header>

          <!-- Criteria + evidence -->
          <h3 data-testid="exec-criteria-title">{{ i18n.instant('exec.criteria') }}</h3>
          <ul data-testid="exec-criteria-list">
            @for (c of statusDetail()?.criteria ?? []; track c.code) {
              <li data-testid="exec-criterion-row">
                <span>{{ c.code }}: {{ c.text }} [{{ c.status }}]</span>
                @if (c.req_code) { <span data-testid="exec-criterion-req">{{ c.req_code }}</span> }
                <ul>
                  @for (e of evidenceFor(c.code); track e.ref) {
                    <li data-testid="exec-evidence-row">{{ e.kind }} {{ e.ref }} {{ e.summary }} @if (e.provenance) { <span data-testid="exec-evidence-provenance">{{ e.provenance }}</span> }</li>
                  }
                </ul>
              </li>
            }
          </ul>

          <!-- Open items -->
          <h3 data-testid="exec-open-items-title">{{ i18n.instant('exec.open_items') }}</h3>
          <ul data-testid="exec-open-items">
            @for (it of statusDetail()?.items ?? []; track it.code) {
              <li data-testid="exec-open-item-row">{{ it.code }} {{ it.title }} [{{ it.status }}]</li>
            }
          </ul>

          <!-- Decisions -->
          <h3 data-testid="exec-decisions-title">{{ i18n.instant('exec.decisions') }}</h3>
          <ul data-testid="exec-decisions">
            @for (d of statusDetail()?.decisions ?? []; track d.code) {
              <li data-testid="exec-decision-row">{{ d.code }} {{ d.title }} {{ d.approval_state }}</li>
            }
          </ul>

          <!-- Questions -->
          <h3 data-testid="exec-questions-title">{{ i18n.instant('exec.questions') }}</h3>
          <ul data-testid="exec-questions">
            @for (q of statusDetail()?.questions ?? []; track q.code) {
              <li data-testid="exec-question-row">{{ q.code }} {{ q.question }} [{{ q.status }}]</li>
            }
          </ul>

          <!-- Reviews -->
          <h3 data-testid="exec-reviews-title">{{ i18n.instant('exec.reviews') }}</h3>
          <ul data-testid="exec-reviews">
            @for (r of statusDetail()?.reviews ?? []; track r.round) {
              <li data-testid="exec-review-row">round {{ r.round }} {{ r.verdict }}</li>
            }
          </ul>

          <!-- Journal -->
          <h3 data-testid="exec-journal-title">{{ i18n.instant('exec.journal') }}</h3>
          <ul data-testid="exec-journal">
            @for (j of statusDetail()?.journal ?? []; track j.code) {
              <li data-testid="exec-journal-row">{{ j.code }} {{ j.action }} [{{ j.status }}]</li>
            }
          </ul>

          <!-- REQs -->
          <h3 data-testid="exec-reqs-title">{{ i18n.instant('exec.requirements') }}</h3>
          <ul data-testid="exec-reqs">
            @for (r of statusDetail()?.requirements ?? []; track r.code) {
              <li data-testid="exec-req-row">{{ r.code }} {{ r.text }}</li>
            }
          </ul>

          <!-- Dry-run Gate -->
          <section data-testid="exec-gate-section">
            <button type="button" ui-button variant="primary" size="sm" (click)="dryRun()" [loading]="gateLoading()" data-testid="exec-dry-run">{{ i18n.instant('exec.dry_run') }}</button>
            @if (gateResult()) {
              <div data-testid="exec-gate-result">
                <span data-testid="exec-gate-ok">{{ gateResult()!.ok ? 'ok' : 'blocked' }}</span>
                <ul data-testid="exec-blocked-by">
                  @for (b of gateResult()!.blocked_by; track b.ref) {
                    <li data-testid="exec-blocked-row">{{ b.rule }} {{ b.ref }} {{ b.title }} → {{ b.tool_to_call }}</li>
                  }
                </ul>
              </div>
            }
          </section>

          <!-- Human unlock forms — each calls exact human REST endpoint with preview -->
          <section data-testid="exec-unlock-forms">
            <h3>{{ i18n.instant('exec.unlock') }}</h3>

            <!-- resolve -->
            <form (ngSubmit)="resolveItem()" data-testid="exec-resolve-form">
              <ui-field [label]="i18n.instant('exec.resolve')"><input uiControl name="rcode" [(ngModel)]="formResolve.code" required data-testid="exec-resolve-code" /></ui-field>
              <ui-field [label]="i18n.instant('common.title')"><select uiControl name="rstatus" [(ngModel)]="formResolve.status" data-testid="exec-resolve-status"><option value="resolved">resolved</option><option value="accepted">accepted</option><option value="deferred">deferred</option><option value="wont_fix">wont_fix</option><option value="not_applicable">not_applicable</option></select></ui-field>
              <ui-field [label]="i18n.instant('exec.reason')" required><textarea uiControl name="rnote" [(ngModel)]="formResolve.note" required data-testid="exec-resolve-note"></textarea></ui-field>
              <div data-testid="exec-resolve-preview">{{ preview(formResolve) }}</div>
              <button type="submit" ui-button variant="primary" size="sm" [disabled]="!formResolve.note.trim()" data-testid="exec-resolve-submit">{{ i18n.instant('exec.resolve') }}</button>
            </form>

            <!-- answer Q -->
            <form (ngSubmit)="answerQuestion()" data-testid="exec-answer-form">
              <ui-field [label]="i18n.instant('exec.answer')"><input uiControl name="qcode" [(ngModel)]="formAnswer.code" required data-testid="exec-answer-code" /></ui-field>
              <ui-field [label]="i18n.instant('exec.answer')"><input uiControl name="ans" [(ngModel)]="formAnswer.answer" required data-testid="exec-answer-input" /></ui-field>
              <div data-testid="exec-answer-preview">{{ preview(formAnswer) }}</div>
              <button type="submit" ui-button variant="primary" size="sm" [disabled]="!formAnswer.answer.trim()" data-testid="exec-answer-submit">{{ i18n.instant('exec.answer') }}</button>
            </form>

            <!-- approve/reject D -->
            <form (ngSubmit)="decideDecision()" data-testid="exec-decide-form">
              <ui-field [label]="'D code'"><input uiControl name="dcode" [(ngModel)]="formDecide.code" required data-testid="exec-decide-code" /></ui-field>
              <ui-field [label]="i18n.instant('exec.reason')"><input uiControl name="dreason" [(ngModel)]="formDecide.reason" required data-testid="exec-decide-reason" /></ui-field>
              <div data-testid="exec-decide-preview">{{ preview(formDecide) }}</div>
              <button type="button" ui-button variant="primary" size="sm" (click)="decideDecision('approved')" [disabled]="!formDecide.reason.trim()" data-testid="exec-decide-approve">{{ i18n.instant('approvals.approve') }}</button>
              <button type="button" ui-button variant="destructive" size="sm" (click)="decideDecision('rejected')" [disabled]="!formDecide.reason.trim()" data-testid="exec-decide-reject">{{ i18n.instant('approvals.reject') }}</button>
            </form>

            <!-- waive C -->
            <form (ngSubmit)="waiveCriterion()" data-testid="exec-waive-form">
              <ui-field [label]="'C code'"><input uiControl name="wcode" [(ngModel)]="formWaive.code" required data-testid="exec-waive-code" /></ui-field>
              <ui-field [label]="i18n.instant('exec.reason')"><input uiControl name="wreason" [(ngModel)]="formWaive.reason" required data-testid="exec-waive-reason" /></ui-field>
              <div data-testid="exec-waive-preview">{{ preview(formWaive) }}</div>
              <button type="submit" ui-button variant="primary" size="sm" [disabled]="!formWaive.reason.trim()" data-testid="exec-waive-submit">{{ i18n.instant('exec.waive') }}</button>
            </form>

            <!-- drop REQ -->
            <form (ngSubmit)="dropRequirement()" data-testid="exec-drop-form">
              <ui-field [label]="'REQ code'"><input uiControl name="dropcode" [(ngModel)]="formDrop.code" required data-testid="exec-drop-code" /></ui-field>
              <ui-field [label]="i18n.instant('exec.reason')"><input uiControl name="dropreason" [(ngModel)]="formDrop.reason" required data-testid="exec-drop-reason" /></ui-field>
              <div data-testid="exec-drop-preview">{{ preview(formDrop) }}</div>
              <button type="submit" ui-button variant="destructive" size="sm" [disabled]="!formDrop.reason.trim()" data-testid="exec-drop-submit">{{ i18n.instant('exec.drop_req') }}</button>
            </form>

            <!-- approve-scope -->
            <form (ngSubmit)="approveScope()" data-testid="exec-scope-form">
              <ui-field [label]="'paths'"><input uiControl name="spaths" [(ngModel)]="formScope.paths" required data-testid="exec-scope-paths" /></ui-field>
              <ui-field [label]="i18n.instant('exec.reason')"><input uiControl name="sreason" [(ngModel)]="formScope.reason" required data-testid="exec-scope-reason" /></ui-field>
              <div data-testid="exec-scope-preview">{{ preview(formScope) }}</div>
              <button type="submit" ui-button variant="primary" size="sm" [disabled]="!formScope.reason.trim()" data-testid="exec-scope-submit">{{ i18n.instant('exec.approve_scope') }}</button>
            </form>

            <!-- fact promote -->
            <form (ngSubmit)="promoteFact()" data-testid="exec-promote-form">
              <ui-field [label]="'F code'"><input uiControl name="fcode" [(ngModel)]="formPromote.code" required data-testid="exec-promote-code" /></ui-field>
              <ui-field [label]="'source'"><input uiControl name="fsrc" [(ngModel)]="formPromote.source" required data-testid="exec-promote-source" /></ui-field>
              <ui-field [label]="'source_ref'"><input uiControl name="fsref" [(ngModel)]="formPromote.source_ref" required data-testid="exec-promote-ref" /></ui-field>
              <ui-field [label]="i18n.instant('exec.reason')"><input uiControl name="freason" [(ngModel)]="formPromote.reason" required data-testid="exec-promote-reason" /></ui-field>
              <div data-testid="exec-promote-preview">{{ preview(formPromote) }}</div>
              <button type="submit" ui-button variant="primary" size="sm" [disabled]="!formPromote.reason.trim()" data-testid="exec-promote-submit">{{ i18n.instant('exec.promote_fact') }}</button>
            </form>
          </section>
        </section>
      }
    </ui-page>
  `,
})
export class ExecTasksPage implements OnInit {
  private readonly toast = inject(UiToastService);
  private readonly api = inject(ApiClient);
  readonly i18n = inject(I18n);
  private readonly ctx = inject(ProjectContext);
  private readonly route = inject(ActivatedRoute);

  readonly loading = signal(false);
  readonly gateLoading = signal(false);
  readonly roots = signal<PlanNode[]>([]);
  readonly taskCount = signal(0);
  readonly nextCursor = signal<string | null>(null);
  readonly selectedCode = signal<string | null>(null);
  readonly statusDetail = signal<ExecStatusDto | null>(null);
  readonly gateResult = signal<{ ok: boolean; blocked_by: { rule: number; ref: string; title: string; tool_to_call: string }[] } | null>(null);

  formResolve = { code: '', status: 'resolved' as const, note: '' };
  formAnswer = { code: '', answer: '' };
  formDecide = { code: '', decision: '' as 'approved'|'rejected', reason: '' };
  formWaive = { code: '', reason: '' };
  formDrop = { code: '', reason: '' };
  formScope = { paths: '', reason: '' };
  formPromote = { code: '', source: 'human', source_ref: '', reason: '' };

  preview(obj: unknown): string {
    try { return JSON.stringify(obj); } catch { return ''; }
  }

  get columns(): UiTableColumn<FlatRow>[] {
    return [
      { key: 'code', label: this.i18n.instant('exec.code'), sortable: true, link: (r) => ['/exec-tasks', r.code], linkTestid: 'exec-task-link' },
      { key: 'title', label: this.i18n.instant('common.title'), sortable: true },
      { key: 'status', label: this.i18n.instant('exec.status'), sortable: true, badge: (r) => ({ text: r.status, variant: r.status === 'blocked' ? 'error' as const : r.status === 'awaiting_human' ? 'warning' as const : 'default' as const }) },
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
    return (this.statusDetail()?.evidence ?? []).filter(e => e.criterion_code === criterionCode);
  }

  async ngOnInit(): Promise<void> {
    await this.ctx.ensureLoaded();
    const code = this.route.snapshot.paramMap.get('code');
    if (code) await this.openDrawer(code);
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
      this.roots.update(r => [...r, ...res.roots]);
      this.nextCursor.set(res.next_cursor);
    } catch (e) { this.toast.error((e as Error).message); }
    finally { this.loading.set(false); }
  }

  async openDrawer(code: string): Promise<void> {
    this.selectedCode.set(code);
    try {
      const pid = this.ctx.selectedId();
      const qs = pid ? `?project_ref=${pid}&task_ref=${code}` : `?task_ref=${code}`;
      const detail = await this.api.get<ExecStatusDto>(`/api/v1/exec/status${qs}`);
      this.statusDetail.set(detail);
    } catch (e) { this.toast.error((e as Error).message); }
  }

  closeDrawer(): void {
    this.selectedCode.set(null);
    this.statusDetail.set(null);
    this.gateResult.set(null);
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

  async resolveItem(): Promise<void> {
    if (!this.formResolve.note.trim()) return;
    try {
      await this.api.post(`/api/v1/exec/items/${this.formResolve.code}/resolve`, { status: this.formResolve.status, note: this.formResolve.note });
      await this.openDrawer(this.selectedCode()!);
    } catch (e) { this.toast.error((e as Error).message); }
  }

  async answerQuestion(): Promise<void> {
    if (!this.formAnswer.answer.trim()) return;
    try {
      await this.api.post(`/api/v1/exec/questions/${this.formAnswer.code}/answer`, { answer: this.formAnswer.answer });
      await this.openDrawer(this.selectedCode()!);
    } catch (e) { this.toast.error((e as Error).message); }
  }

  async decideDecision(decision?: 'approved'|'rejected'): Promise<void> {
    const dec = decision ?? (this.formDecide.decision as 'approved'|'rejected');
    if (!this.formDecide.reason.trim()) return;
    try {
      await this.api.post(`/api/v1/exec/decisions/${this.formDecide.code}/decide`, { decision: dec, reason: this.formDecide.reason });
      await this.openDrawer(this.selectedCode()!);
    } catch (e) { this.toast.error((e as Error).message); }
  }

  async waiveCriterion(): Promise<void> {
    if (!this.formWaive.reason.trim()) return;
    try {
      await this.api.post(`/api/v1/exec/criteria/${this.formWaive.code}/waive`, { reason: this.formWaive.reason });
      await this.openDrawer(this.selectedCode()!);
    } catch (e) { this.toast.error((e as Error).message); }
  }

  async dropRequirement(): Promise<void> {
    if (!this.formDrop.reason.trim()) return;
    try {
      await this.api.post(`/api/v1/exec/requirements/${this.formDrop.code}/drop`, { reason: this.formDrop.reason });
      await this.openDrawer(this.selectedCode()!);
    } catch (e) { this.toast.error((e as Error).message); }
  }

  async approveScope(): Promise<void> {
    if (!this.formScope.reason.trim()) return;
    const paths = this.formScope.paths.split(',').map(s => s.trim()).filter(Boolean);
    const task = this.selectedCode();
    if (!task || !paths.length) return;
    try {
      await this.api.post(`/api/v1/exec/scope/${task}/expand`, { paths, reason: this.formScope.reason });
      await this.openDrawer(task);
    } catch (e) { this.toast.error((e as Error).message); }
  }

  async promoteFact(): Promise<void> {
    if (!this.formPromote.reason.trim()) return;
    try {
      await this.api.post(`/api/v1/exec/facts/${this.formPromote.code}/promote`, { source: this.formPromote.source, source_ref: this.formPromote.source_ref, reason: this.formPromote.reason });
      await this.openDrawer(this.selectedCode()!);
    } catch (e) { this.toast.error((e as Error).message); }
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
