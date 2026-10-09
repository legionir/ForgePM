import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiClient } from '../api';

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
  imports: [FormsModule],
  template: `
    <section data-testid="api-keys">
      <h1>API keys</h1>
      <form class="new" (ngSubmit)="create()">
        <label>Name<input name="name" [(ngModel)]="name" required /></label>
        <label>Scope<select name="scope" [(ngModel)]="scope">
          <option value="read">read</option>
          <option value="write">write</option>
          <option value="admin">admin</option>
        </select></label>
        <button type="submit" data-testid="apikey-create">Create key</button>
      </form>
      @if (rawKey()) {
        <p class="raw" data-testid="apikey-raw">{{ rawKey() }}</p>
      }
      @if (error()) {
        <p class="error" data-testid="apikey-error">{{ error() }}</p>
      }
      <ul class="list">
        @for (k of keys(); track k.id) {
          <li>
            <span>{{ k.name }} · {{ k.prefix }} · {{ k.scopes.join(',') }}</span>
            <button type="button" class="revoke" (click)="revoke(k.id)" data-testid="apikey-revoke">Revoke</button>
          </li>
        } @empty {
          <li data-testid="api-keys-empty">No API keys yet.</li>
        }
      </ul>
    </section>
  `,
})
export class ApiKeysPage implements OnInit {
  private readonly api = inject(ApiClient);

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
