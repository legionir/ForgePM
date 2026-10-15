import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { UiButton } from '../ui/button';

interface ApprovalDto {
  id: string;
  action: string;
  risk: string;
  status: string;
  requested_by: string;
}

/** Approvals queue (plan §7/§8 panel): a human decides pending operations. */
@Component({
  selector: 'page-approvals',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, UiButton],
  template: `
    <section data-testid="approvals">
      <h1>{{ i18n.instant('approvals.title') }}</h1>
      <ul class="ui-list" data-testid="approval-list">
        @for (a of items(); track a.id) {
          <li data-testid="approval-row">
            <span>{{ a.action }} · {{ a.risk }} · {{ a.status }}</span>
            <button type="button" ui-button (click)="decide(a.id, 'approved')" data-testid="approval-approve">
              {{ i18n.instant('approvals.approve') }}
            </button>
            <button type="button" ui-button variant="destructive" (click)="decide(a.id, 'rejected')" data-testid="approval-reject">
              {{ i18n.instant('approvals.reject') }}
            </button>
          </li>
        } @empty {
          <li data-testid="approval-empty">{{ i18n.instant('approvals.empty') }}</li>
        }
      </ul>
      @if (msg()) {
        <p class="ui-ok" data-testid="approval-msg">{{ msg() }}</p>
      }
    </section>
  `,
})
export class ApprovalsPage implements OnInit {
  private readonly api = inject(ApiClient);
  readonly i18n = inject(I18n);
  readonly items = signal<ApprovalDto[]>([]);
  readonly msg = signal('');

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    this.items.set((await this.api.get<{ items: ApprovalDto[] }>('/api/v1/approvals')).items);
  }

  async decide(id: string, decision: 'approved' | 'rejected'): Promise<void> {
    await this.api.post(`/api/v1/approvals/${id}/decide`, { decision });
    this.msg.set(`#${id.slice(0, 8)} ${decision}`);
    await this.load();
  }
}
