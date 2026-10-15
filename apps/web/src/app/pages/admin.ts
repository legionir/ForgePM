import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { UiPage } from '../ui/page';

interface AuditDto {
  id: string;
  actor_type: string;
  action: string;
  resource_type: string;
  created_at: string;
}
interface UserDto {
  id: string;
  email: string;
  display_name: string;
  locale: string;
}

/**
 * Audit log + Users & roles management (§11: "Users، API Keys، Audit، Jobs،
 * System Health"). Both are admin-gated reads; mutations go through the same
 * REST services the panel is built against (no direct DB).
 */
@Component({
  selector: 'page-admin',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, UiPage],
  template: `
    <ui-page data-testid="admin" [title]="i18n.instant('users.title')">
      <table class="ui-table" data-testid="user-list">
        <thead>
          <tr>
            <th>{{ i18n.instant('common.email') }}</th>
            <th>{{ i18n.instant('users.role') }}</th>
          </tr>
        </thead>
        <tbody>
          @for (u of users(); track u.id) {
            <tr data-testid="user-row">
              <td>{{ u.email }}</td>
              <td>{{ role(u.id) }}</td>
            </tr>
          } @empty {
            <tr>
              <td colspan="2" data-testid="user-empty">{{ i18n.instant('common.empty') }}</td>
            </tr>
          }
        </tbody>
      </table>

      <h2>{{ i18n.instant('audit.title') }}</h2>
      <table class="ui-table" data-testid="audit-list">
        <thead>
          <tr>
            <th>{{ i18n.instant('audit.action') }}</th>
            <th>{{ i18n.instant('audit.actor') }}</th>
            <th>{{ i18n.instant('audit.resource') }}</th>
          </tr>
        </thead>
        <tbody>
          @for (e of audit(); track e.id) {
            <tr data-testid="audit-row">
              <td>{{ e.action }}</td>
              <td>{{ e.actor_type }}</td>
              <td>{{ e.resource_type }}</td>
            </tr>
          } @empty {
            <tr>
              <td colspan="3" data-testid="audit-empty">{{ i18n.instant('common.empty') }}</td>
            </tr>
          }
        </tbody>
      </table>
    </ui-page>
  `,
})
export class AdminPage implements OnInit {
  private readonly api = inject(ApiClient);
  readonly i18n = inject(I18n);

  readonly users = signal<UserDto[]>([]);
  readonly audit = signal<AuditDto[]>([]);
  readonly memberships = signal<Record<string, string>>({});

  async ngOnInit(): Promise<void> {
    const [u, m, a] = await Promise.all([
      this.api.get<{ items: UserDto[] }>('/api/v1/users'),
      this.api.get<{ items: { user_id: string; role: string }[] }>('/api/v1/memberships'),
      this.api.get<{ items: AuditDto[] }>('/api/v1/audit'),
    ]);
    this.users.set(u.items);
    this.audit.set(a.items);
    this.memberships.set(Object.fromEntries(m.items.map((x) => [x.user_id, x.role])));
  }

  role(userId: string): string {
    return this.memberships()[userId] ?? '—';
  }
}
