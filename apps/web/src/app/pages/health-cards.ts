import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { UiIcon } from '../ui/icon';
import { UiBadge } from '../ui/badge';
import { UiToastService } from '../ui/toast';

interface HealthDto {
  database: string;
  redis: string;
}

/** Database and Redis health cards (shown at the top of the Projects page). */
@Component({
  selector: 'health-cards',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiIcon, UiBadge],
  template: `
    <div class="ui-health-grid" data-testid="health-cards">
      <article class="ui-health" [class.ui-health--ok]="isOk(health()?.database)" [class.ui-health--down]="health() && !isOk(health()?.database)" data-testid="sys-db">
        <span class="ui-health-icon"><ui-icon name="server" [size]="22" [inline]="false" /></span>
        <h2 class="ui-health-title">{{ i18n.instant('system.database') }}</h2>
        <ui-badge class="ui-health-status" role="status" [status]="health()?.database ?? 'pending'" [label]="health()?.database ?? '…'" />
      </article>
      <article class="ui-health" [class.ui-health--ok]="isOk(health()?.redis)" [class.ui-health--down]="health() && !isOk(health()?.redis)" data-testid="sys-redis">
        <span class="ui-health-icon"><ui-icon name="activity" [size]="22" [inline]="false" /></span>
        <h2 class="ui-health-title">{{ i18n.instant('system.redis') }}</h2>
        <ui-badge class="ui-health-status" role="status" [status]="health()?.redis ?? 'pending'" [label]="health()?.redis ?? '…'" />
      </article>
    </div>
  `,
})
export class HealthCards implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly toast = inject(UiToastService);
  readonly i18n = inject(I18n);

  readonly health = signal<HealthDto | null>(null);
  readonly isOk = (v: string | undefined): boolean => v === 'ok';

  async ngOnInit(): Promise<void> {
    try {
      this.health.set(await this.api.get<HealthDto>('/api/v1/system/health'));
    } catch (err) {
      this.toast.error((err as Error).message);
    }
  }
}
