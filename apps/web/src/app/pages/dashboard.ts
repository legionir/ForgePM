import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { ProjectContext } from '../project-context';
import { UiPage } from '../ui/page';
import { UiBadge } from '../ui/badge';
import { UiIcon } from '../ui/icon';
import { UiLoading } from '../ui/loading';
import { UiButton } from '../ui/button';
import { UiBars, UiChartDatum, UiDonut, UiProgress } from '../ui/charts';
import { stateVariant, statusMeta } from '../ui/logic';
import { UiToastService } from '../ui/toast';

interface StateDto {
  id: string;
  name: string;
  category: string;
}
interface ItemDto {
  id: string;
  key: string;
  title: string;
  type: string;
  priority: string;
  state_name: string;
  state_category: string;
  due_date: string | null;
}
interface FeatureDto {
  id: string;
  key: string;
  title: string;
  lifecycle_status: string;
  work_progress: number;
  release_readiness: number;
}
interface MilestoneDto {
  id: string;
  name: string;
  target_date: string | null;
  status: string;
  progress: number;
}
interface AuditDto {
  id: string;
  actor_type: string;
  action: string;
  resource_type: string;
  created_at: string;
}

const CATEGORY_COLOR: Record<string, string> = {
  backlog: 'var(--chart-1)',
  unstarted: 'var(--chart-2)',
  started: 'var(--chart-3)',
  in_review: 'var(--chart-4)',
  completed: 'var(--chart-5)',
  canceled: 'var(--chart-6)',
};
const CATEGORY_ORDER = ['backlog', 'unstarted', 'started', 'in_review', 'completed', 'canceled'];
const PRIORITY_ORDER = ['urgent', 'high', 'medium', 'low', 'none'];
const PRIORITY_COLOR: Record<string, string> = {
  urgent: 'var(--chart-6)',
  high: 'var(--chart-4)',
  medium: 'var(--chart-3)',
  low: 'var(--chart-2)',
  none: 'var(--chart-1)',
};
const CLOSED = new Set(['completed', 'canceled']);

/**
 * Project dashboard: KPI cards, state/priority/type charts, feature and
 * milestone progress, items that need attention and the latest audit events.
 * Everything is derived client-side from the existing list endpoints, so the
 * page works with any combination of enabled modules — a failing optional
 * source only hides its own card.
 */
