import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
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
import { UiModal } from '../ui/modal';
import { CamelPipe } from '../ui/camel';
import { HealthCards } from './health-cards';

/**
 * Projects — step 1 of the workflow. Create a project (modal) or open an
 * existing one to unlock the project sections of the panel. Cards are large
 * portrait tiles (image on top, details and actions below); the active
 * project has its own border colour and an "Active" label on its image.
 * Archived projects are tucked away and can be restored.
 */
@Component({
  selector: 'page-projects',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, UiButton, UiField, UiControl, UiPage, UiBadge, UiIcon, UiLoading, UiModal, CamelPipe, HealthCards],
  template: `
    <ui-page data-testid="projects" [title]="i18n.instant('projects.title')">
      <health-cards />

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

      <header class="ui-card-head">
        <div class="ui-card-title">
          <h2><ui-icon name="folder" [size]="18" [inline]="false" /> {{ i18n.instant('projects.title') }}</h2>
          <ui-badge size="sm" data-testid="projects-count">{{ active().length }}</ui-badge>
        </div>
        <button type="button" ui-button variant="primary" size="sm" (click)="openNew()" data-testid="project-new-open">
          <ui-icon name="plus" [size]="14" /> {{ i18n.instant('projects.new') }}
        </button>
      </header>

      @if (ctx.loading() && !ctx.loaded()) {
        <div class="ui-grid ui-grid--3"><ui-loading kind="card" /><ui-loading kind="card" /><ui-loading kind="card" /></div>
      } @else {
        <div class="ui-grid ui-grid--3 ui-project-grid" data-testid="projects-list">
          @for (p of active(); track p.id) {
            <article class="ui-project-card" [class.current]="p.id === ctx.selectedId()" data-testid="project-card">
              <div class="ui-project-image" [style.--hue]="hue(p.key)" data-testid="project-image">
                <span class="ui-project-initials" aria-hidden="true">{{ p.key.slice(0, 3) }}</span>
                @if (p.id === ctx.selectedId()) {
                  <ui-badge class="ui-project-active" variant="success" icon="check-circle" data-testid="project-active">{{ i18n.instant('projects.active') }}</ui-badge>
                }
              </div>
              <div class="ui-project-body">
                <div class="ui-project-id">
                  <strong class="ui-project-name" data-testid="project-name-text">{{ p.key }} · {{ p.name }}</strong>
                  <ui-badge size="sm" [status]="p.priority ?? 'none'" />
                </div>
                <p class="ui-project-desc">{{ p.description || i18n.instant('projects.no_description') }}</p>
                @if (p.start_date || p.target_date) {
                  <p class="ui-project-dates">
                    <ui-icon name="clock" [size]="12" [inline]="false" /> {{ p.start_date ?? '—' }} → {{ p.target_date ?? '—' }}
                  </p>
                }
              </div>
              <footer class="ui-project-actions">
                <button type="button" ui-button variant="primary" size="sm" (click)="open(p)" data-testid="project-open">
                  {{ i18n.instant('projects.open') }}
                  <ui-icon name="chevron-right" [size]="14" />
                </button>
                <button type="button" ui-button variant="ghost" size="sm" (click)="startEdit(p)" data-testid="project-edit">
                  <ui-icon name="edit" [size]="14" /> {{ i18n.instant('common.edit') }}
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
              <button type="button" ui-button variant="secondary" size="sm" (click)="openNew()">{{ i18n.instant('projects.create_first') }}</button>
            </div>
          }
        </div>

        @if (archived().length) {
          <details class="ui-archived" data-testid="projects-archived">
            <summary>
              <ui-icon name="archive" [size]="14" [inline]="false" /> {{ i18n.instant('projects.archived') }}
              <ui-badge size="sm">{{ archived().length }}</ui-badge>
            </summary>
            <ul class="ui-rows">
              @for (p of archived(); track p.id) {
                <li class="ui-row-item">
                  <span class="ui-row-key">{{ p.key }}</span>
                  <span class="ui-row-title">{{ p.name }}</span>
                  <ui-badge size="sm" status="archived" />
                  <button type="button" ui-button variant="ghost" size="sm" (click)="undoArchive(p.id)" data-testid="project-restore">{{ i18n.instant('projects.restore') }}</button>
                </li>
              }
            </ul>
          </details>
        }
      }

      <ui-modal [(open)]="newOpen" [title]="i18n.instant('projects.new')" icon="folder">
        <form class="ui-stack" (ngSubmit)="create()" id="project-form" data-testid="project-new">
          <ui-field [label]="i18n.instant('common.key')" required [hint]="i18n.instant('projects.key_hint')">
            <input uiControl name="key" [(ngModel)]="key" required maxlength="8" data-testid="project-key" />
          </ui-field>
          <ui-field [label]="i18n.instant('common.name')" required>
            <input uiControl name="name" [(ngModel)]="name" required data-testid="project-name" />
          </ui-field>
        </form>
        <div uiModalFooter>
          <button type="button" ui-button variant="ghost" (click)="newOpen.set(false)">{{ i18n.instant('common.cancel') }}</button>
          <button type="submit" form="project-form" ui-button variant="primary" [loading]="busy()" data-testid="project-create">
            <ui-icon name="plus" [size]="14" /> {{ i18n.instant('common.create') }}
          </button>
        </div>
      </ui-modal>

      <ui-modal [open]="!!editing()" (openChange)="$event || cancelEdit()" [title]="i18n.instant('projects.edit_title') + (editing() ? ' · ' + editing()!.key : '')" icon="edit">
        @if (editing(); as e) {
          <form class="ui-edit-grid" (ngSubmit)="saveEdit()" id="project-edit-form-el" data-testid="project-edit-form">
            <ui-field [label]="i18n.instant('common.key')" [hint]="i18n.instant('projects.key_locked')" readOnly>
              <input uiControl name="edit-key" [value]="e.key" data-testid="edit-key" />
            </ui-field>
            <ui-field [label]="i18n.instant('common.name')" required>
              <input uiControl name="edit-name" [(ngModel)]="form.name" required maxlength="200" data-testid="edit-name" />
            </ui-field>
            <ui-field [label]="i18n.instant('projects.priority')">
              <select uiControl name="edit-priority" [(ngModel)]="form.priority" data-testid="edit-priority">
                @for (pr of priorities; track pr) {
                  <option [value]="pr">{{ pr | camel }}</option>
                }
              </select>
            </ui-field>
            <ui-field [label]="i18n.instant('projects.start_date')">
              <input uiControl type="date" name="edit-start" [(ngModel)]="form.start_date" data-testid="edit-start" />
            </ui-field>
            <ui-field [label]="i18n.instant('projects.target_date')">
              <input uiControl type="date" name="edit-target" [(ngModel)]="form.target_date" data-testid="edit-target" />
            </ui-field>
            <ui-field class="ui-edit-wide" [label]="i18n.instant('projects.description')">
              <textarea uiControl name="edit-description" [(ngModel)]="form.description" rows="4" maxlength="20000" data-testid="edit-description"></textarea>
            </ui-field>
          </form>
        }
        <div uiModalFooter>
          <button type="button" ui-button variant="ghost" (click)="cancelEdit()" data-testid="edit-cancel">{{ i18n.instant('common.cancel') }}</button>
          <button type="submit" form="project-edit-form-el" ui-button variant="primary" [loading]="busy()" data-testid="edit-save">{{ i18n.instant('common.save') }}</button>
        </div>
      </ui-modal>
    </ui-page>
  `,
})
export class ProjectsPage implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);
  readonly i18n = inject(I18n);
  readonly ctx = inject(ProjectContext);
  private readonly toast = inject(UiToastService);

  readonly busy = signal(false);
  readonly newOpen = signal(false);
  key = '';
  name = '';
  readonly editing = signal<Project | null>(null);
  readonly priorities = ['none', 'low', 'medium', 'high', 'urgent'] as const;
  form = { name: '', description: '', priority: 'none' as string, start_date: '', target_date: '' };

  readonly active = computed(() => this.ctx.projects().filter((p) => p.status === 'active'));
  readonly archived = computed(() => this.ctx.projects().filter((p) => p.status === 'archived'));

  /** Stable colour per project key for the card image. */
  hue(key: string): number {
    let h = 0;
    for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
  }

  openNew(): void {
    this.key = '';
    this.name = '';
    this.newOpen.set(true);
  }

  async ngOnInit(): Promise<void> {
    await this.ctx.load();
  }

  open(p: Project): void {
    this.ctx.select(p.id);
    void this.router.navigate(['/dashboard']);
  }

  async create(): Promise<void> {
    this.busy.set(true);
    try {
      const created = await this.api.post<Project | undefined>('/api/v1/projects', { key: this.key.toUpperCase(), name: this.name });
      this.key = '';
      this.name = '';
      this.newOpen.set(false);
      this.toast.ok(this.i18n.instant('projects.created'));
      await this.ctx.load();
      // First project unlocks the workspace: select it right away.
      if (created?.id) this.ctx.select(created.id);
    } catch (err) {
      this.toast.error((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  startEdit(p: Project): void {
    this.form = {
      name: p.name,
      description: p.description ?? '',
      priority: p.priority ?? 'none',
      start_date: p.start_date ?? '',
      target_date: p.target_date ?? '',
    };
    this.editing.set(p);
  }

  cancelEdit(): void {
    this.editing.set(null);
  }

  /** PATCH only what changed; an empty date clears the stored date. */
  async saveEdit(): Promise<void> {
    const p = this.editing();
    if (!p) return;
    const patch: Record<string, unknown> = {};
    if (this.form.name !== p.name) patch['name'] = this.form.name;
    if (this.form.description !== (p.description ?? '')) patch['description'] = this.form.description;
    if (this.form.priority !== (p.priority ?? 'none')) patch['priority'] = this.form.priority;
    if (this.form.start_date !== (p.start_date ?? '')) patch['start_date'] = this.form.start_date || null;
    if (this.form.target_date !== (p.target_date ?? '')) patch['target_date'] = this.form.target_date || null;
    if (Object.keys(patch).length === 0) {
      this.cancelEdit();
      return;
    }
    this.busy.set(true);
    try {
      await this.api.patch(`/api/v1/projects/${p.id}`, patch);
      this.toast.ok(this.i18n.instant('projects.updated'));
      this.editing.set(null);
      await this.ctx.load();
    } catch (err) {
      this.toast.error((err as Error).message);
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
      this.toast.error((err as Error).message);
    }
  }

  async undoArchive(id: string): Promise<void> {
    try {
      await this.api.post(`/api/v1/projects/${id}/unarchive`);
      this.toast.ok(this.i18n.instant('projects.restored'));
      await this.ctx.load();
    } catch (err) {
      this.toast.error((err as Error).message);
    }
  }
}
