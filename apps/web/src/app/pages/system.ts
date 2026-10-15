import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { UiButton } from '../ui/button';
import { UiPage } from '../ui/page';

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
  imports: [FormsModule, UiButton, UiPage],
  template: `
    <ui-page data-testid="system" [title]="i18n.instant('system.title')">
      <p data-testid="sys-db">{{ i18n.instant('system.database') }}: {{ health()?.database ?? '…' }}</p>
      <p data-testid="sys-redis">{{ i18n.instant('system.redis') }}: {{ health()?.redis ?? '…' }}</p>

      <h2>{{ i18n.instant('system.modules') }}</h2>
      <ul class="ui-list" data-testid="module-list">
        @for (m of health()?.modules ?? []; track m.name) {
          <li data-testid="module-row">
            {{ m.name }}
            <button type="button" ui-button (click)="toggle(m)" data-testid="module-toggle">
              {{ m.enabled ? i18n.instant('system.enabled') : i18n.instant('system.disabled') }}
            </button>
          </li>
        }
      </ul>

      <h2>{{ i18n.instant('system.jobs') }}</h2>
      <table class="ui-table" data-testid="job-list">
        <tbody>
          @for (j of jobs(); track j.id) {
            <tr data-testid="job-row">
              <td>{{ j.type }}</td>
              <td data-testid="job-status">{{ j.status }}</td>
              <td>{{ j.error ?? '' }}</td>
              <td>
                @if (j.status === 'failed' || j.status === 'dead') {
                  <button type="button" ui-button (click)="retry(j.id)" data-testid="job-retry">
                    {{ i18n.instant('system.retry') }}
                  </button>
                }
              </td>
            </tr>
          } @empty {
            <tr>
              <td colspan="4" data-testid="job-empty">{{ i18n.instant('common.empty') }}</td>
            </tr>
          }
        </tbody>
      </table>

      <h2>{{ i18n.instant('system.backups') }}</h2>
      <button type="button" ui-button (click)="backup()" data-testid="backup-run">{{ i18n.instant('system.backup') }}</button>
      @if (backupMsg()) {
        <p class="ui-ok" data-testid="backup-msg">{{ backupMsg() }}</p>
      }
    </ui-page>
  `,
})
export class SystemPage implements OnInit {
  private readonly api = inject(ApiClient);
  readonly i18n = inject(I18n);

  readonly health = signal<HealthDto | null>(null);
  readonly jobs = signal<JobDto[]>([]);
  readonly backupMsg = signal('');

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    this.health.set(await this.api.get<HealthDto>('/api/v1/system/health'));
    this.jobs.set((await this.api.get<{ items: JobDto[] }>('/api/v1/jobs')).items);
  }

  async toggle(m: ModuleDto): Promise<void> {
    await this.api.put('/api/v1/modules/' + m.name + '/enabled', { enabled: !m.enabled });
    await this.load();
  }

  async retry(id: string): Promise<void> {
    await this.api.post(`/api/v1/jobs/${id}/retry`);
    await this.load();
  }

  async backup(): Promise<void> {
    const res = await this.api.post<{ file: string }>('/api/v1/system/backup');
    this.backupMsg.set(this.i18n.instant('system.backup_done', { file: res.file }));
  }
}