@Component({
  selector: 'page-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, UiPage, UiBadge, UiIcon, UiLoading, UiButton, UiDonut, UiBars, UiProgress],
  template: `
    <ui-page variant="dashboard" data-testid="dashboard" [title]="i18n.instant('dashboard.title')">
      <div pageActions class="ui-row-actions">
        <button type="button" ui-button variant="ghost" size="sm" (click)="load()" [loading]="loading()" data-testid="dash-refresh">
          <ui-icon name="activity" [size]="14" /> {{ i18n.instant('dashboard.refresh') }}
        </button>
        <a class="ui-btn ui-btn--primary ui-btn--sm" routerLink="/work-items" [queryParams]="{ new: 1 }" data-testid="dash-new-item">
          <ui-icon name="plus" [size]="14" /> {{ i18n.instant('work_items.new') }}
        </a>
      </div>

      @if (ctx.selected(); as p) {
        <p class="ui-page-sub" data-testid="dash-project">{{ p.key }} · {{ p.name }}</p>
      }

      @if (loading() && !loadedOnce()) {
        <div class="ui-kpis"><ui-loading kind="card" /><ui-loading kind="card" /><ui-loading kind="card" /><ui-loading kind="card" /></div>
      } @else {
        @if (steps().length && !allStepsDone()) {
          <section class="ui-card ui-onboard" data-testid="dash-steps">
            <header class="ui-card-head">
              <h2>{{ i18n.instant('dashboard.getting_started') }}</h2>
              <ui-badge size="sm" data-testid="dash-steps-count">{{ doneSteps() }}/{{ steps().length }}</ui-badge>
            </header>
            <ol class="ui-steps">
              @for (s of steps(); track s.id) {
                <li [class.done]="s.done">
                  <span class="ui-step-dot"><ui-icon [name]="s.done ? 'check' : 'circle'" [size]="14" [inline]="false" /></span>
                  <a [routerLink]="s.link" class="ui-step-body">
                    <strong>{{ i18n.instant(s.labelKey) }}</strong>
                    <span>{{ i18n.instant(s.hintKey) }}</span>
                  </a>
                </li>
              }
            </ol>
          </section>
        }

        <div class="ui-kpis" data-testid="dash-kpis">
          <article class="ui-kpi">
            <span class="ui-kpi-icon"><ui-icon name="list" [size]="16" [inline]="false" /></span>
            <span class="ui-kpi-label">{{ i18n.instant('dashboard.kpi.total') }}</span>
            <strong class="ui-kpi-value" data-testid="kpi-total">{{ items().length }}</strong>
            <span class="ui-kpi-sub">{{ i18n.instant('dashboard.kpi.open', { n: openCount() }) }}</span>
          </article>
          <article class="ui-kpi">
            <span class="ui-kpi-icon ui-kpi-icon--info"><ui-icon name="activity" [size]="16" [inline]="false" /></span>
            <span class="ui-kpi-label">{{ i18n.instant('dashboard.kpi.in_progress') }}</span>
            <strong class="ui-kpi-value" data-testid="kpi-progress">{{ inProgress() }}</strong>
            <span class="ui-kpi-sub">{{ i18n.instant('dashboard.kpi.in_review', { n: inReview() }) }}</span>
          </article>
          <article class="ui-kpi">
            <span class="ui-kpi-icon ui-kpi-icon--ok"><ui-icon name="check-circle" [size]="16" [inline]="false" /></span>
            <span class="ui-kpi-label">{{ i18n.instant('dashboard.kpi.completion') }}</span>
            <strong class="ui-kpi-value" data-testid="kpi-completion">{{ completion() }}%</strong>
            <ui-progress [value]="completion()" [label]="i18n.instant('dashboard.kpi.completion')" />
          </article>
          <article class="ui-kpi" [class.ui-kpi--alert]="overdue().length > 0">
            <span class="ui-kpi-icon ui-kpi-icon--err"><ui-icon name="alert" [size]="16" [inline]="false" /></span>
            <span class="ui-kpi-label">{{ i18n.instant('dashboard.kpi.overdue') }}</span>
            <strong class="ui-kpi-value" data-testid="kpi-overdue">{{ overdue().length }}</strong>
            <span class="ui-kpi-sub">{{ i18n.instant('dashboard.kpi.urgent', { n: urgentOpen() }) }}</span>
          </article>
          <article class="ui-kpi">
            <span class="ui-kpi-icon ui-kpi-icon--warn"><ui-icon name="clock" [size]="16" [inline]="false" /></span>
            <span class="ui-kpi-label">{{ i18n.instant('dashboard.kpi.approvals') }}</span>
            <strong class="ui-kpi-value" data-testid="kpi-approvals">{{ pendingApprovals() }}</strong>
            <a class="ui-kpi-sub ui-link" routerLink="/approvals">{{ i18n.instant('dashboard.open_queue') }}</a>
          </article>
        </div>

        <div class="ui-grid ui-grid--col3" data-testid="dash-charts">
          <section class="ui-card" data-testid="chart-states">
            <header class="ui-card-head"><h2><ui-icon name="activity" [size]="18" [inline]="false" /> {{ i18n.instant('dashboard.by_state') }}</h2></header>
            @if (items().length) {
              <ui-donut [data]="stateData()" [label]="i18n.instant('dashboard.by_state')" [centerLabel]="i18n.instant('dashboard.items')" />
            } @else {
              <p class="ui-card-empty">{{ i18n.instant('dashboard.no_items') }}</p>
            }
          </section>
          <section class="ui-card" data-testid="chart-priority">
            <header class="ui-card-head"><h2><ui-icon name="flag" [size]="18" [inline]="false" /> {{ i18n.instant('dashboard.by_priority') }}</h2><span class="ui-card-sub">{{ i18n.instant('dashboard.open_only') }}</span></header>
            @if (openCount()) {
              <ui-bars [data]="priorityData()" [label]="i18n.instant('dashboard.by_priority')" />
            } @else {
              <p class="ui-card-empty">{{ i18n.instant('dashboard.no_items') }}</p>
            }
          </section>
          <section class="ui-card" data-testid="chart-types">
            <header class="ui-card-head"><h2><ui-icon name="layers" [size]="18" [inline]="false" /> {{ i18n.instant('dashboard.by_type') }}</h2></header>
            @if (items().length) {
              <ui-bars [data]="typeData()" [label]="i18n.instant('dashboard.by_type')" />
            } @else {
              <p class="ui-card-empty">{{ i18n.instant('dashboard.no_items') }}</p>
            }
          </section>
        </div>

        <div class="ui-grid ui-grid--2">
          <section class="ui-card" data-testid="dash-features">
            <header class="ui-card-head">
              <h2>{{ i18n.instant('nav.features') }}</h2>
              <a class="ui-link" routerLink="/features">{{ i18n.instant('dashboard.view_all') }}</a>
            </header>
            <ul class="ui-rows">
              @for (f of features().slice(0, 6); track f.id) {
                <li class="ui-row-progress" data-testid="dash-feature-row">
                  <div class="ui-row-main">
                    <span class="ui-row-key">{{ f.key }}</span>
                    <span class="ui-row-title">{{ f.title }}</span>
                    <ui-badge size="sm" [status]="f.lifecycle_status" />
                  </div>
                  <div class="ui-row-meter">
                    <ui-progress [value]="f.work_progress" [label]="i18n.instant('features.work_progress')" />
                    <span class="ui-row-pct">{{ f.work_progress }}%</span>
                  </div>
                </li>
              } @empty {
                <li class="ui-card-empty">{{ i18n.instant('dashboard.no_features') }}</li>
              }
            </ul>
          </section>

          <section class="ui-card" data-testid="dash-milestones">
            <header class="ui-card-head">
              <h2>{{ i18n.instant('milestones.title') }}</h2>
              <a class="ui-link" routerLink="/features">{{ i18n.instant('dashboard.view_all') }}</a>
            </header>
            <ul class="ui-rows">
              @for (m of milestones().slice(0, 6); track m.id) {
                <li class="ui-row-progress" data-testid="dash-milestone-row">
                  <div class="ui-row-main">
                    <ui-icon name="flag" [size]="14" />
                    <span class="ui-row-title">{{ m.name }}</span>
                    @if (m.target_date) {
                      <span class="ui-row-date">{{ m.target_date.slice(0, 10) }}</span>
                    }
                    <ui-badge size="sm" [status]="m.status" />
                  </div>
                  <div class="ui-row-meter">
                    <ui-progress [value]="m.progress" [label]="m.name" />
                    <span class="ui-row-pct">{{ m.progress }}%</span>
                  </div>
                </li>
              } @empty {
                <li class="ui-card-empty">{{ i18n.instant('dashboard.no_milestones') }}</li>
              }
            </ul>
          </section>
        </div>

        <div class="ui-grid ui-grid--2">
          <section class="ui-card" data-testid="dash-attention">
            <header class="ui-card-head">
              <h2>{{ i18n.instant('dashboard.attention') }}</h2>
              <a class="ui-link" routerLink="/work-items">{{ i18n.instant('dashboard.view_all') }}</a>
            </header>
            <ul class="ui-rows">
              @for (it of attention(); track it.id) {
                <li class="ui-row-item" data-testid="dash-attention-row">
                  <a class="ui-link ui-row-key" [routerLink]="['/work-items', it.key]">{{ it.key }}</a>
                  <span class="ui-row-title">{{ it.title }}</span>
                  <ui-badge size="sm" [status]="it.priority" />
                  @if (isOverdue(it)) {
                    <ui-badge size="sm" variant="error">{{ i18n.instant('dashboard.overdue_on', { d: it.due_date?.slice(0, 10) ?? '' }) }}</ui-badge>
                  }
                </li>
              } @empty {
                <li class="ui-card-empty"><ui-icon name="check-circle" [size]="16" /> {{ i18n.instant('dashboard.all_clear') }}</li>
              }
            </ul>
          </section>

          <section class="ui-card" data-testid="dash-recent">
            <header class="ui-card-head">
              <h2>{{ i18n.instant('dashboard.recent_items') }}</h2>
            </header>
            <ul class="ui-rows">
              @for (it of recent(); track it.id) {
                <li class="ui-row-item" data-testid="dash-recent-row">
                  <a class="ui-link ui-row-key" [routerLink]="['/work-items', it.key]">{{ it.key }}</a>
                  <span class="ui-row-title">{{ it.title }}</span>
                  <ui-badge size="sm" [variant]="variant(it.state_category)" [icon]="stateIcon(it.state_category)" [status]="it.state_name" />
                </li>
              } @empty {
                <li class="ui-card-empty">{{ i18n.instant('dashboard.no_items') }}</li>
              }
            </ul>
          </section>
        </div>

        @if (events().length) {
          <section class="ui-card" data-testid="dash-events">
            <header class="ui-card-head">
              <h2>{{ i18n.instant('dashboard.events') }}</h2>
              <a class="ui-link" routerLink="/admin">{{ i18n.instant('dashboard.view_all') }}</a>
            </header>
            <ol class="ui-timeline">
              @for (e of events(); track e.id) {
                <li data-testid="dash-event-row">
                  <span class="ui-timeline-dot" aria-hidden="true"></span>
                  <span class="ui-timeline-action">{{ e.action }}</span>
                  <span class="ui-timeline-meta">{{ e.actor_type }} · {{ e.resource_type }}</span>
                  <time class="ui-timeline-time" [attr.datetime]="e.created_at">{{ when(e.created_at) }}</time>
                </li>
              }
            </ol>
          </section>
        }
      }
    </ui-page>
  `,
})
export class DashboardPage {
  private readonly toast = inject(UiToastService);
  private readonly api = inject(ApiClient);
  readonly i18n = inject(I18n);
  readonly ctx = inject(ProjectContext);

