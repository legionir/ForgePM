import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { UiPage } from '../ui/page';
import { UiDataTable, UiTableColumn } from '../ui/data-table';

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
  imports: [FormsModule, UiPage, UiDataTable],
  template: `
    <ui-page data-testid="admin" [title]="i18n.instant('users.title')">
      @if (error()) {
        <p class="ui-error" role="alert" data-testid="admin-error">{{ error() }}</p>
      }
      <section class="ui-card">
      <header class="ui-card-head"><h2>{{ i18n.instant('users.title') }}</h2><span class="ui-card-sub">{{ users().length }}</span></header>
      <ui-data-table
        testid="user-list"
        emptyTestid="user-empty"
        [columns]="userColumns"
        [rows]="users()"
        [trackKey]="keyOf"
        [loading]="loading()"
        [error]="error()"
        [emptyMessage]="i18n.instant('common.empty')"
        [rowTestid]="userRowTestid"
        [pageSize]="25"
      />
      </section>

      <section class="ui-card">
      <header class="ui-card-head"><h2>{{ i18n.instant('audit.title') }}</h2></header>
      <ui-data-table
        testid="audit-list"
        emptyTestid="audit-empty"
        [columns]="auditColumns"
        [rows]="audit()"
        [trackKey]="keyOf"
        [loading]="loading()"
        [error]="error()"
        [emptyMessage]="i18n.instant('common.empty')"
        [rowTestid]="auditRowTestid"
        [pageSize]="25"
      />
      </section>
    </ui-page>
  `,
})
export class AdminPage implements OnInit {
  private readonly api = inject(ApiClient);
  readonly i18n = inject(I18n);

  readonly users = signal<UserDto[]>([]);
  readonly audit = signal<AuditDto[]>([]);
  readonly memberships = signal<Record<string, string>>({});
  readonly loading = signal(true);
  readonly error = signal('');

  async ngOnInit(): Promise<void> {
    this.error.set('');
    try {
      const [u, m, a] = await Promise.all([
        this.api.get<{ items: UserDto[] }>('/api/v1/users'),
        this.api.get<{ items: { user_id: string; role: string }[] }>('/api/v1/memberships'),
        this.api.get<{ items: AuditDto[] }>('/api/v1/audit'),
      ]);
      this.users.set(u.items);
      this.audit.set(a.items);
      this.memberships.set(Object.fromEntries(m.items.map((x) => [x.user_id, x.role])));
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  role(userId: string): string {
    return this.memberships()[userId] ?? '—';
  }

  readonly keyOf = (r: { id: string }): string => r.id;
  readonly userRowTestid = (): string => 'user-row';
  readonly auditRowTestid = (): string => 'audit-row';

  get userColumns(): UiTableColumn<UserDto>[] {
    return [
      { key: 'email', label: this.i18n.instant('common.email'), sortable: true },
      { key: 'role', label: this.i18n.instant('users.role'), value: (u) => this.role(u.id) },
    ];
  }

  get auditColumns(): UiTableColumn<AuditDto>[] {
    return [
      { key: 'action', label: this.i18n.instant('audit.action'), sortable: true },
      { key: 'actor_type', label: this.i18n.instant('audit.actor') },
      { key: 'resource_type', label: this.i18n.instant('audit.resource') },
    ];
  }
}
