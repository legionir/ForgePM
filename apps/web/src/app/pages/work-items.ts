import { ChangeDetectionStrategy, Component, OnInit, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { UiButton } from '../ui/button';
import { UiBadge } from '../ui/badge';
import { UiAvatar } from '../ui/avatar';
import { UiIcon } from '../ui/icon';
import { UiPage } from '../ui/page';
import { UiTabItem, UiTabs } from '../ui/tabs';
import { UiDataTable, UiTableColumn } from '../ui/data-table';
import { ProjectContext } from '../project-context';
import { UiControl, UiField } from '../ui/field';
import { UiToastService } from '../ui/toast';
import { camelCase, stateVariant, statusMeta } from '../ui/logic';
import { UiModal } from '../ui/modal';
import { CamelPipe } from '../ui/camel';
import { UiBoard, UiDrop, UiDropZone, UiDragSource } from '../ui/board-drag';

export { stateVariant };

interface StateDto {
  id: string;
  name: string;
  category: string;
  position: number;
}
interface ItemDto {
  id: string;
  key: string;
  title: string;
  type: string;
  priority: string;
  state_id: string;
  state_name: string;
  state_category: string;
  labels: string[];
  comment_count: number;
  due_date: string | null;
  acceptance_criteria: { text: string; done: boolean }[];
  assignee_user_id: string | null;
  assignee_agent_id: string | null;
}

/**
 * Work Items List + Board (plan §6 panel, §11). Every move goes through
 * `POST /work-items/:key/transition` — never PATCH on the state column —
 * so server-side rules (open blockers => 409 BLOCKED_BY_OPEN_ITEMS) show
 * up in the UI exactly as the API enforces them. Board drag-and-drop runs on
 * pointer events with native HTML5 DnD as the browser enhancement — no CDK dep
 * (bundle budget, D-034 family), and no gesture that only works in one of them (#11).
 */
@Component({
  selector: 'page-work-items',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, UiButton, UiBadge, UiAvatar, UiIcon, UiField, UiControl, UiPage, UiTabs, UiDataTable, UiBoard, UiDropZone, UiDragSource, UiModal, CamelPipe],
  template: `
    <ui-page data-testid="work-items" [title]="i18n.instant('work_items.title')">

      <header class="ui-card-head">
        <div class="ui-card-title">
          <h2><ui-icon name="list" [size]="18" [inline]="false" /> {{ i18n.instant('work_items.title') }}</h2>
          <ui-badge size="sm" data-testid="wi-count">{{ items().length }}</ui-badge>
        </div>
        <button type="button" ui-button variant="primary" size="sm" (click)="openNew()" data-testid="wi-new-open">
          <ui-icon name="plus" [size]="14" /> {{ i18n.instant('work_items.new') }}
        </button>
      </header>

      <div class="ui-toolbar">
      <ui-tabs [items]="viewTabs" [active]="view()" [ariaLabel]="i18n.instant('work_items.view')" (tabChange)="setView($event)" />

      <ui-field [label]="i18n.instant('work_items.filter_state')">
        <select uiControl name="cat" [(ngModel)]="category" (ngModelChange)="load()" data-testid="wi-filter">
          <option value="">*</option>
          @for (c of categories; track c) {
            <option [value]="c">{{ c | camel }}</option>
          }
        </select>
      </ui-field>
      </div>

      @if (view() === 'list') {
        <ui-data-table
          testid="wi-list"
          emptyTestid="wi-empty"
          [columns]="listColumns"
          [rows]="items()"
          [trackKey]="keyOf"
          [loading]="loadingList()"
          [emptyMessage]="i18n.instant('common.empty')"
          [emptyActionLabel]="i18n.instant('work_items.create_first')"
          (emptyAction)="openNew()"
          [selectable]="true"
        />
      } @else {
        <div class="ui-board" uiBoard (dragDrop)="applyDrop($event)" data-testid="wi-board">
          @for (st of states(); track st.id) {
            <div
              class="ui-board-col"
              [attr.data-state]="st.category"
              uiDropZone
              [uiDropZone]="st.id"
              (dropped)="applyDrop($event)"
              data-testid="board-col"
            >
              <h2>
                {{ st.name }}
                <ui-badge size="sm" data-testid="board-col-count">{{ byState()(st.id).length }}</ui-badge>
                <details class="ui-dt-menu ui-col-menu" (keydown.escape)="closeColMenu($event)">
                  <summary
                    [attr.aria-label]="i18n.instant('work_items.column_menu') + ' — ' + st.name"
                    [title]="i18n.instant('work_items.column_menu')"
                  ><ui-icon name="dots-h" [size]="14" /></summary>
                  <div class="ui-dt-menu-list" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      (click)="toggleQuickAdd(st.id)"
                      [attr.aria-label]="i18n.instant('work_items.quick_add') + ' — ' + st.name"
                      data-testid="board-quick-add"
                    >
                      {{ i18n.instant('work_items.quick_add') }}
                    </button>
                  </div>
                </details>
              </h2>
              @if (quickAddFor() === st.id) {
                <input
                  class="ui-quick-add"
                  [(ngModel)]="quickTitle"
                  [name]="'qa-' + st.id"
                  [attr.placeholder]="i18n.instant('work_items.quick_add')"
                  (keydown.enter)="quickAdd(st.id)"
                  data-testid="board-quick-add-input"
                />
              }
              @for (it of items().filter((x) => x.state_id === st.id); track it.id) {
                <div
                  class="ui-board-card"
                  uiDragSource
                  [uiDragSource]="it.key"
                  [uiDragFrom]="it.state_id"
                  (dragstart)="drag(it, ev($event))"
                  data-testid="board-card"
                >
                  <span class="ui-board-card-title">
                    <a [routerLink]="['/work-items', it.key]">{{ it.key }}</a> {{ it.title }}
                  </span>
                  @if (it.labels.length) {
                    <span class="ui-chip-row">
                      @for (label of it.labels.slice(0, 3); track label) {
                        <span class="ui-chip">{{ label }}</span>
                      }
                      @if (it.labels.length > 3) {
                        <span class="ui-chip">+{{ it.labels.length - 3 }}</span>
                      }
                    </span>
                  }
                  <span class="ui-board-card-meta">
                    @if (it.assignee_user_id || it.assignee_agent_id) {
                      <ui-avatar [name]="it.assignee_user_id ?? it.assignee_agent_id!" size="sm" />
                    }
                    <ui-badge size="sm" [status]="it.priority" data-testid="board-card-priority" />
                    @if (it.acceptance_criteria.length) {
                      <span class="ui-ac-progress" data-testid="board-card-ac">{{ acDone(it) }}/{{ it.acceptance_criteria.length }} ☑</span>
                    }
                    @if (it.due_date) {
                      <span class="ui-due">{{ it.due_date }}</span>
                    }
                  </span>
                  <span class="ui-board-card-move">
                    <button type="button" ui-button variant="ghost" size="sm" [disabled]="!hasRel(it, -1)"
                      [attr.aria-label]="i18n.instant('work_items.move_prev')"
                      (click)="moveRel(it, -1)" data-testid="board-move-prev"><ui-icon name="chevron-left" [size]="14" /></button>
                    <button type="button" ui-button variant="ghost" size="sm" [disabled]="!hasRel(it, 1)"
                      [attr.aria-label]="i18n.instant('work_items.move_next')"
                      (click)="moveRel(it, 1)" data-testid="board-move-next"><ui-icon name="chevron-right" [size]="14" /></button>
                  </span>
                </div>
              }
            </div>
          }
        </div>
      }

      <ui-modal [(open)]="newOpen" [title]="i18n.instant('work_items.new')" icon="list">
        <form class="ui-stack" (ngSubmit)="create()" id="wi-form" data-testid="wi-new">
          <ui-field [label]="i18n.instant('common.title')" required>
            <input uiControl name="tkey" [(ngModel)]="title" required data-testid="wi-title" />
          </ui-field>
          <div class="ui-edit-grid">
            <ui-field [label]="i18n.instant('work_items.type')">
              <select uiControl name="ttype" [(ngModel)]="type" data-testid="wi-type">
                @for (ty of types; track ty) {
                  <option [value]="ty">{{ ty | camel }}</option>
                }
              </select>
            </ui-field>
            <ui-field [label]="i18n.instant('work_items.state')">
              <select uiControl name="tstate" [(ngModel)]="stateId" data-testid="wi-state">
                @for (st of states(); track st.id) {
                  <option [value]="st.id">{{ st.name | camel }}</option>
                }
              </select>
            </ui-field>
            <ui-field [label]="i18n.instant('work_items.priority')">
              <select uiControl name="tprio" [(ngModel)]="priority" data-testid="wi-priority">
                @for (pr of priorities; track pr) {
                  <option [value]="pr">{{ pr | camel }}</option>
                }
              </select>
            </ui-field>
            <ui-field [label]="i18n.instant('milestones.title')">
              <select uiControl name="tmilestone" [(ngModel)]="milestoneId" data-testid="wi-milestone">
                <option value="">{{ i18n.instant('features.no_milestone') | camel }}</option>
                @for (m of milestones(); track m.id) {
                  <option [value]="m.id">{{ m.name | camel }}</option>
                }
              </select>
            </ui-field>
            <ui-field [label]="i18n.instant('features.title')">
              <select uiControl name="tfeature" [(ngModel)]="featureId" data-testid="wi-feature">
                <option value="">{{ i18n.instant('work_items.no_feature') | camel }}</option>
                @for (f of features(); track f.id) {
                  <option [value]="f.id">{{ f.key }} · {{ f.title | camel }}</option>
                }
              </select>
            </ui-field>
          </div>
        </form>
        <div uiModalFooter>
          <button type="button" ui-button variant="ghost" (click)="newOpen.set(false)">{{ i18n.instant('common.cancel') }}</button>
          <button type="submit" form="wi-form" ui-button variant="primary" [loading]="busy()" data-testid="wi-create">
            <ui-icon name="plus" [size]="14" /> {{ i18n.instant('common.create') }}
          </button>
        </div>
      </ui-modal>
    </ui-page>
  `,
})
export class WorkItemsPage implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly route = inject(ActivatedRoute);
  readonly i18n = inject(I18n);
  readonly ctx = inject(ProjectContext);

  readonly items = signal<ItemDto[]>([]);
  readonly states = signal<StateDto[]>([]);
  readonly busy = signal(false);
  readonly loadingList = signal(true);
  private readonly toast = inject(UiToastService);

  readonly view = signal<'list' | 'board'>('list');

  setView(v: string): void {
    this.view.set(v as 'list' | 'board');
  }

  get viewTabs(): UiTabItem[] {
    return [
      { id: 'list', label: this.i18n.instant('work_items.list'), testid: 'wi-tab-list' },
      { id: 'board', label: this.i18n.instant('work_items.board'), testid: 'wi-tab-board' },
    ];
  }

  readonly categories = ['backlog', 'unstarted', 'started', 'in_review', 'completed', 'canceled'];
  readonly types = ['task', 'bug', 'feature_task', 'improvement', 'refactor', 'research', 'chore'];
  readonly priorities = ['none', 'low', 'medium', 'high', 'urgent'];
  readonly newOpen = signal(false);
  readonly milestones = signal<{ id: string; name: string }[]>([]);
  readonly features = signal<{ id: string; key: string; title: string }[]>([]);
  title = '';
  type = 'task';
  stateId = '';
  priority = 'none';
  milestoneId = '';
  featureId = '';
  category = '';

  byState = computed(() => (stateId: string) => this.items().filter((i) => i.state_id === stateId));

  readonly keyOf = (it: ItemDto): string => it.id;

  /** Header button, empty-state CTA and the `c` shortcut (?new=1) open the create modal (P6-8/P6-7). */
  openNew(): void {
    this.title = '';
    this.priority = 'none';
    this.milestoneId = '';
    this.featureId = '';
    this.newOpen.set(true);
    void this.loadLinkTargets();
  }

  /** Milestones and features a new item can be attached to. */
  private async loadLinkTargets(): Promise<void> {
    const pid = this.ctx.selectedId();
    if (!pid) return;
    try {
      this.milestones.set((await this.api.get<{ items: { id: string; name: string }[] }>(`/api/v1/projects/${pid}/milestones`)).items);
      this.features.set((await this.api.get<{ items: { id: string; key: string; title: string }[] }>(`/api/v1/projects/${pid}/features`)).items);
    } catch (err) {
      this.toast.error((err as Error).message);
    }
  }

  closeColMenu(ev: Event): void {
    (ev.target as HTMLElement).closest('details')?.removeAttribute('open');
  }

  /** Quick-add state per column (P6-2): which column's inline input is open. */
  readonly quickAddFor = signal('');
  quickTitle = '';

  toggleQuickAdd(stateId: string): void {
    this.quickAddFor.set(this.quickAddFor() === stateId ? '' : stateId);
    this.quickTitle = '';
  }

  async quickAdd(stateId: string): Promise<void> {
    const t = this.quickTitle.trim();
    if (!t) return;
    this.busy.set(true);
    try {
      await this.api.post(`/api/v1/projects/${this.ctx.selectedId()}/work-items`, {
        type: 'task',
        title: t,
        state_id: stateId,
      });
      this.quickTitle = '';
      this.quickAddFor.set('');
      this.toast.ok(this.i18n.instant('work_items.created'));
      await this.load();
    } catch (err) {
      this.toast.error((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  acDone(it: ItemDto): number {
    return it.acceptance_criteria.filter((c) => c.done).length;
  }

  get listColumns(): UiTableColumn<ItemDto>[] {
    return [
      { key: 'key', label: this.i18n.instant('common.key'), sortable: true, link: (it) => ['/work-items', it.key], linkTestid: 'wi-link' },
      { key: 'title', label: this.i18n.instant('common.title'), sortable: true },
      { key: 'type', label: this.i18n.instant('work_items.type'), sortable: true, value: (it) => camelCase(it.type) },
      { key: 'assignee', label: this.i18n.instant('work_items.assignee'), avatar: (it) => it.assignee_user_id ?? it.assignee_agent_id ?? null },
      { key: 'comments', label: this.i18n.instant('work_items.comments'), sortable: true, value: (it) => it.comment_count },
      {
        key: 'priority',
        label: this.i18n.instant('work_items.priority'),
        sortable: true,
        badge: (it) => ({ text: it.priority, variant: statusMeta(it.priority).variant }),
      },
      {
        key: 'labels',
        label: this.i18n.instant('work_items.labels'),
        chips: (it) => it.labels,
      },
      {
        key: 'state_name',
        label: this.i18n.instant('work_items.state'),
        sortable: true,
        value: (it) => it.state_name,
        badge: (it) => ({ text: it.state_name, variant: stateVariant(it.state_category), icon: statusMeta(it.state_category).icon }),
      },
      { key: 'due_date', label: this.i18n.instant('work_items.due_date'), sortable: true, value: (it) => it.due_date ?? '—' },
    ];
  }

  constructor() {
    effect(() => {
      if (this.ctx.selectedId()) void this.load();
    });
  }

  async ngOnInit(): Promise<void> {
    await this.ctx.ensureLoaded();
    const id = this.route.snapshot.queryParamMap.get('project');
    if (id) this.ctx.select(id);
    await this.load();
    // `c` shortcut lands here with ?new=1 and opens the create modal (P6-7).
    if (this.route.snapshot.queryParamMap.get('new')) {
      setTimeout(() => this.openNew());
    }
  }

  async load(): Promise<void> {
    const pid = this.ctx.selectedId();
    if (!pid) return;
    this.loadingList.set(true);
    try {
      const st = await this.api.get<{ items: StateDto[] }>(`/api/v1/projects/${pid}/states`);
      this.states.set(st.items);
      const q = this.category ? `?state_category=${this.category}` : '';
      const res = await this.api.get<{ items: ItemDto[] }>(`/api/v1/projects/${pid}/work-items${q}`);
      this.items.set(res.items);
      if (!this.stateId && st.items[0]) this.stateId = st.items[0].id;
    } catch (err) {
      this.toast.error((err as Error).message);
    } finally {
      this.loadingList.set(false);
    }
  }

  async create(): Promise<void> {
    this.busy.set(true);
    try {
      if (!this.stateId) await this.load(); // form can be used before the first fetch resolved
      await this.api.post(`/api/v1/projects/${this.ctx.selectedId()}/work-items`, {
        type: this.type,
        title: this.title,
        state_id: this.stateId,
        ...(this.priority !== 'none' ? { priority: this.priority } : {}),
        ...(this.milestoneId ? { milestone_id: this.milestoneId } : {}),
        ...(this.featureId ? { feature_id: this.featureId } : {}),
      });
      this.title = '';
      this.newOpen.set(false);
      this.toast.ok(this.i18n.instant('work_items.created'));
      await this.load();
    } catch (err) {
      this.toast.error((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  ev(e: Event): Event {
    return e;
  }
  /** HTML5 path only: the payload must carry the key (the pointer path never needs it). */
  drag(item: ItemDto, e: Event): void {
    (e as DragEvent).dataTransfer?.setData('text/plain', item.key);
  }

  /**
   * One applied drop from either path (UiBoard for pointer releases, UiDropZone for
   * HTML5 drops). A no-op when the item already sits in that column, so a gesture can
   * never double-apply even if both paths somehow report.
   */
  async applyDrop({ key, to }: UiDrop): Promise<void> {
    const item = this.items().find((i) => i.key === key);
    if (!item || item.state_id === to) return;
    await this.transition(key, to);
  }

  /** Keyboard alternative to drag-and-drop (STT-009): move ±1 column. */
  hasRel(item: ItemDto, delta: number): boolean {
    const sts = this.states();
    const idx = sts.findIndex((st) => st.id === item.state_id);
    return idx >= 0 && !!sts[idx + delta];
  }

  moveRel(item: ItemDto, delta: number): void {
    const sts = this.states();
    const idx = sts.findIndex((st) => st.id === item.state_id);
    const target = sts[idx + delta];
    if (target) void this.transition(item.key, target.id);
  }

  async transition(key: string, toStateId: string): Promise<void> {
    try {
      await this.api.post(`/api/v1/work-items/${key}/transition`, { to_state_id: toStateId });
      await this.load();
    } catch (err) {
      this.toast.error((err as Error).message); // surfaces BLOCKED_BY_OPEN_ITEMS etc.
    }
  }
}