  readonly loading = signal(true);
  readonly loadedOnce = signal(false);
  readonly states = signal<StateDto[]>([]);
  readonly items = signal<ItemDto[]>([]);
  readonly features = signal<FeatureDto[]>([]);
  readonly milestones = signal<MilestoneDto[]>([]);
  readonly pendingApprovals = signal(0);
  readonly events = signal<AuditDto[]>([]);
  readonly providerCount = signal(0);

  readonly variant = stateVariant;
  readonly stateIcon = (category: string): string => statusMeta(category).icon;
  private readonly today = new Date().toISOString().slice(0, 10);

  readonly openItems = computed(() => this.items().filter((i) => !CLOSED.has(i.state_category)));
  readonly openCount = computed(() => this.openItems().length);
  readonly inProgress = computed(() => this.items().filter((i) => i.state_category === 'started').length);
  readonly inReview = computed(() => this.items().filter((i) => i.state_category === 'in_review').length);
  readonly completion = computed(() => {
    const live = this.items().filter((i) => i.state_category !== 'canceled');
    if (!live.length) return 0;
    return Math.round((live.filter((i) => i.state_category === 'completed').length / live.length) * 100);
  });
  readonly overdue = computed(() => this.openItems().filter((i) => this.isOverdue(i)));
  readonly urgentOpen = computed(() => this.openItems().filter((i) => i.priority === 'urgent').length);

