import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { UiButton } from '../ui/button';
import { UiToastService } from '../ui/toast';
import { UiPage } from '../ui/page';

interface ApprovalDto {
  id: string;
  action: string;
  risk: string;
  status: string;
  requested_by: string;
}

/** The execution ledger's own rows of the queue (plan §9.5, B.18). */
interface ExecApprovalDto {
  id: string;
  action: string;
  status: string;
  risk: string;
  reason: string | null;
  decided_by: string | null;
  created_at: string;
  ledger_code: string | null;
  task_code: string | null;
  title: string | null;
}

/**
 * Approvals queue (plan §7/§8 panel): a human decides pending operations.
 *
 * The exec rows are shown in the ledger's own language — the code of the
 * decision or the question, and the task it belongs to — because "a human
 * decides" is only useful if the human can see WHAT they are deciding.
 */
@Component({
  selector: 'page-approvals',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, UiButton, UiPage],
  template: `
    <ui-page data-testid="approvals" [title]="i18n.instant('approvals.title')">
      <ul class="ui-list" data-testid="approval-list">
        @for (a of items(); track a.id) {
          <li data-testid="approval-row">
            <span>{{ a.action }} · {{ a.risk }} · {{ a.status }}</span>
            <button type="button" ui-button variant="primary" (click)="decide(a.id, 'approved')" [disabled]="busy()" data-testid="approval-approve">
              {{ i18n.instant('approvals.approve') }}
            </button>
            <button type="button" ui-button variant="destructive" (click)="decide(a.id, 'rejected')" [disabled]="busy()" data-testid="approval-reject">
              {{ i18n.instant('approvals.reject') }}
            </button>
          </li>
        } @empty {
          <li data-testid="approval-empty">{{ i18n.instant('approvals.empty') }}</li>
        }
      </ul>
      <h2 data-testid="exec-approvals-title">{{ i18n.instant('approvals.ledger.title') }}</h2>
      <ul class="ui-list" data-testid="exec-approval-list">
        @for (a of execItems(); track a.id) {
          <li data-testid="exec-approval-row">
            <span>
              {{ kindLabel(a.action) }}
              <span data-testid="exec-approval-code">{{ a.ledger_code ?? '' }}</span>
              @if (a.task_code) {
                <span data-testid="exec-approval-task">{{ a.task_code }}</span>
              }
              · {{ a.status }}
            </span>
            @if (a.status === 'pending') {
              <button type="button" ui-button variant="primary" (click)="decide(a.id, 'approved')" [disabled]="busy()" data-testid="exec-approval-approve">
                {{ i18n.instant('approvals.approve') }}
              </button>
              <button type="button" ui-button variant="destructive" (click)="decide(a.id, 'rejected')" [disabled]="busy()" data-testid="exec-approval-reject">
                {{ i18n.instant('approvals.reject') }}
              </button>
            }
          </li>
        } @empty {
          <li data-testid="exec-approval-empty">{{ i18n.instant('approvals.ledger.empty') }}</li>
        }
      </ul>
      @if (error()) {
        <p class="ui-error" role="alert" data-testid="approval-error">{{ error() }}</p>
      }
    </ui-page>
  `,
})
export class ApprovalsPage implements OnInit {
  private readonly api = inject(ApiClient);
  readonly i18n = inject(I18n);
  readonly items = signal<ApprovalDto[]>([]);
  readonly execItems = signal<ExecApprovalDto[]>([]);
  readonly error = signal('');
  private readonly toast = inject(UiToastService);
  readonly busy = signal(false);

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    this.error.set('');
    try {
      this.items.set((await this.api.get<{ items: ApprovalDto[] }>('/api/v1/approvals')).items);
    } catch (err) {
      this.error.set((err as Error).message);
    }
    try {
      const exec = await this.api.get<{ items: ExecApprovalDto[] }>('/api/v1/exec/approvals');
      this.execItems.set(exec.items);
    } catch (err) {
      // The ledger's rows are extra: a project without the exec module on
      // must still show the ordinary queue.
      this.execItems.set([]);
      if (!this.error()) this.error.set((err as Error).message);
    }
  }

  /** The kind of the row in the human's language, or its raw name. */
  kindLabel(action: string): string {
    const key = `approvals.kind.${action}`;
    const label = this.i18n.instant(key);
    return label === key ? action : label;
  }

  async decide(id: string, decision: 'approved' | 'rejected'): Promise<void> {
    this.error.set('');
    this.busy.set(true);
    try {
      await this.api.post(`/api/v1/approvals/${id}/decide`, { decision });
      this.toast.ok(`#${id.slice(0, 8)} ${decision}`);
      await this.load();
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
