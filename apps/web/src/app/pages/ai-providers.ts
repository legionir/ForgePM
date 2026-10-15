import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiClient } from '../api';
import { I18n } from '../i18n';

interface ProviderDto {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  key_last4: string | null;
}

/**
 * AI Providers (plan §7 panel): configure / test / toggle providers. `fake` is
 * the deterministic offline kind the flagship E2E uses (plan §7 "fake (قطعی،
 * برای تست‌ها)"); real keys are encrypted at rest and only last4 is ever shown.
 */
@Component({
  selector: 'page-ai-providers',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <section data-testid="ai-providers">
      <h1>{{ i18n.instant('ai_providers.title') }}</h1>
      <form (ngSubmit)="create()" data-testid="provider-new">
        <label>{{ i18n.instant('common.name') }}<input name="n" [(ngModel)]="name" required data-testid="provider-name" /></label>
        <label>{{ i18n.instant('common.kind') }}
          <select name="k" [(ngModel)]="kind" data-testid="provider-kind">
            @for (k of kinds; track k) {
              <option [value]="k">{{ k }}</option>
            }
          </select>
        </label>
        <label>API key<input name="key" type="password" [(ngModel)]="apiKey" data-testid="provider-key" /></label>
        <button type="submit" data-testid="provider-create">{{ i18n.instant('common.create') }}</button>
      </form>
      <ul class="ui-list" data-testid="provider-list">
        @for (p of providers(); track p.id) {
          <li data-testid="provider-row">
            {{ p.name }} · {{ p.kind }} · {{ p.enabled ? 'on' : 'off' }} · last4 {{ p.key_last4 ?? '—' }}
            <button type="button" (click)="test(p.id)" data-testid="provider-test">{{ i18n.instant('ai_providers.test') }}</button>
          </li>
        } @empty {
          <li data-testid="provider-empty">{{ i18n.instant('common.empty') }}</li>
        }
      </ul>
      @if (msg()) {
        <p class="ui-ok" data-testid="provider-msg">{{ msg() }}</p>
      }
    </section>
  `,
})
export class AiProvidersPage implements OnInit {
  private readonly api = inject(ApiClient);
  readonly i18n = inject(I18n);

  readonly providers = signal<ProviderDto[]>([]);
  readonly msg = signal('');
  name = 'fake-1';
  kind = 'fake';
  apiKey = '';
  readonly kinds = ['fake', 'openai', 'anthropic', 'openai_compatible'];

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    this.providers.set((await this.api.get<{ items: ProviderDto[] }>('/api/v1/ai-providers')).items);
  }

  async create(): Promise<void> {
    const body: { name: string; kind: string; api_key?: string } = { name: this.name, kind: this.kind };
    if (this.apiKey) body.api_key = this.apiKey;
    await this.api.post('/api/v1/ai-providers', body);
    this.apiKey = '';
    await this.load();
  }

  async test(id: string): Promise<void> {
    const res = await this.api.post<{ ok: boolean }>(`/api/v1/ai-providers/${id}/test`);
    this.msg.set(res.ok ? 'ok' : 'failed');
  }
}
