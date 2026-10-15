import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { UiButton } from '../ui/button';
import { UiPage } from '../ui/page';
import { UiControl, UiField } from '../ui/field';
import { UiBadge } from '../ui/badge';
import { UiEmptyState } from '../ui/empty-state';
import { UiLoading } from '../ui/loading';
import { UiToastService } from '../ui/toast';

interface ProjectDto {
  id: string;
  key: string;
  name: string;
  status: 'active' | 'archived';
}

/**
 * Projects: list, create, archive + a quick switcher (plan §5 panel).
 * Reference adoption of the §3 library: ui-field (explicit label wiring,
 * FRM-002), ui-button (variants + busy guard, FRM-003/STT-001), ui-badge,
 * ui-loading skeleton, ui-empty-state and toast confirmation (STT-002).
 */
@Component({
  selector: 'page-projects',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, UiButton, UiField, UiControl, UiBadge, UiEmptyState, UiLoading, UiPage],
  template: `
    <ui-page data-testid="projects" [title]="i18n.instant('projects.title')">
      <form class="ui-new" (ngSubmit)="create()">
        <ui-field [label]="i18n.instant('common.key')" required>
          <input uiControl name="key" [(ngModel)]="key" required maxlength="8" />
        </ui-field>
        <ui-field [label]="i18n.instant('common.name')" required>
          <input uiControl name="name" [(ngModel)]="name" required />
        </ui-field>
        <button type="submit" ui-button variant="primary" [loading]="busy()" data-testid="project-create">
          {{ i18n.instant('common.create') }}
        </button>
      </form>
      @if (error()) {
        <p class="ui-error" role="alert" data-testid="project-error">{{ error() }}</p>
      }
      @if (loadingList()) {
        <ui-loading kind="lines" [label]="i18n.instant('common.loading')" />
      } @else {
        <ul class="ui-list">
          @for (p of projects(); track p.id) {
            <li>
              <span>{{ p.key }} · {{ p.name }}</span>
              @if (p.status === 'archived') {
                <ui-badge size="sm">{{ i18n.instant('projects.archived') }}</ui-badge>
              }
              @if (p.status === 'active') {
                <button type="button" ui-button (click)="archive(p.id)" data-testid="project-archive">
                  {{ i18n.instant('projects.archive') }}
                </button>
              }
            </li>
          } @empty {
            <li data-testid="projects-empty" class="ui-empty-item">
              <ui-empty-state [message]="i18n.instant('projects.empty')" />
            </li>
          }
        </ul>
      }
    </ui-page>
  `,
})
export class ProjectsPage implements OnInit {
  private readonly api = inject(ApiClient);
  readonly i18n = inject(I18n);
  private readonly toast = inject(UiToastService);

  readonly projects = signal<ProjectDto[]>([]);
  readonly error = signal('');
  readonly busy = signal(false);
  readonly loadingList = signal(true);
  key = '';
  name = '';

  async load(): Promise<void> {
    this.loadingList.set(true);
    try {
      const res = await this.api.get<{ items: ProjectDto[] }>('/api/v1/projects');
      this.projects.set(res.items);
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.loadingList.set(false);
    }
  }

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  async create(): Promise<void> {
    this.error.set('');
    this.busy.set(true);
    try {
      await this.api.post('/api/v1/projects', { key: this.key.toUpperCase(), name: this.name });
      this.key = '';
      this.name = '';
      this.toast.ok(this.i18n.instant('projects.created'));
      await this.load();
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  async archive(id: string): Promise<void> {
    try {
      await this.api.post(`/api/v1/projects/${id}/archive`);
      this.toast.ok(this.i18n.instant('projects.archived_done'));
      await this.load();
    } catch (err) {
      this.error.set((err as Error).message);
    }
  }
}
