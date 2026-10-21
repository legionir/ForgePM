import { ChangeDetectionStrategy, Component, ElementRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { ProjectContext, type Project } from '../project-context';
import { UiButton } from '../ui/button';
import { UiPage } from '../ui/page';
import { UiControl, UiField } from '../ui/field';
import { UiToastService } from '../ui/toast';
import { UiBadge } from '../ui/badge';
import { UiIcon } from '../ui/icon';
import { UiLoading } from '../ui/loading';

/**
 * Projects — step 1 of the workflow. Create a project (or open an existing
 * one) to unlock the project sections of the panel. Cards show the active
 * project, archived ones are tucked away; archive keeps its undo toast.
 */
@Component({
  selector: 'page-projects',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, UiButton, UiField, UiControl, UiPage, UiBadge, UiIcon, UiLoading],
  template: `
    <ui-page data-testid="projects" [title]="i18n.instant('projects.title')">
      @if (!ctx.hasProject() && !ctx.loading()) {
        <section class="ui-hero" data-testid="projects-onboarding">
          <h2>{{ i18n.instant('projects.hero_title') }}</h2>
          <p>{{ i18n.instant('projects.hero_text') }}</p>
          <ol class="ui-flow">
            <li class="current"><ui-icon name="folder" [size]="16" [inline]="false" /> {{ i18n.instant('projects.flow.create') }}</li>
            <li><ui-icon name="layers" [size]="16" [inline]="false" /> {{ i18n.instant('projects.flow.plan') }}</li>
            <li><ui-icon name="list" [size]="16" [inline]="false" /> {{ i18n.instant('projects.flow.build') }}</li>
            <li><ui-icon name="eye" [size]="16" [inline]="false" /> {{ i18n.instant('projects.flow.review') }}</li>
          </ol>
        </section>
      }

      <section class="ui-card">
        <header class="ui-card-head"><h2>{{ i18n.instant('projects.new') }}</h2></header>
        <form class="ui-new" (ngSubmit)="create()">
          <ui-field [label]="i18n.instant('common.key')" required [hint]="i18n.instant('projects.key_hint')">
            <input uiControl #keyInput name="key" [(ngModel)]="key" required maxlength="8" data-testid="project-key" />
          </ui-field>
          <ui-field [label]="i18n.instant('common.name')" required>
            <input uiControl name="name" [(ngModel)]="name" required data-testid="project-name" />
          </ui-field>
          <button type="submit" ui-button variant="primary" [loading]="busy()" data-testid="project-create">
            <ui-icon name="plus" [size]="14" /> {{ i18n.instant('common.create') }}
          </button>
        </form>
        @if (error()) {
          <p class="ui-error" role="alert" data-testid="project-error">{{ error() }}</p>
        }
      </section>

      @if (ctx.loading() && !ctx.loaded()) {
        <div class="ui-grid ui-grid--3"><ui-loading kind="card" /><ui-loading kind="card" /></div>
      } @else {
        <div class="ui-grid ui-grid--3" data-testid="projects-list">
          @for (p of active(); track p.id) {
            <article class="ui-project-card" [class.current]="p.id === ctx.selectedId()" data-testid="project-card">
              <header>
                <span class="ui-project-key" aria-hidden="true">{{ p.key.slice(0, 3) }}</span>
                <div class="ui-project-id">
                  <strong class="ui-project-name" data-testid="project-name-text">{{ p.key }} · {{ p.name }}</strong>
                  @if (p.id === ctx.selectedId()) {
                    <ui-badge size="sm" variant="info">{{ i18n.instant('projects.current') }}</ui-badge>
                  }
                </div>
              </header>
              <footer>
                <button type="button" ui-button variant="primary" size="sm" (click)="open(p)" data-testid="project-open">
                  {{ i18n.instant('projects.open') }}
                  <ui-icon name="chevron-right" [size]="14" />
                </button>
                <button type="button" ui-button variant="ghost" size="sm" (click)="archive(p.id)" data-testid="project-archive">
                  <ui-icon name="archive" [size]="14" /> {{ i18n.instant('projects.archive') }}
                </button>
              </footer>
            </article>
          } @empty {
            <div class="ui-empty-card" data-testid="projects-empty">
              <ui-icon name="folder" [size]="28" [inline]="false" />
              <p>{{ i18n.instant('projects.empty') }}</p>
              <button type="button" ui-button variant="secondary" size="sm" (click)="focusKeyInput()">{{ i18n.instant('projects.create_first') }}</button>
            </div>
          }
        </div>

        @if (archived().length) {
          <details class="ui-archived" data-testid="projects-archived">
            <summary>{{ i18n.instant('projects.archived') }} ({{ archived().length }})</summary>
            <ul class="ui-rows">
              @for (p of archived(); track p.id) {
                <li class="ui-row-item">
                  <span class="ui-row-key">{{ p.key }}</span>
                  <span class="ui-row-title">{{ p.name }}</span>
                  <button type="button" ui-button variant="ghost" size="sm" (click)="undoArchive(p.id)">{{ i18n.instant('projects.restore') }}</button>
                </li>
              }
            </ul>
          </details>
        }
      }
    </ui-page>
  `,
})
export class ProjectsPage implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);
  readonly i18n = inject(I18n);
  readonly ctx = inject(ProjectContext);
  private readonly toast = inject(UiToastService);

  readonly error = signal('');
  readonly busy = signal(false);
  key = '';
  name = '';

  readonly active = computed(() => this.ctx.projects().filter((p) => p.status === 'active'));
  readonly archived = computed(() => this.ctx.projects().filter((p) => p.status === 'archived'));

  private readonly keyInput = viewChild<ElementRef<HTMLInputElement>>('keyInput');

  focusKeyInput(): void {
    this.keyInput()?.nativeElement.focus();
  }

  async ngOnInit(): Promise<void> {
    await this.ctx.load();
  }

  open(p: Project): void {
    this.ctx.select(p.id);
    void this.router.navigate(['/dashboard']);
  }

  async create(): Promise<void> {
    this.error.set('');
    this.busy.set(true);
    try {
      const created = await this.api.post<Project | undefined>('/api/v1/projects', { key: this.key.toUpperCase(), name: this.name });
      this.key = '';
      this.name = '';
      this.toast.ok(this.i18n.instant('projects.created'));
      await this.ctx.load();
      // First project unlocks the workspace: select it right away.
      if (created?.id) this.ctx.select(created.id);
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  async archive(id: string): Promise<void> {
    try {
      await this.api.post(`/api/v1/projects/${id}/archive`);
      await this.ctx.load();
      // Undo (plan Phase 8): unarchive endpoint exists, so the toast gets a
      // real reverse action within its display window.
      this.toast.show(this.i18n.instant('projects.archived_done'), 'ok', 7000, {
        label: this.i18n.instant('common.undo'),
        run: () => void this.undoArchive(id),
      });
    } catch (err) {
      this.error.set((err as Error).message);
    }
  }

  async undoArchive(id: string): Promise<void> {
    try {
      await this.api.post(`/api/v1/projects/${id}/unarchive`);
      this.toast.ok(this.i18n.instant('projects.restored'));
      await this.ctx.load();
    } catch (err) {
      this.error.set((err as Error).message);
    }
  }
}
