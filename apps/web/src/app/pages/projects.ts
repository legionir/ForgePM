import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiClient } from '../api';
import { I18n } from '../i18n';

interface ProjectDto {
  id: string;
  key: string;
  name: string;
  status: 'active' | 'archived';
}

/** Projects: list, create, archive + a quick switcher (plan §5 panel). */
@Component({
  selector: 'page-projects',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <section data-testid="projects">
      <h1>{{ i18n.instant('projects.title') }}</h1>
      <form class="ui-new" (ngSubmit)="create()">
        <label>{{ i18n.instant('common.key') }}<input name="key" [(ngModel)]="key" required maxlength="8" /></label>
        <label>{{ i18n.instant('common.name') }}<input name="name" [(ngModel)]="name" required /></label>
        <button type="submit" data-testid="project-create">{{ i18n.instant('common.create') }}</button>
      </form>
      @if (error()) {
        <p class="ui-error" data-testid="project-error">{{ error() }}</p>
      }
      <ul class="ui-list">
        @for (p of projects(); track p.id) {
          <li>
            <span>{{ p.key }} · {{ p.name }}</span>
            @if (p.status === 'active') {
              <button type="button" (click)="archive(p.id)" data-testid="project-archive">
                {{ i18n.instant('projects.archive') }}
              </button>
            }
          </li>
        } @empty {
          <li data-testid="projects-empty">{{ i18n.instant('projects.empty') }}</li>
        }
      </ul>
    </section>
  `,
})
export class ProjectsPage implements OnInit {
  private readonly api = inject(ApiClient);
  readonly i18n = inject(I18n);

  readonly projects = signal<ProjectDto[]>([]);
  readonly error = signal('');
  key = '';
  name = '';

  async load(): Promise<void> {
    const res = await this.api.get<{ items: ProjectDto[] }>('/api/v1/projects');
    this.projects.set(res.items);
  }

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  async create(): Promise<void> {
    this.error.set('');
    try {
      await this.api.post('/api/v1/projects', { key: this.key.toUpperCase(), name: this.name });
      this.key = '';
      this.name = '';
      await this.load();
    } catch (err) {
      this.error.set((err as Error).message);
    }
  }

  async archive(id: string): Promise<void> {
    await this.api.post(`/api/v1/projects/${id}/archive`);
    await this.load();
  }
}
