import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { UiButton } from '../ui/button';
import { UiPage } from '../ui/page';
import { UiIcon } from '../ui/icon';
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
  imports: [FormsModule, UiButton, UiPage, UiDataTable, UiIcon],
  template: `
    <ui-page data-testid="system" [title]="i18n.instant('system.title')">
      <div class="ui-health-grid">
        <article class="ui-health" [class.ui-health--ok]="isOk(health()?.database)" [class.ui-health--down]="health() && !isOk(health()?.database)" data-testid="sys-db">
          <span class="ui-health-icon"><ui-icon name="server" [size]="22" [inline]="false" /></span>
          <h2 class="ui-health-title">{{ i18n.instant('system.database') }}</h2>
          <span class="ui-health-status" role="status"><span class="ui-health-dot" aria-hidden="true"></span>{{ health()?.database ?? '…' }}</span>
        </article>
        <article class="ui-health" [class.ui-health--ok]="isOk(health()?.redis)" [class.ui-health--down]="health() && !isOk(health()?.redis)" data-testid="sys-redis">
          <span class="ui-health-icon"><ui-icon name="activity" [size]="22" [inline]="false" /></span>
          <h2 class="ui-health-title">{{ i18n.instant('system.redis') }}</h2>
          <span class="ui-health-status" role="status"><span class="ui-health-dot" aria-hidden="true"></span>{{ health()?.redis ?? '…' }}</span>
        </article>
      </div>

      <section class="ui-card">
      <header class="ui-card-head"><h2>{{ i18n.instant('system.modules') }}</h2></header>
      <ul class="ui-list" data-testid="module-list">
        @for (m of health()?.modules ?? []; track m.name) {
          <li class="ui-module-row" data-testid="module-row">
            <span class="ui-module-name">{{ m.name }}</span>
            <span class="ui-module-state">{{ m.enabled ? i18n.instant('system.enabled') : i18n.instant('system.disabled') }}</span>
            <button
              type="button"
              role="switch"
              class="ui-switch"
              [attr.aria-checked]="m.enabled"
              [attr.aria-label]="m.name"
              (click)="toggle(m)"
              [disabled]="busy()"
              data-testid="module-toggle"
            ><span class="ui-switch-thumb"></span></button>
          </li>
        }
      </ul>
      </section>

      <section class="ui-card">
      <header class="ui-card-head"><h2>{{ i18n.instant('system.jobs') }}</h2></header>
      <ui-data-table
        testid="job-list"
        emptyTestid="job-empty"
        [columns]="jobColumns"
        [rows]="jobs()"
        [trackKey]="keyOf"
        [loading]="loading()"
        [emptyMessage]="i18n.instant('common.empty')"
        [rowTestid]="jobRowTestid"
        [actions]="jobActions"
      />
      </section>

      <section class="ui-card">
      <header class="ui-card-head"><h2>{{ i18n.instant('system.backups') }}</h2></header>
      <div><button type="button" ui-button (click)="backup()" [disabled]="busy()" data-testid="backup-run">{{ i18n.instant('system.backup') }}</button></div>
      </section>
    </ui-page>
  `,
})
export class SystemPage implements OnInit {
  private readonly api = inject(ApiClient);
  readonly i18n = inject(I18n);

  readonly health = signal<HealthDto | null>(null);
  readonly jobs = signal<JobDto[]>([]);
  private readonly toast = inject(UiToastService);
  readonly busy = signal(false);
  readonly loading = signal(true);

  readonly isOk = (v: string | undefined): boolean => v === 'ok';
  readonly keyOf =(j: JobDto): string => j.id;
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
    this.loading.set(true);
    try {
      this.health.set(await this.api.get<HealthDto>('/api/v1/system/health'));
      this.jobs.set((await this.api.get<{ items: JobDto[] }>('/api/v1/jobs')).items);
    } catch (err) {
      this.toast.error((err as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  async toggle(m: ModuleDto): Promise<void> {
    this.busy.set(true);
    try {
      await this.api.put('/api/v1/modules/' + m.name + '/enabled', { enabled: !m.enabled });
      await this.load();
    } catch (err) {
      this.toast.error((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  async retry(id: string): Promise<void> {
    this.busy.set(true);
    try {
      await this.api.post(`/api/v1/jobs/${id}/retry`);
      await this.load();
    } catch (err) {
      this.toast.error((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  async backup(): Promise<void> {
    this.busy.set(true);
    try {
      const res = await this.api.post<{ file: string }>('/api/v1/system/backup');
      this.toast.ok(this.i18n.instant('system.backup_done', { file: res.file }));
    } catch (err) {
      this.toast.error((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
