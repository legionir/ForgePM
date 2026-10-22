import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { UiButton } from '../ui/button';
import { UiBadge } from '../ui/badge';
import { UiIcon } from '../ui/icon';
import { UiModal } from '../ui/modal';
import { UiDataTable, UiTableColumn, UiTableRowAction } from '../ui/data-table';
import { UiPage } from '../ui/page';
import { UiToastService } from '../ui/toast';
import { camelCase } from '../ui/logic';

interface ApiKeyDto {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expires_at: string | null;
  revoked_at: string | null;
}

/**
 * Scopes a key may carry. `ledger:decide` is deliberately absent: it is human-only (D-040) and
 * the API refuses to grant it to any key.
 */
export const KEY_SCOPES = ['read', 'write', 'plan', 'plan_approve', 'plan_apply', 'review', 'github', 'admin', 'ledger:read', 'ledger:write'] as const;

/** Active, Revoked or Expired — the state a key is really in. */
export function keyStatus(k: Pick<ApiKeyDto, 'revoked_at' | 'expires_at'>, now = Date.now()): 'active' | 'revoked' | 'expired' {
  if (k.revoked_at) return 'revoked';
  if (k.expires_at && Date.parse(k.expires_at) <= now) return 'expired';
  return 'active';
}

const KEY_STATUS = {
  active: { variant: 'success', icon: 'check-circle' },
  revoked: { variant: 'error', icon: 'x-circle' },
  expired: { variant: 'warning', icon: 'clock' },
} as const;

/**
 * API keys (plan §5.10, §11 acceptance: "raw key visible only at creation").
 * The list shows prefix, status and scopes; the raw key is rendered once from the
 * creation response and never stored in the signal afterwards. A key can carry several
 * scopes; revoked keys are hidden unless asked for, and revoking asks for confirmation.
 */
@Component({
  selector: 'page-api-keys',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, UiButton, UiBadge, UiIcon, UiModal, UiPage, UiDataTable],
  template: `
    <ui-page data-testid="api-keys" [title]="i18n.instant('nav.api_keys')">
      <section class="ui-card">
      <header class="ui-card-head">
        <h2><ui-icon name="key" [size]="18" [inline]="false" /> {{ i18n.instant('common.create_key') }}</h2>
      </header>
      <form class="ui-stack" (ngSubmit)="create()">
        <label
          >{{ i18n.instant('common.name') }}<input name="name" [(ngModel)]="name" required data-testid="apikey-name"
        /></label>
        <fieldset class="ui-scopes" data-testid="apikey-scopes">
          <legend>{{ i18n.instant('api_keys.scopes') }}</legend>
          @for (s of scopeChoices; track s) {
            <label class="ui-scope-choice">
              <input type="checkbox" [name]="'scope-' + s" [checked]="isTicked(s)" (change)="toggleScope(s)" [attr.data-testid]="'apikey-scope-' + s" />
              {{ label(s) }}
            </label>
          }
        </fieldset>
        @if (scopes().length === 0) {
          <p class="ui-field-error" role="alert" data-testid="apikey-scope-error">{{ i18n.instant('api_keys.scopes_required') }}</p>
        }
        <div>
          <button type="submit" ui-button variant="primary" [disabled]="scopes().length === 0" data-testid="apikey-create">
            {{ i18n.instant('common.create_key') }}
          </button>
        </div>
      </form>
      @if (rawKey()) {
        <p class="ui-raw" data-testid="apikey-raw">{{ rawKey() }}</p>
      }
      </section>

      <section class="ui-card">
        <header class="ui-card-head">
          <div class="ui-card-title">
            <h2><ui-icon name="lock" [size]="18" [inline]="false" /> {{ i18n.instant('nav.api_keys') }}</h2>
            <ui-badge size="sm" data-testid="apikey-count">{{ visible().length }}</ui-badge>
          </div>
          <label class="ui-switch-row">
            <span>{{ i18n.instant('api_keys.show_revoked') }}</span>
            <button
              type="button"
              role="switch"
              class="ui-switch"
              [attr.aria-checked]="showRevoked()"
              [attr.aria-label]="i18n.instant('api_keys.show_revoked')"
              (click)="showRevoked.set(!showRevoked())"
              data-testid="apikey-show-revoked"
            ><span class="ui-switch-thumb"></span></button>
          </label>
        </header>
        <ui-data-table
          testid="api-keys-list"
          emptyTestid="api-keys-empty"
          [columns]="keyColumns"
          [rows]="visible()"
          [trackKey]="keyOf"
          [loading]="loading()"
          [emptyMessage]="i18n.instant('api_keys.empty')"
          [rowTestid]="rowTestid"
          [pageSize]="25"
          [actions]="keyActions"
        />
      </section>

      <ui-modal [open]="!!revoking()" (openChange)="$event || cancelRevoke()" [title]="i18n.instant('api_keys.revoke_title')" icon="alert">
        @if (revoking(); as k) {
          <p data-testid="revoke-text">{{ i18n.instant('api_keys.revoke_confirm', { name: k.name, prefix: k.prefix }) }}</p>
        }
        <div uiModalFooter>
          <button type="button" ui-button variant="ghost" (click)="cancelRevoke()" data-testid="revoke-cancel">{{ i18n.instant('common.cancel') }}</button>
          <button type="button" ui-button variant="destructive" [loading]="busy()" (click)="confirmRevoke()" data-testid="revoke-confirm">
            {{ i18n.instant('common.revoke') }}
          </button>
        </div>
      </ui-modal>
    </ui-page>
  `,
})
export class ApiKeysPage implements OnInit {
  private readonly toast = inject(UiToastService);
  private readonly api = inject(ApiClient);
  readonly i18n = inject(I18n);

