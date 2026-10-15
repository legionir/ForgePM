import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { UiButton } from '../ui/button';
import { UiPage } from '../ui/page';
import { UiToastService } from '../ui/toast';

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
  imports: [FormsModule, UiButton, UiPage],
  template: `
    <ui-page data-testid="ai-providers" [title]="i18n.instant('ai_providers.title')">
      <form (ngSubmit)="create()" data-testid="provider-new">
        <label>{{ i18n.instant('common.name') }}<input name="n" [(ngModel)]="name" required data-testid="provider-name" /></label>
        <label>{{ i18n.instant('common.kind') }}
          <select name="k" [(ngModel)]="kind" data-testid="provider-kind">
            @for (k of kinds; track k) {
              <option [value]="k">{{ k }}</option>
            }
          </select>
        </label>
        <label>{{ i18n.instant('ai_providers.api_key') }}<input name="key" type="password" [(ngModel)]="apiKey" data-testid="provider-key" /></label>
        <button type="submit" ui-button variant="primary" [loading]="busy()" data-testid="provider-create">{{ i18n.instant('common.create') }}</button>
      </form>
      <ul class="ui-list" data-testid="provider-list">
        @for (p of providers(); track p.id) {
          <li data-testid="provider-row">
            {{ p.name }} · {{ p.kind }} · {{ p.enabled ? 'on' : 'off' }} · last4 {{ p.key_last4 ?? '—' }}
            <button type="button" ui-button (click)="test(p.id)" data-testid="provider-test">{{ i18n.instant('ai_providers.test') }}</button>
          </li>
        } @empty {
          <li data-testid="provider-empty">{{ i18n.instant('common.empty') }}</li>
        }
      </ul>
      @if (msg()) {
        <p class="ui-ok" data-testid="provider-msg">{{ msg() }}</p>
      }
      @if (error()) {
        <p class="ui-error" role="alert" data-testid="provider-error">{{ error() }}</p>
      }
    </ui-page>
  `,
})
export class AiProvidersPage implements OnInit {
  private readonly api = inject(ApiClient);
  readonly i18n = inject(I18n);

  readonly providers = signal<ProviderDto[]>([]);
  readonly msg = signal('');
  readonly error = signal('');
  readonly busy = signal(false);
  private readonly toast = inject(UiToastService);
  name = 'fake-1';
  kind = 'fake';
  apiKey = '';
  readonly kinds = ['fake', 'openai', 'anthropic', 'openai_compatible'];

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    this.error.set('');
    try {
      this.providers.set((await this.api.get<{ items: ProviderDto[] }>('/api/v1/ai-providers')).items);
    } catch (err) {
      this.error.set((err as Error).message);
    }
  }

  async create(): Promise<void> {
    this.error.set('');
    this.busy.set(true);
    try {
      const body: { name: string; kind: string; api_key?: string } = { name: this.name, kind: this.kind };
      if (this.apiKey) body.api_key = this.apiKey;
      await this.api.post('/api/v1/ai-providers', body);
      this.apiKey = '';
      this.toast.ok(this.i18n.instant('common.saved'));
      await this.load();
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  async test(id: string): Promise<void> {
    this.error.set('');
    this.busy.set(true);
    try {
      const res = await this.api.post<{ ok: boolean }>(`/api/v1/ai-providers/${id}/test`);
      this.msg.set(res.ok ? 'ok' : 'failed');
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
