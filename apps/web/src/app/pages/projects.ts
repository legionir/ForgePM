import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { UiButton } from '../ui/button';
import { UiPage } from '../ui/page';
import { UiControl, UiField } from '../ui/field';
import { UiDataTable, UiTableColumn } from '../ui/data-table';
import { UiToastService } from '../ui/toast';
import { viewChild, ElementRef } from '@angular/core';

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
  imports: [FormsModule, UiButton, UiField, UiControl, UiDataTable, UiPage],
  template: `
    <ui-page data-testid="projects" [title]="i18n.instant('projects.title')">
      <form class="ui-new" (ngSubmit)="create()">
        <ui-field [label]="i18n.instant('common.key')" required>
          <input uiControl #keyInput name="key" [(ngModel)]="key" required maxlength="8" data-testid="project-key" />
        </ui-field>
        <ui-field [label]="i18n.instant('common.name')" required>
          <input uiControl name="name" [(ngModel)]="name" required data-testid="project-name" />
        </ui-field>
        <button type="submit" ui-button variant="primary" [loading]="busy()" data-testid="project-create">
          {{ i18n.instant('common.create') }}
        </button>
      </form>
      @if (error()) {
        <p class="ui-error" role="alert" data-testid="project-error">{{ error() }}</p>
      }
      <ui-data-table
        testid="projects-list"
        emptyTestid="projects-empty"
        [columns]="columns"
        [rows]="projects()"
        [trackKey]="keyOf"
        [loading]="loadingList()"
        [error]="error()"
        [emptyMessage]="i18n.instant('projects.empty')"
        [emptyActionLabel]="i18n.instant('projects.create_first')"
        (emptyAction)="focusKeyInput()"
        [actions]="rowActions"
      />
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

  private readonly keyInput = viewChild<ElementRef<HTMLInputElement>>('keyInput');

  readonly keyOf = (p: ProjectDto): string => p.id;

  focusKeyInput(): void {
    this.keyInput()?.nativeElement.focus();
  }

  get columns(): UiTableColumn<ProjectDto>[] {
    return [
      { key: 'name', label: this.i18n.instant('common.name'), sortable: true, value: (p) => `${p.key} · ${p.name}` },
      {
        key: 'status',
        label: this.i18n.instant('projects.status'),
        sortable: true,
        badge: (p) => (p.status === 'archived' ? { text: this.i18n.instant('projects.archived'), variant: 'default' as const } : null),
      },
    ];
  }

  get rowActions() {
    return [
      {
        label: this.i18n.instant('projects.archive'),
        testid: 'project-archive',
        when: (p: ProjectDto) => p.status === 'active',
        run: (p: ProjectDto) => void this.archive(p.id),
      },
    ];
  }

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
      await this.load();
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
      await this.load();
    } catch (err) {
      this.error.set((err as Error).message);
    }
  }
}
