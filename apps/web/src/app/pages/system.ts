import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { UiButton } from '../ui/button';
import { UiPage } from '../ui/page';
import { UiDataTable, UiTableColumn, UiTableRowAction } from '../ui/data-table';
import { UiToastService } from '../ui/toast';

interface ModuleDto {
  name: string;
  enabled: boolean;
  registered: boolean;
}
interface JobDto {
  id: string;
  type: string;
  status: string;
  attempts: number;
  error: string | null;
  created_at: string;
}
interface HealthDto {
  database: string;
  redis: string;
  modules: ModuleDto[];
}

/**
 * System Health + Jobs + Backups (plan §5.11, §11 "کامل"), §14 backup.
 * Module toggles here are the runtime switch the §11 acceptance row requires:
 * enabling github/reviews from this page makes their panel pages appear
 * without a hard reload (they re-fetch on navigation).
 */
@Component({
  selector: 'page-system',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, UiButton, UiPage, UiDataTable],
  template: `
    <ui-page data-testid="system" [title]="i18n.instant('system.title')">
      <p data-testid="sys-db">{{ i18n.instant('system.database') }}: {{ health()?.database ?? '…' }}</p>
      <p data-testid="sys-redis">{{ i18n.instant('system.redis') }}: {{ health()?.redis ?? '…' }}</p>

      <h2>{{ i18n.instant('system.modules') }}</h2>
      <ul class="ui-list" data-testid="module-list">
        @for (m of health()?.modules ?? []; track m.name) {
          <li data-testid="module-row">
            {{ m.name }}
            <button type="button" ui-button (click)="toggle(m)" [disabled]="busy()" data-testid="module-toggle">
              {{ m.enabled ? i18n.instant('system.enabled') : i18n.instant('system.disabled') }}
            </button>
          </li>
        }
      </ul>

      <h2>{{ i18n.instant('system.jobs') }}</h2>
      <ui-data-table
        testid="job-list"
        emptyTestid="job-empty"
        [columns]="jobColumns"
        [rows]="jobs()"
        [trackKey]="keyOf"
        [loading]="loading()"
        [error]="error()"
        [emptyMessage]="i18n.instant('common.empty')"
        [rowTestid]="jobRowTestid"
        [actions]="jobActions"
      />

      <h2>{{ i18n.instant('system.backups') }}</h2>
      <button type="button" ui-button (click)="backup()" [disabled]="busy()" data-testid="backup-run">{{ i18n.instant('system.backup') }}</button>
      @if (error()) {
        <p class="ui-error" role="alert" data-testid="system-error">{{ error() }}</p>
      }
    </ui-page>
  `,
})
export class SystemPage implements OnInit {
  private readonly api = inject(ApiClient);
  readonly i18n = inject(I18n);

  readonly health = signal<HealthDto | null>(null);
  readonly jobs = signal<JobDto[]>([]);
  readonly error = signal('');
  private readonly toast = inject(UiToastService);
  readonly busy = signal(false);
  readonly loading = signal(true);

  readonly keyOf = (j: JobDto): string => j.id;
  readonly jobRowTestid = (): string => 'job-row';

  get jobColumns(): UiTableColumn<JobDto>[] {
    return [
      { key: 'type', label: this.i18n.instant('jobs.type'), sortable: true },
      { key: 'status', label: this.i18n.instant('jobs.status'), sortable: true, testid: 'job-status' },
      { key: 'error', label: this.i18n.instant('jobs.error'), value: (j) => j.error ?? '' },
      { key: 'created_at', label: this.i18n.instant('jobs.created'), sortable: true },
    ];
  }

  get jobActions(): UiTableRowAction<JobDto>[] {
    return [
      {
        label: this.i18n.instant('system.retry'),
        testid: 'job-retry',
        when: (j) => j.status === 'failed' || j.status === 'dead',
        run: (j) => void this.retry(j.id),
      },
    ];
  }

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    this.error.set('');
    this.loading.set(true);
    try {
      this.health.set(await this.api.get<HealthDto>('/api/v1/system/health'));
      this.jobs.set((await this.api.get<{ items: JobDto[] }>('/api/v1/jobs')).items);
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  async toggle(m: ModuleDto): Promise<void> {
    this.error.set('');
    this.busy.set(true);
    try {
      await this.api.put('/api/v1/modules/' + m.name + '/enabled', { enabled: !m.enabled });
      await this.load();
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  async retry(id: string): Promise<void> {
    this.error.set('');
    this.busy.set(true);
    try {
      await this.api.post(`/api/v1/jobs/${id}/retry`);
      await this.load();
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  async backup(): Promise<void> {
    this.error.set('');
    this.busy.set(true);
    try {
      const res = await this.api.post<{ file: string }>('/api/v1/system/backup');
      this.toast.ok(this.i18n.instant('system.backup_done', { file: res.file }));
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
