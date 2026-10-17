import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
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
import { ProjectPickerCmp } from '../ui/project-picker';
import { UiControl, UiField } from '../ui/field';
import { UiToastService } from '../ui/toast';
import { draggedKey, stateVariant } from '../ui/logic';

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
 * up in the UI exactly as the API enforces them. Board drag-and-drop uses
 * native HTML5 DnD (no CDK dep — bundle budget, D-034 family).
 */
@Component({
  selector: 'page-work-items',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    RouterLink,
    ProjectPickerCmp,
    UiButton,
    UiBadge,
    UiAvatar,
    UiIcon,
    UiField,
    UiControl,
    UiPage,
    UiTabs,
    UiDataTable,
  ],
  template: `
    <ui-page data-testid="work-items" [title]="i18n.instant('work_items.title')">
      <ui-project-picker />

      <ui-tabs
        [items]="viewTabs"
        [active]="view()"
        [ariaLabel]="i18n.instant('work_items.view')"
        (tabChange)="setView($event)"
      />

      <ui-field [label]="i18n.instant('work_items.filter_state')">
        <select uiControl name="cat" [(ngModel)]="category" (ngModelChange)="load()" data-testid="wi-filter">
          <option value="">*</option>
          @for (c of categories; track c) {
            <option [value]="c">{{ c }}</option>
          }
        </select>
      </ui-field>
      @if (error()) {
        <p class="ui-error" role="alert" data-testid="wi-error">{{ error() }}</p>
      }

      @if (view() === 'list') {
        <ui-data-table
          testid="wi-list"
          emptyTestid="wi-empty"
          [columns]="listColumns"
          [rows]="items()"
          [trackKey]="keyOf"
          [loading]="loadingList()"
          [error]="error()"
          [emptyMessage]="i18n.instant('common.empty')"
          [emptyActionLabel]="i18n.instant('work_items.create_first')"
          (emptyAction)="focusTitleInput()"
          [selectable]="true"
        />
      } @else {
        <div class="ui-board" data-testid="wi-board">
          @for (st of states(); track st.id) {
            <div
              class="ui-board-col"
              [attr.data-state]="st.category"
              (dragover)="prevent(ev($event))"
              (drop)="drop(st.id, ev($event))"
              data-testid="board-col"
            >
              <h2>
                {{ st.name }}
                <span class="ui-col-count" data-testid="board-col-count">{{ byState()(st.id).length }}</span>
                <details class="ui-dt-menu ui-col-menu" (keydown.escape)="closeColMenu($event)">
                  <summary
                    [attr.aria-label]="i18n.instant('work_items.column_menu') + ' — ' + st.name"
                    [title]="i18n.instant('work_items.column_menu')"
                  >
                    <ui-icon name="dots-h" [size]="14" />
                  </summary>
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
                  draggable="true"
                  (dragstart)="drag(it, ev($event))"
                  (dragend)="endDrag()"
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
                    <ui-badge
                      size="sm"
                      [variant]="it.priority === 'high' || it.priority === 'urgent' ? 'error' : 'default'"
                      >{{ it.priority }}</ui-badge
                    >
                    @if (it.acceptance_criteria.length) {
                      <span class="ui-ac-progress" data-testid="board-card-ac"
                        >{{ acDone(it) }}/{{ it.acceptance_criteria.length }} ☑</span
                      >
                    }
                    @if (it.due_date) {
                      <span class="ui-due">{{ it.due_date }}</span>
                    }
                  </span>
                  <span class="ui-board-card-move">
                    <button
                      type="button"
                      ui-button
                      variant="ghost"
                      size="sm"
                      [disabled]="!hasRel(it, -1)"
                      [attr.aria-label]="i18n.instant('work_items.move_prev')"
                      (click)="moveRel(it, -1)"
                      data-testid="board-move-prev"
                    >
                      <ui-icon name="chevron-left" [size]="14" />
                    </button>
                    <button
                      type="button"
                      ui-button
                      variant="ghost"
                      size="sm"
                      [disabled]="!hasRel(it, 1)"
                      [attr.aria-label]="i18n.instant('work_items.move_next')"
                      (click)="moveRel(it, 1)"
                      data-testid="board-move-next"
                    >
                      <ui-icon name="chevron-right" [size]="14" />
                    </button>
                  </span>
                </div>
              }
            </div>
          }
        </div>
      }

      <form class="ui-new" (ngSubmit)="create()" data-testid="wi-new">
        <ui-field [label]="i18n.instant('common.title')" required>
          <input uiControl #titleInput name="tkey" [(ngModel)]="title" required data-testid="wi-title" />
        </ui-field>
        <ui-field [label]="i18n.instant('work_items.type')">
          <select uiControl name="ttype" [(ngModel)]="type">
            @for (ty of types; track ty) {
              <option [value]="ty">{{ ty }}</option>
            }
          </select>
        </ui-field>
        <ui-field [label]="i18n.instant('work_items.state')">
          <select uiControl name="tstate" [(ngModel)]="stateId" data-testid="wi-state">
            @for (st of states(); track st.id) {
              <option [value]="st.id">{{ st.name }}</option>
            }
          </select>
        </ui-field>
        <button type="submit" ui-button variant="primary" [loading]="busy()" data-testid="wi-create">
          {{ i18n.instant('work_items.new') }}
        </button>
      </form>
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
  readonly error = signal('');
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
  title = '';
  type = 'task';
  stateId = '';
  category = '';

  byState = computed(() => (stateId: string) => this.items().filter((i) => i.state_id === stateId));

  readonly keyOf = (it: ItemDto): string => it.id;

  private readonly titleInput = viewChild<ElementRef<HTMLInputElement>>('titleInput');

  /** Empty-state CTA + `c` shortcut land here (P6-8/P6-7). */
  focusTitleInput(): void {
    this.titleInput()?.nativeElement.focus();
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
    this.error.set('');
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
      this.error.set((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  acDone(it: ItemDto): number {
    return it.acceptance_criteria.filter((c) => c.done).length;
  }

  get listColumns(): UiTableColumn<ItemDto>[] {
    return [
      {
        key: 'key',
        label: this.i18n.instant('common.key'),
        sortable: true,
        link: (it) => ['/work-items', it.key],
        linkTestid: 'wi-link',
      },
      { key: 'title', label: this.i18n.instant('common.title'), sortable: true },
      { key: 'type', label: this.i18n.instant('work_items.type'), sortable: true },
      {
        key: 'assignee',
        label: this.i18n.instant('work_items.assignee'),
        avatar: (it) => it.assignee_user_id ?? it.assignee_agent_id ?? null,
      },
      {
        key: 'comments',
        label: this.i18n.instant('work_items.comments'),
        sortable: true,
        value: (it) => it.comment_count,
      },
      {
        key: 'priority',
        label: this.i18n.instant('work_items.priority'),
        sortable: true,
        badge: (it) => ({
          text: it.priority,
          variant: it.priority === 'high' || it.priority === 'urgent' ? 'error' : 'default',
        }),
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
        badge: (it) => ({ text: it.state_name, variant: stateVariant(it.state_category) }),
      },
      {
        key: 'due_date',
        label: this.i18n.instant('work_items.due_date'),
        sortable: true,
        value: (it) => it.due_date ?? '—',
      },
    ];
  }

  constructor() {
    effect(() => {
      if (this.ctx.selectedId()) void this.load();
    });
  }

  async ngOnInit(): Promise<void> {
    await this.ctx.load();
    const id = this.route.snapshot.queryParamMap.get('project');
    if (id) this.ctx.select(id);
    await this.load();
    // `c` shortcut lands here with ?new=1 and focuses the create form (P6-7).
    if (this.route.snapshot.queryParamMap.get('new')) {
      setTimeout(() => this.focusTitleInput());
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
      this.error.set((err as Error).message);
    } finally {
      this.loadingList.set(false);
    }
  }

  async create(): Promise<void> {
    this.error.set('');
    this.busy.set(true);
    try {
      if (!this.stateId) await this.load(); // form can be used before the first fetch resolved
      await this.api.post(`/api/v1/projects/${this.ctx.selectedId()}/work-items`, {
        type: this.type,
        title: this.title,
        state_id: this.stateId,
      });
      this.title = '';
      this.toast.ok(this.i18n.instant('work_items.created'));
      await this.load();
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  ev(e: Event): Event {
    return e;
  }
  prevent(e: Event): void {
    e.preventDefault();
  }

  /** Remembered at `dragstart` — see `draggedKey` for why the payload alone is not enough. */
  private draggingKey: string | null = null;

  drag(item: ItemDto, e: Event): void {
    this.draggingKey = item.key;
    (e as DragEvent).dataTransfer?.setData('text/plain', item.key);
  }

  /** A cancelled drag must not leave a key behind for the next drop. */
  endDrag(): void {
    this.draggingKey = null;
  }

  async drop(stateId: string, e: Event): Promise<void> {
    e.preventDefault();
    const key = draggedKey((e as DragEvent).dataTransfer, this.draggingKey);
    this.draggingKey = null;
    if (!key) return;
    const item = this.items().find((i) => i.key === key);
    if (!item || item.state_id === stateId) return;
    await this.transition(key, stateId);
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
    this.error.set('');
    try {
      await this.api.post(`/api/v1/work-items/${key}/transition`, { to_state_id: toStateId });
      await this.load();
    } catch (err) {
      this.error.set((err as Error).message); // surfaces BLOCKED_BY_OPEN_ITEMS etc.
    }
  }
}