  readonly stateData = computed<UiChartDatum[]>(() => {
    const counts = new Map<string, number>();
    for (const i of this.items()) counts.set(i.state_category, (counts.get(i.state_category) ?? 0) + 1);
    return CATEGORY_ORDER.filter((c) => counts.has(c)).map((c) => ({
      label: this.i18n.instant(`dashboard.cat.${c}`),
      value: counts.get(c) ?? 0,
      color: CATEGORY_COLOR[c],
    }));
  });

  readonly priorityData = computed<UiChartDatum[]>(() =>
    PRIORITY_ORDER.map((p) => ({
      label: this.i18n.instant(`dashboard.prio.${p}`),
      value: this.openItems().filter((i) => i.priority === p).length,
      color: PRIORITY_COLOR[p],
    })),
  );

  readonly typeData = computed<UiChartDatum[]>(() => {
    const counts = new Map<string, number>();
    for (const i of this.items()) counts.set(i.type, (counts.get(i.type) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => ({ label: t.replace('_', ' '), value: n, color: 'var(--chart-3)' }));
  });

  readonly attention = computed(() =>
    this.openItems()
      .filter((i) => i.priority === 'urgent' || i.priority === 'high' || this.isOverdue(i))
      .sort((a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority))
      .slice(0, 6),
  );
  readonly recent = computed(() => this.items().slice(0, 6));

  readonly steps = computed(() => [
    { id: 'project', done: true, link: '/projects', labelKey: 'dashboard.step.project', hintKey: 'dashboard.step.project_hint' },
    { id: 'feature', done: this.features().length > 0, link: '/features', labelKey: 'dashboard.step.feature', hintKey: 'dashboard.step.feature_hint' },
    { id: 'milestone', done: this.milestones().length > 0, link: '/features', labelKey: 'dashboard.step.milestone', hintKey: 'dashboard.step.milestone_hint' },
    { id: 'items', done: this.items().length > 0, link: '/work-items', labelKey: 'dashboard.step.items', hintKey: 'dashboard.step.items_hint' },
    { id: 'provider', done: this.providerCount() > 0, link: '/ai-providers', labelKey: 'dashboard.step.provider', hintKey: 'dashboard.step.provider_hint' },
  ]);
  readonly doneSteps = computed(() => this.steps().filter((s) => s.done).length);
  readonly allStepsDone = computed(() => this.doneSteps() === this.steps().length);

  constructor() {
    effect(() => {
      if (this.ctx.selectedId()) void this.load();
    });
  }

  isOverdue(i: ItemDto): boolean {
    return !!i.due_date && i.due_date.slice(0, 10) < this.today && !CLOSED.has(i.state_category);
  }

  when(iso: string): string {
    return new Date(iso).toLocaleString(this.i18n.lang() === 'fa' ? 'fa-IR' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  }

  async load(): Promise<void> {
    const pid = this.ctx.selectedId();
    if (!pid) return;
    this.loading.set(true);
    const get = <T>(path: string): Promise<T> => this.api.get<T>(path);
    const [states, items, features, milestones, approvals, audit, providers] = await Promise.allSettled([
      get<{ items: StateDto[] }>(`/api/v1/projects/${pid}/states`),
      get<{ items: ItemDto[] }>(`/api/v1/projects/${pid}/work-items?limit=200`),
      get<{ items: FeatureDto[] }>(`/api/v1/projects/${pid}/features`),
      get<{ items: MilestoneDto[] }>(`/api/v1/projects/${pid}/milestones`),
      get<{ items: { status: string }[] }>('/api/v1/approvals'),
      get<{ items: AuditDto[] }>('/api/v1/audit?limit=8'),
      get<{ items: unknown[] }>('/api/v1/ai-providers'),
    ]);
    if (this.ctx.selectedId() !== pid) return; // switched while loading
    this.states.set(states.status === 'fulfilled' ? states.value.items : []);
    this.items.set(items.status === 'fulfilled' ? items.value.items : []);
    this.features.set(features.status === 'fulfilled' ? features.value.items : []);
    this.milestones.set(milestones.status === 'fulfilled' ? milestones.value.items : []);
    this.pendingApprovals.set(approvals.status === 'fulfilled' ? approvals.value.items.filter((a) => a.status === 'pending').length : 0);
    this.events.set(audit.status === 'fulfilled' ? audit.value.items : []);
    this.providerCount.set(providers.status === 'fulfilled' ? providers.value.items.length : 0);
    if (items.status === 'rejected') this.toast.error((items.reason as Error).message);
    this.loading.set(false);
    this.loadedOnce.set(true);
  }
}
