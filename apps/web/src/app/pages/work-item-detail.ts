import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { UiButton } from '../ui/button';
import { UiPage } from '../ui/page';
import { UiBreadcrumbs } from '../ui/breadcrumbs';
import { UiControl, UiField } from '../ui/field';
import { UiTabItem, UiTabs } from '../ui/tabs';
import { UiBadge } from '../ui/badge';
import { UiAvatar } from '../ui/avatar';
import { UiIcon } from '../ui/icon';
import { UiMarkdown } from '../ui/markdown';
import { stateVariant } from './work-items';
import { statusMeta } from '../ui/logic';
import { ProjectContext } from '../project-context';
import { UiToastService } from '../ui/toast';

interface ItemDto {
  id: string;
  key: string;
  title: string;
  state_id: string;
  state_name: string;
  state_category: string;
  description: string | null;
  type: string;
  priority: string;
  assignee_user_id: string | null;
  assignee_agent_id: string | null;
  due_date: string | null;
  milestone_id: string | null;
  acceptance_criteria: { text: string; done: boolean }[];
  labels: string[];
  exec_task_id?: string | null;
}
interface CommentDto {
  id: string;
  author_type: string;
  kind: string;
  body: string;
  created_at: string;
}
interface LinkDto {
  kind: string;
  external_id: string;
  url: string;
  metadata?: { number?: number; state?: string } | null;
}

interface RelationDto {
  id: string;
  type: 'blocks' | 'relates_to' | 'duplicates';
  direction: 'outgoing' | 'incoming';
  other_key: string;
  other_title: string;
  created_at: string;
}

interface ActivityDto {
  action: string;
  actor_type: string;
  created_at: string;
}
interface MilestoneDto {
  id: string;
  name: string;
  status: string;
  progress: number;
}

/**
 * Work item detail (§6 + parity phase 2, plan §10 P6-4/P6-5): main column
 * with tabs (Conversation / Development / Acceptance / Activity — the
 * Development tab lists linked PRs, external links and relations via
 * GET /development + GET /relations) and a GitHub-style
 * sidebar (state transition, priority, labels, due date, milestone,
 * assignee display). All edits go through PATCH /work-items/:key; state
 * changes keep using POST /transition (§6 rule).
 */
