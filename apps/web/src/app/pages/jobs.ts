import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { UiPage } from '../ui/page';
import { UiIcon } from '../ui/icon';
import { UiBadge } from '../ui/badge';
import { UiDataTable, UiTableColumn, UiTableRowAction } from '../ui/data-table';
import { UiToastService } from '../ui/toast';
import { statusMeta } from '../ui/logic';

interface JobDto {
  id: string;
  type: string;
  status: string;
  attempts: number;
  error: string | null;
  created_at: string;
}

/** Background jobs (outbox → queue → worker) with retry for failed and dead jobs. */
@Component({
  selector: 'page-jobs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiPage, UiDataTable, UiIcon, UiBadge],
  template: `
    <ui-page data-testid="jobs" [title]="i18n.instant('system.jobs')">
      <section class="ui-card">
        <header class="ui-card-head">
          <h2><ui-icon name="activity" [size]="18" [inline]="false" /> {{ i18n.instant('system.jobs') }}</h2>
          <ui-badge size="sm">{{ jobs().length }}</ui-badge>
        </header>
        <ui-data-table
          testid="job-list"
          emptyTestid="job-empty"
          [columns]="columns"
          [rows]="jobs()"
          [trackKey]="keyOf"
          [loading]="loading()"
          [emptyMessage]="i18n.instant('common.empty')"
          [rowTestid]="rowTestid"
          [actions]="actions"
        />
      </section>
    </ui-page>
  `,
})
export class JobsPage implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly toast = inject(UiToastService);
  readonly i18n = inject(I18n);

  readonly jobs = signal<JobDto[]>([]);
  readonly loading = signal(true);
  readonly busy = signal(false);

  readonly keyOf = (j: JobDto): string => j.id;
  readonly rowTestid = (): string => 'job-row';

  get columns(): UiTableColumn<JobDto>[] {
    return [
      { key: 'type', label: this.i18n.instant('jobs.type'), sortable: true },
      {
        key: 'status',
        label: this.i18n.instant('jobs.status'),
        sortable: true,
        testid: 'job-status',
        badge: (j) => ({ text: j.status, variant: statusMeta(j.status).variant }),
      },
      { key: 'error', label: this.i18n.instant('jobs.error'), value: (j) => j.error ?? '' },
      { key: 'created_at', label: this.i18n.instant('jobs.created'), sortable: true },
    ];
  }

  get actions(): UiTableRowAction<JobDto>[] {
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
      this.jobs.set((await this.api.get<{ items: JobDto[] }>('/api/v1/jobs')).items);
    } catch (err) {
      this.toast.error((err as Error).message);
    } finally {
      this.loading.set(false);
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
}
