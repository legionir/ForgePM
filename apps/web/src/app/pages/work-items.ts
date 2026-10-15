import { ChangeDetectionStrategy, Component, OnInit, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { UiButton } from '../ui/button';
import { UiPage } from '../ui/page';
import { UiTabItem, UiTabs } from '../ui/tabs';
import { ProjectContext } from '../project-context';
import { ProjectPickerCmp } from '../ui/project-picker';
import { UiControl, UiField } from '../ui/field';
import { UiBadge } from '../ui/badge';
import { UiEmptyState } from '../ui/empty-state';
import { UiLoading } from '../ui/loading';
import { UiToastService } from '../ui/toast';

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
  imports: [FormsModule, RouterLink, ProjectPickerCmp, UiButton, UiField, UiControl, UiBadge, UiEmptyState, UiLoading, UiPage, UiTabs],
  template: `
    <ui-page data-testid="work-items" [title]="i18n.instant('work_items.title')">
      <ui-project-picker />

      <ui-tabs [items]="viewTabs" [active]="view()" [ariaLabel]="i18n.instant('work_items.view')" (tabChange)="setView($event)" />

      <ui-field [label]="i18n.instant('work_items.filter_state')">
        <select uiControl name="cat" [(ngModel)]="category" (ngModelChange)="load()" data-testid="wi-filter">
          <option value="">*</option>
          @for (c of categories; track c) {
            <option [value]="c">{{ c }}</option>
          }
        </select>
      </ui-field>
      @if (error()) {
        <p class="ui-error" data-testid="wi-error">{{ error() }}</p>
      }

      @if (loadingList()) {
        <ui-loading kind="table" [label]="i18n.instant('common.loading')" />
      } @else if (view() === 'list') {
        <table class="ui-table" data-testid="wi-list">
          <thead>
            <tr>
              <th>{{ i18n.instant('common.key') }}</th>
              <th>{{ i18n.instant('common.title') }}</th>
              <th>{{ i18n.instant('work_items.type') }}</th>
              <th>{{ i18n.instant('work_items.priority') }}</th>
              <th>{{ i18n.instant('work_items.state') }}</th>
            </tr>
          </thead>
          <tbody>
            @for (it of items(); track it.id) {
              <tr>
                <td>
                  <a [routerLink]="['/work-items', it.key]" data-testid="wi-link">{{ it.key }}</a>
                </td>
                <td>{{ it.title }}</td>
                <td>{{ it.type }}</td>
                <td><ui-badge size="sm" [variant]="it.priority === 'high' || it.priority === 'urgent' ? 'error' : 'default'">{{ it.priority }}</ui-badge></td>
                <td>{{ it.state_name }}</td>
              </tr>
            } @empty {
              <tr>
                <td colspan="5" data-testid="wi-empty">
                  <ui-empty-state [message]="i18n.instant('common.empty')" />
                </td>
              </tr>
            }
          </tbody>
        </table>
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
              <h2>{{ st.name }}</h2>
              @for (it of items().filter((x) => x.state_id === st.id); track it.id) {
                <div class="ui-board-card" draggable="true" (dragstart)="drag(it, ev($event))" data-testid="board-card">
                  <a [routerLink]="['/work-items', it.key]">{{ it.key }}</a> {{ it.title }}
                </div>
              }
            </div>
          }
        </div>
      }

      <form class="ui-new" (ngSubmit)="create()" data-testid="wi-new">
        <ui-field [label]="i18n.instant('common.title')" required>
          <input uiControl name="tkey" [(ngModel)]="title" required data-testid="wi-title" />
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
        <button type="submit" ui-button variant="primary" [loading]="busy()" data-testid="wi-create">{{ i18n.instant('work_items.new') }}</button>
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

  drag(item: ItemDto, e: Event): void {
    (e as DragEvent).dataTransfer?.setData('text/plain', item.key);
  }

  async drop(stateId: string, e: Event): Promise<void> {
    e.preventDefault();
    const key = (e as DragEvent).dataTransfer?.getData('text/plain');
    if (!key) return;
    const item = this.items().find((i) => i.key === key);
    if (!item || item.state_id === stateId) return;
    await this.transition(key, stateId);
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