@Component({
  selector: 'page-work-item-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, UiButton, UiPage, UiBreadcrumbs, UiTabs, UiBadge, UiAvatar, UiIcon, UiMarkdown, UiField, UiControl],
  template: `
    @if (item(); as it) {
      <ui-page data-testid="wi-detail" [title]="it.key + ' — ' + it.title">
        <ui-breadcrumbs [items]="[{ label: i18n.instant('nav.projects'), link: '/projects' }, { label: i18n.instant('nav.work_items'), link: '/work-items' }, { label: it.key }]" />
        <a routerLink="/work-items" class="ui-back" data-testid="wi-back"><ui-icon name="arrow-left" [size]="14" /> {{ i18n.instant('common.back') }}</a>


        <div class="ui-detail">
          <div class="ui-detail-main">
            <p class="ui-detail-meta">
              <ui-badge size="sm" icon="list" [label]="it.type" variant="default" />
              <ui-badge size="sm" [status]="it.priority" />
              <ui-badge size="sm" [variant]="stateVariant(it.state_category)" [icon]="stateIcon(it.state_category)" [status]="it.state_name" />
              @if (it.labels.length) {
                <span class="ui-chip-row">
                  @for (label of it.labels; track label) {
                    <span class="ui-chip">{{ label }}</span>
                  }
                </span>
              }
            </p>
            @if (it.description) {
              <ui-markdown class="ui-detail-desc" [text]="it.description" />
            }

            <ui-tabs [items]="tabs" [active]="tab()" [ariaLabel]="i18n.instant('work_items.view')" (tabChange)="tab.set($event)" />

            @if (tab() === 'conversation') {
              <ul data-testid="wi-comments" class="ui-list ui-comments">
                @for (c of comments(); track c.id) {
                  <li>
                    <ui-avatar [name]="c.author_type" size="sm" />
                    <span class="ui-comment-body"><ui-markdown [text]="c.body" /></span>
                  </li>
                } @empty {
                  <li data-testid="wi-comments-empty">{{ i18n.instant('common.empty') }}</li>
                }
              </ul>
              <form class="ui-new" (ngSubmit)="addComment()">
                <ui-field [label]="i18n.instant('work_items.comment')" required>
                  <input uiControl name="cm" [(ngModel)]="comment" required data-testid="wi-comment-input" />
                </ui-field>
                <button type="submit" ui-button variant="primary" [loading]="busy()" data-testid="wi-comment-add">{{ i18n.instant('work_items.add_comment') }}</button>
              </form>
            } @else if (tab() === 'links') {
              <div data-testid="wi-links">
                <h3 class="ui-links-head">{{ i18n.instant('work_items.prs') }}</h3>
                @if (prs().length) {
                  <ul class="ui-list ui-links" data-testid="wi-prs">
                    @for (l of prs(); track l.external_id) {
                      <li>
                        <ui-icon name="git-pr" [size]="14" />
                        <a class="ui-link" [href]="l.url" target="_blank" rel="noopener">#{{ prNumber(l) }}</a>
                        @if (prState(l)) {
                          <ui-badge size="sm" [status]="prState(l)" />
                        }
                      </li>
                    }
                  </ul>
                } @else {
                  <p class="ui-dt-empty" data-testid="wi-prs-empty">{{ i18n.instant('work_items.links_empty') }}</p>
                }

                <h3 class="ui-links-head">{{ i18n.instant('work_items.all_links') }}</h3>
                @if (otherLinks().length) {
                  <ul class="ui-list ui-links" data-testid="wi-ext-links">
                    @for (l of otherLinks(); track l.kind + l.external_id) {
                      <li>
                        <ui-badge size="sm" icon="link" [label]="l.kind" variant="default" />
                        <a class="ui-link" [href]="l.url" target="_blank" rel="noopener">{{ l.external_id }}</a>
                      </li>
                    }
                  </ul>
                } @else {
                  <p class="ui-dt-empty">{{ i18n.instant('work_items.links_empty') }}</p>
                }

                <h3 class="ui-links-head">{{ i18n.instant('work_items.relations') }}</h3>
                @if (relations().length) {
                  <ul class="ui-list ui-links" data-testid="wi-relations">
                    @for (r of relations(); track r.id) {
                      <li>
                        <ui-badge size="sm" [variant]="r.type === 'blocks' ? 'error' : 'default'" [icon]="r.type === 'blocks' ? 'x-circle' : 'link'" [label]="r.type" />
                        <span class="ui-dt-empty">{{ r.direction === 'outgoing' ? '→' : '←' }}</span>
                        <a class="ui-link" [routerLink]="['/work-items', r.other_key]">{{ r.other_key }}</a>
                        <span class="ui-dt-empty">{{ r.other_title }}</span>
                      </li>
                    }
                  </ul>
                } @else {
                  <p class="ui-dt-empty" data-testid="wi-relations-empty">{{ i18n.instant('work_items.relations_empty') }}</p>
                }
              </div>
            } @else if (tab() === 'acceptance') {
              <ul data-testid="wi-ac" class="ui-list ui-ac-list">
                @for (c of item()!.acceptance_criteria; track c.text; let i = $index) {
                  <li>
                    <button
                      type="button"
                      class="ui-ac-toggle"
                      [class.done]="c.done"
                      [attr.aria-pressed]="c.done"
                      [attr.aria-label]="c.text"
                      (click)="toggleAc(i)"
                      data-testid="wi-ac-toggle"
                    >
                      <ui-icon [name]="c.done ? 'check-square' : 'square'" [size]="16" /> {{ c.text }}
                    </button>
                  </li>
                } @empty {
                  <li data-testid="wi-ac-empty">{{ i18n.instant('common.empty') }}</li>
                }
              </ul>
            } @else {
              <ul data-testid="wi-activity" class="ui-list ui-activity">
                @for (a of activity(); track $index) {
                  <li><span class="ui-activity-action">{{ a.action }}</span> ({{ a.actor_type }})</li>
                } @empty {
                  <li data-testid="wi-activity-empty">{{ i18n.instant('common.empty') }}</li>
                }
              </ul>
            }
          </div>

          <!-- Execution control (PE-12 L.4c) -->
          @if (execTaskCode()) {
            <section class="ui-exec-control" data-testid="wi-exec-control">
              <h3 data-testid="wi-exec-title">{{ i18n.instant('exec.execution_control') }}</h3>
              <p data-testid="wi-exec-gate" [class.ui-exec-blocked]="execGateOk() === false">
                {{ i18n.instant('exec.gate_status') }}: {{ execGateOk() === null ? '—' : execGateOk() ? i18n.instant('exec.gate_ok') : i18n.instant('exec.gate_blocked') }}
                @if (execBlockedBy().length) {
                  <span data-testid="wi-exec-blocked-by">{{ execBlockedBy().join('; ') }}</span>
                }
              </p>
              <ul data-testid="wi-exec-events">
                @for (ev of execEvents(); track ev.created_at) {
                  <li data-testid="wi-exec-event">{{ ev.action }} ({{ ev.actor_type }})</li>
                } @empty {
                  <li data-testid="wi-exec-events-empty">{{ i18n.instant('common.empty') }}</li>
                }
              </ul>
            </section>
          }

          <aside class="ui-detail-side" data-testid="wi-sidebar">
            <form (ngSubmit)="move()" data-testid="wi-move">
              <ui-field [label]="i18n.instant('work_items.transition')">
                <select uiControl name="to" [(ngModel)]="toState" data-testid="wi-move-select">
                  @for (st of states(); track st.id) {
                    <option [value]="st.id">{{ st.name }}</option>
                  }
                </select>
              </ui-field>
              <button type="submit" ui-button variant="primary" size="sm" [loading]="busy()" [disabled]="isDoneDisabled()" [attr.title]="doneTooltip()" data-testid="wi-move-submit">{{ i18n.instant('common.save') }}</button>
              @if (isDoneDisabled()) {
                <p class="ui-exec-tooltip" data-testid="wi-done-tooltip">{{ doneTooltip() }}</p>
              }
            </form>

            <ui-field [label]="i18n.instant('work_items.priority')">
              <select uiControl name="prio" [ngModel]="item()!.priority" (ngModelChange)="patchField({ priority: $event })" data-testid="wi-side-priority">
                @for (p of priorities; track p) {
                  <option [value]="p">{{ p }}</option>
                }
              </select>
            </ui-field>

            <ui-field [label]="i18n.instant('work_items.labels')" hint="{{ i18n.instant('work_items.labels_hint') }}">
              <input uiControl name="labels" [value]="labelsText" (change)="saveLabels($event)" data-testid="wi-side-labels" />
            </ui-field>

            <ui-field [label]="i18n.instant('work_items.due_date')">
              <input uiControl name="due" type="date" [value]="item()!.due_date ?? ''" (change)="patchField({ due_date: dueValue($event) })" data-testid="wi-side-due" />
            </ui-field>

            <ui-field [label]="i18n.instant('milestones.title')">
              <select uiControl name="ms" [ngModel]="item()!.milestone_id ?? ''" (ngModelChange)="patchField({ milestone_id: $event || null })" data-testid="wi-side-milestone">
                <option value="">—</option>
                @for (m of milestones(); track m.id) {
                  <option [value]="m.id">{{ m.name }}</option>
                }
              </select>
            </ui-field>

            <div class="ui-side-row">
              <span class="ui-field-label">{{ i18n.instant('work_items.assignee') }}</span>
              @if (it.assignee_user_id || it.assignee_agent_id) {
                <span class="ui-side-assignee" data-testid="wi-side-assignee">
                  <ui-avatar [name]="it.assignee_user_id ?? it.assignee_agent_id!" size="sm" />
                  <span>{{ (it.assignee_user_id ?? it.assignee_agent_id!).slice(0, 8) }}</span>
                </span>
              } @else {
                <span class="ui-side-assignee" data-testid="wi-side-assignee">—</span>
              }
            </div>
          </aside>
        </div>
      </ui-page>
    } @else {
      <p data-testid="wi-detail-loading">…</p>
    }
  `,
})
export class WorkItemDetailPage implements OnInit {
  private readonly toast = inject(UiToastService);
  private readonly api = inject(ApiClient);
  private readonly ctx = inject(ProjectContext);
  readonly i18n = inject(I18n);

