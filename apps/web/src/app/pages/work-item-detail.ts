import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { UiButton } from '../ui/button';
import { ProjectContext } from '../project-context';

interface ItemDto {
  id: string;
  key: string;
  title: string;
  state_name: string;
  state_category: string;
  description: string | null;
  type: string;
  priority: string;
  acceptance_criteria: { text: string; done: boolean }[];
}
interface CommentDto {
  id: string;
  author_type: string;
  kind: string;
  body: string;
  created_at: string;
}
interface ActivityDto {
  action: string;
  actor_type: string;
  created_at: string;
}

/** Work item detail: fields, acceptance checklist, comments + activity (§6). */
@Component({
  selector: 'page-work-item-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, UiButton],
  template: `
    @if (item(); as it) {
      <section data-testid="wi-detail">
        <a routerLink="/work-items" data-testid="wi-back">← {{ i18n.instant('common.back') }}</a>
        <h1>{{ it.key }} — {{ it.title }}</h1>
        <p>{{ it.type }} · {{ it.priority }} · {{ it.state_name }}</p>
        @if (it.description) {
          <p>{{ it.description }}</p>
        }

        <h2>Acceptance</h2>
        <ul data-testid="wi-ac">
          @for (c of it.acceptance_criteria; track c.text) {
            <li>{{ c.done ? '☑' : '☐' }} {{ c.text }}</li>
          }
        </ul>

        <form (ngSubmit)="move()" data-testid="wi-move">
          <label>{{ i18n.instant('work_items.transition') }}
            <select name="to" [(ngModel)]="toState" data-testid="wi-move-select">
              @for (st of states(); track st.id) {
                <option [value]="st.id">{{ st.name }}</option>
              }
            </select>
          </label>
          <button type="submit" ui-button variant="primary">{{ i18n.instant('common.save') }}</button>
        </form>
        @if (error()) {
          <p class="ui-error" data-testid="wi-detail-error">{{ error() }}</p>
        }

        <h2>{{ i18n.instant('work_items.comment') }}</h2>
        <ul data-testid="wi-comments">
          @for (c of comments(); track c.id) {
            <li>{{ c.author_type }}: {{ c.body }}</li>
          }
        </ul>
        <form class="ui-new" (ngSubmit)="addComment()">
          <label>{{ i18n.instant('work_items.comment') }}<input name="cm" [(ngModel)]="comment" required data-testid="wi-comment-input" /></label>
          <button type="submit" ui-button variant="primary" data-testid="wi-comment-add">{{ i18n.instant('work_items.add_comment') }}</button>
        </form>

        <h2>{{ i18n.instant('work_items.activity') }}</h2>
        <ul data-testid="wi-activity">
          @for (a of activity(); track $index) {
            <li>{{ a.action }} ({{ a.actor_type }})</li>
          }
        </ul>
      </section>
    } @else {
      <p data-testid="wi-detail-loading">…</p>
    }
  `,
})
export class WorkItemDetailPage implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly ctx = inject(ProjectContext);
  readonly i18n = inject(I18n);

  readonly item = signal<ItemDto | null>(null);
  readonly states = signal<{ id: string; name: string }[]>([]);
  readonly comments = signal<CommentDto[]>([]);
  readonly activity = signal<ActivityDto[]>([]);
  readonly error = signal('');
  comment = '';
  toState = '';

  async ngOnInit(): Promise<void> {
    const key = location.pathname.split('/').pop() ?? '';
    await this.ctx.load();
    const pid = this.ctx.selectedId();
    if (pid) {
      const st = await this.api.get<{ items: { id: string; name: string }[] }>(`/api/v1/projects/${pid}/states`);
      this.states.set(st.items);
    }
    await this.reload(key);
  }

  async reload(key: string): Promise<void> {
    this.item.set(await this.api.get<ItemDto>(`/api/v1/work-items/${key}`));
    this.comments.set((await this.api.get<{ items: CommentDto[] }>(`/api/v1/work-items/${key}/comments`)).items);
    this.activity.set((await this.api.get<{ items: ActivityDto[] }>(`/api/v1/work-items/${key}/activity`)).items);
  }

  async addComment(): Promise<void> {
    const key = this.item()?.key;
    if (!key) return;
    await this.api.post(`/api/v1/work-items/${key}/comments`, { body: this.comment });
    this.comment = '';
    await this.reload(key);
  }

  async move(): Promise<void> {
    const key = this.item()?.key;
    if (!key || !this.toState) return;
    this.error.set('');
    try {
      await this.api.post(`/api/v1/work-items/${key}/transition`, { to_state_id: this.toState });
      await this.reload(key);
    } catch (err) {
      this.error.set((err as Error).message);
    }
  }
}
