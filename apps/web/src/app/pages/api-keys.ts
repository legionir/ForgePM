import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { UiButton } from '../ui/button';

interface ApiKeyDto {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
}

/**
 * API keys (plan §5.10, §11 acceptance: "raw key visible only at creation").
 * The list shows prefix + scopes; the raw key is rendered once from the
 * creation response and never stored in the signal afterwards.
 */
@Component({
  selector: 'page-api-keys',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, UiButton],
  template: `
    <section data-testid="api-keys">
      <h1>{{ i18n.instant('nav.api_keys') }}</h1>
      <form class="ui-new" (ngSubmit)="create()">
        <label>{{ i18n.instant('common.name') }}<input name="name" [(ngModel)]="name" required data-testid="apikey-name" /></label>
        <label>Scope<select name="scope" [(ngModel)]="scope">
          <option value="read">read</option>
          <option value="write">write</option>
          <option value="admin">admin</option>
        </select></label>
        <button type="submit" ui-button variant="primary" data-testid="apikey-create">{{ i18n.instant('common.create_key') }}</button>
      </form>
      @if (rawKey()) {
        <p class="ui-raw" data-testid="apikey-raw">{{ rawKey() }}</p>
      }
      @if (error()) {
        <p class="ui-error" data-testid="apikey-error">{{ error() }}</p>
      }
      <ul class="ui-list">
        @for (k of keys(); track k.id) {
          <li>
            <span>{{ k.name }} · {{ k.prefix }} · {{ k.scopes.join(',') }}</span>
            <button type="button" ui-button variant="destructive" (click)="revoke(k.id)" data-testid="apikey-revoke">{{ i18n.instant('common.revoke') }}</button>
          </li>
        } @empty {
          <li data-testid="api-keys-empty">{{ i18n.instant('api_keys.empty') }}</li>
        }
      </ul>
    </section>
  `,
})
export class ApiKeysPage implements OnInit {
  private readonly api = inject(ApiClient);
  readonly i18n = inject(I18n);

  readonly keys = signal<ApiKeyDto[]>([]);
  readonly rawKey = signal('');
  readonly error = signal('');
  name = '';
  scope = 'read';

  async load(): Promise<void> {
    const res = await this.api.get<{ items: ApiKeyDto[] }>('/api/v1/api-keys');
    this.keys.set(res.items);
  }

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  async create(): Promise<void> {
    this.error.set('');
    this.rawKey.set('');
    try {
      const res = await this.api.post<{ api_key: ApiKeyDto; raw_key: string }>('/api/v1/api-keys', {
        name: this.name,
        scopes: [this.scope],
      });
      this.rawKey.set(res.raw_key); // shown exactly once — the creation response
      this.name = '';
      await this.load();
    } catch (err) {
      this.error.set((err as Error).message);
    }
  }

  async revoke(id: string): Promise<void> {
    await this.api.send('DELETE', `/api/v1/api-keys/${id}`);
    await this.load();
  }
}