  readonly item = signal<ItemDto | null>(null);
  readonly states = signal<{ id: string; name: string; category?: string }[]>([]);
  readonly comments = signal<CommentDto[]>([]);
  readonly activity = signal<ActivityDto[]>([]);
  readonly milestones = signal<MilestoneDto[]>([]);
  readonly execTaskCode = signal<string | null>(null);
  readonly execGateOk = signal<boolean | null>(null);
  readonly execBlockedBy = signal<string[]>([]);
  readonly execEvents = signal<{ action: string; actor_type: string; created_at: string }[]>([]);
  readonly busy = signal(false);
  readonly tab = signal('conversation');
  comment = '';
  toState = '';
  labelsText = '';
  readonly priorities = ['none', 'low', 'medium', 'high', 'urgent'];
  readonly stateVariant = stateVariant;
  readonly stateIcon = (category: string): string => statusMeta(category).icon;

  get tabs(): UiTabItem[] {
    return [
      { id: 'conversation', label: this.i18n.instant('work_items.tab_conversation') },
      { id: 'links', label: this.i18n.instant('work_items.tab_links') },
      { id: 'acceptance', label: this.i18n.instant('work_items.tab_acceptance') },
      { id: 'activity', label: this.i18n.instant('work_items.tab_activity') },
    ];
  }

  readonly links = signal<LinkDto[]>([]);
  readonly relations = signal<RelationDto[]>([]);

  readonly prs = () => this.links().filter((l) => l.kind === 'pr');
  readonly otherLinks = () => this.links().filter((l) => l.kind !== 'pr');
  prNumber(l: LinkDto): string {
    return String(l.metadata?.number ?? l.external_id);
  }
  prState(l: LinkDto): string {
    return l.metadata?.state ?? '';
  }