  readonly keys = signal<ApiKeyDto[]>([]);
  readonly rawKey = signal('');
  readonly busy = signal(false);
  readonly loading = signal(true);
  readonly showRevoked = signal(false);
  readonly revoking = signal<ApiKeyDto | null>(null);
  readonly scopes = signal<string[]>(['read']);
  readonly scopeChoices = KEY_SCOPES;
  name = '';

  readonly visible = computed(() => (this.showRevoked() ? this.keys() : this.keys().filter((k) => keyStatus(k) !== 'revoked')));

  readonly keyOf = (k: ApiKeyDto): string => k.id;
  readonly rowTestid = (): string => 'apikey-row';

  label(scope: string): string {
    return camelCase(scope.replace(':', '_'));
  }

  isTicked(scope: string): boolean {
    return this.scopes().includes(scope);
  }

  toggleScope(scope: string): void {
    this.scopes.update((l) => (l.includes(scope) ? l.filter((s) => s !== scope) : [...l, scope]));
  }

  get keyColumns(): UiTableColumn<ApiKeyDto>[] {
    return [
      { key: 'name', label: this.i18n.instant('common.name'), sortable: true },
      { key: 'prefix', label: this.i18n.instant('api_keys.prefix') },
      {
        key: 'status',
        label: this.i18n.instant('api_keys.status'),
        testid: 'apikey-status',
        badge: (k) => {
          const st = keyStatus(k);
          return { text: st, variant: KEY_STATUS[st].variant, icon: KEY_STATUS[st].icon };
        },
      },
      { key: 'scopes', label: this.i18n.instant('api_keys.scopes'), testid: 'apikey-scope-chips', chips: (k) => k.scopes.map((s) => this.label(s)) },
    ];
  }

  get keyActions(): UiTableRowAction<ApiKeyDto>[] {
    return [
      {
        label: this.i18n.instant('common.revoke'),
        testid: 'apikey-revoke',
        destructive: true,
        when: (k) => keyStatus(k) !== 'revoked',
        run: (k: ApiKeyDto) => this.revoking.set(k),
      },
    ];
  }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      const res = await this.api.get<{ items: ApiKeyDto[] }>('/api/v1/api-keys');
      this.keys.set(res.items);
    } finally {
      this.loading.set(false);
    }
  }

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  async create(): Promise<void> {
    if (this.scopes().length === 0) return;
    this.rawKey.set('');
    try {
      const res = await this.api.post<{ api_key: ApiKeyDto; raw_key: string }>('/api/v1/api-keys', {
        name: this.name,
        scopes: this.scopes(),
      });
      this.rawKey.set(res.raw_key); // shown exactly once — the creation response
      this.name = '';
      this.scopes.set(['read']);
      await this.load();
    } catch (err) {
      this.toast.error((err as Error).message);
    }
  }

  cancelRevoke(): void {
    this.revoking.set(null);
  }

  async confirmRevoke(): Promise<void> {
    const k = this.revoking();
    if (!k) return;
    this.busy.set(true);
    try {
      await this.api.send('DELETE', `/api/v1/api-keys/${k.id}`);
      this.revoking.set(null);
      this.toast.ok(this.i18n.instant('api_keys.revoked_done', { name: k.name }));
      await this.load();
    } catch (err) {
      this.toast.error((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