  async ngOnInit(): Promise<void> {
    const key = location.pathname.split('/').pop() ?? '';
    try {
      await this.ctx.load();
      const pid = this.ctx.selectedId();
      if (pid) {
        const [st, ms] = await Promise.all([
          this.api.get<{ items: { id: string; name: string }[] }>(`/api/v1/projects/${pid}/states`),
          this.api.get<{ items: MilestoneDto[] }>(`/api/v1/projects/${pid}/milestones`).catch(() => ({ items: [] as MilestoneDto[] })),
        ]);
        this.states.set(st.items);
        this.milestones.set(ms.items);
      }
      await this.reload(key);
    } catch (err) {
      this.toast.error((err as Error).message);
    }
  }

  async reload(key: string): Promise<void> {
    const it = await this.api.get<ItemDto>(`/api/v1/work-items/${key}`);
    this.item.set(it);
    this.labelsText = it.labels.join(', ');
    this.toState = it.state_id;
    const [cm, act, dev, rel] = await Promise.all([
      this.api.get<{ items: CommentDto[] }>(`/api/v1/work-items/${key}/comments`),
      this.api.get<{ items: ActivityDto[] }>(`/api/v1/work-items/${key}/activity`),
      this.api.get<{ items: LinkDto[] }>(`/api/v1/work-items/${key}/development`).catch(() => ({ items: [] as LinkDto[] })),
      this.api.get<{ items: RelationDto[] }>(`/api/v1/work-items/${key}/relations`).catch(() => ({ items: [] as RelationDto[] })),
    ]);
    this.comments.set(cm.items);
    this.activity.set(act.items);
    this.links.set(dev.items);
    this.relations.set(rel.items);
    // Load exec gate if linked
    if (it.exec_task_id) {
      try {
        const exec = await this.api.get<{ task: { code: string }; gate?: { ok: boolean; blocked_by: { needed: string }[] }; events?: { action: string; actor_type: string; created_at: string }[] }>(`/api/v1/exec/status?task_ref=${it.exec_task_id}`);
        this.execTaskCode.set(exec.task.code);
        this.execGateOk.set(exec.gate ? exec.gate.ok : null);
        this.execBlockedBy.set(exec.gate?.blocked_by?.map(b => b.needed) ?? []);
        this.execEvents.set(exec.events ?? []);
      } catch { /* no exec */ }
    } else {
      this.execTaskCode.set(null);
      this.execGateOk.set(null);
      this.execBlockedBy.set([]);
      this.execEvents.set([]);
    }
  }

  isDoneDisabled(): boolean {
    if (this.execGateOk() === false) {
      const target = this.states().find(s => s.id === this.toState);
      if (target && (target.category === 'completed' || target.name.toLowerCase().includes('done'))) return true;
    }
    return false;
  }

  doneTooltip(): string {
    if (this.isDoneDisabled()) {
      const reasons = this.execBlockedBy().join('; ') || this.i18n.instant('exec.gate_blocked');
      return `${this.i18n.instant('exec.done_disabled')}: ${reasons}`;
    }
    return '';
  }

  /** Generic sidebar PATCH (priority/labels/due/milestone) — P6-4. */
  async patchField(fields: Partial<ItemDto>): Promise<void> {
    const key = this.item()?.key;
    if (!key) return;
    this.busy.set(true);
    try {
      await this.api.patch(`/api/v1/work-items/${key}`, fields);
      await this.reload(key);
    } catch (err) {
      this.toast.error((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  saveLabels(ev: Event): void {
    const text = (ev.target as HTMLInputElement).value;
    const labels = text.split(',').map((l) => l.trim()).filter(Boolean);
    void this.patchField({ labels });
  }

  dueValue(ev: Event): string | null {
    return (ev.target as HTMLInputElement).value || null;
  }

  /** Acceptance checkbox toggle — immutable array + PATCH (§5/FRM-006 rule). */
  toggleAc(index: number): void {
    const it = this.item();
    if (!it) return;
    const ac = it.acceptance_criteria.map((c, i) => (i === index ? { ...c, done: !c.done } : c));
    void this.patchField({ acceptance_criteria: ac });
  }

  async addComment(): Promise<void> {
    const key = this.item()?.key;
    if (!key) return;
    this.busy.set(true);
    try {
      await this.api.post(`/api/v1/work-items/${key}/comments`, { body: this.comment });
      this.comment = '';
      await this.reload(key);
    } catch (err) {
      this.toast.error((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  async move(): Promise<void> {
    const key = this.item()?.key;
    if (!key || !this.toState) return;
    this.busy.set(true);
    try {
      await this.api.post(`/api/v1/work-items/${key}/transition`, { to_state_id: this.toState });
      await this.reload(key);
    } catch (err) {
      this.toast.error((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
