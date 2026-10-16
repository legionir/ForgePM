import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { UiButton } from '../ui/button';
import { UiField, UiControl } from '../ui/field';
import { UiPage } from '../ui/page';
import { UiToastService } from '../ui/toast';

interface ProviderDto {
  id: string;
  name: string;
  kind: string;
  base_url: string | null;
  default_model: string | null;
  enabled: boolean;
  key_last4: string | null;
}

/**
 * AI Providers (plan §7 panel): configure endpoint / API key / model per
 * provider, with the model list fetched automatically from the provider's
 * `{base_url}/models` endpoint (POST /ai-providers/models — the backend
 * proxies the call so the key never leaves the server; for saved providers
 * the stored encrypted key is reused). Providers can be edited (PUT) and
 * connection-tested with a real models round-trip. `fake` is the
 * deterministic offline kind the flagship E2E uses (plan §7 "fake (قطعی،
 * برای تست‌ها)"); real keys are encrypted at rest and only last4 is shown.
 */
@Component({
  selector: 'page-ai-providers',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, UiButton, UiField, UiControl, UiPage],
  template: `
    <ui-page data-testid="ai-providers" [title]="i18n.instant('ai_providers.title')">
      <p class="ui-dt-empty" data-testid="provider-tokens">{{ i18n.instant('ai_providers.used_today') }}: {{ tokensToday() }}</p>

      @if (editId(); as id) {
        <p class="ui-dt-empty">{{ i18n.instant('ai_providers.editing', { name: editingName() }) }}</p>
      }

      <form (ngSubmit)="save()" data-testid="provider-new">
        <ui-field [label]="i18n.instant('common.name')" required>
          <input uiControl name="n" [(ngModel)]="name" required data-testid="provider-name" />
        </ui-field>
        <ui-field [label]="i18n.instant('common.kind')">
          <select uiControl name="k" [(ngModel)]="kind" (change)="onKindChange()" data-testid="provider-kind">
            @for (k of kinds; track k) {
              <option [value]="k">{{ k }}</option>
            }
          </select>
        </ui-field>
        <ui-field [label]="i18n.instant('ai_providers.base_url')" [hint]="baseUrlHint()">
          <input uiControl name="u" [(ngModel)]="baseUrl" (change)="fetchModels(true)" data-testid="provider-base-url" placeholder="https://api.openai.com/v1" />
        </ui-field>
        <ui-field [label]="i18n.instant('ai_providers.api_key')" [hint]="keyHint()">
          <input uiControl name="key" type="password" [(ngModel)]="apiKey" (change)="fetchModels(true)" autocomplete="off" data-testid="provider-key" />
        </ui-field>
        <ui-field [label]="i18n.instant('ai_providers.model')">
          <span class="ui-model-row">
            <input uiControl name="m" [(ngModel)]="model" [attr.list]="'provider-model-options'" data-testid="provider-model" />
            <button
              type="button"
              ui-button
              variant="ghost"
              size="sm"
              [loading]="modelsLoading()"
              [attr.aria-label]="i18n.instant('ai_providers.fetch_models')"
              [title]="i18n.instant('ai_providers.fetch_models')"
              (click)="fetchModels()"
              data-testid="provider-fetch-models"
            >{{ i18n.instant('ai_providers.fetch_models') }}</button>
          </span>
          @if (models().length) {
            <span class="ui-dt-empty" data-testid="provider-model-count">{{ models().length }} {{ i18n.instant('ai_providers.models_found') }}</span>
          } @else if (modelsTried() && !modelsLoading()) {
            <span class="ui-dt-empty" data-testid="provider-models-none">{{ i18n.instant('ai_providers.models_none') }}</span>
          }
          <datalist id="provider-model-options">
            @for (m of models(); track m) {
              <option [value]="m"></option>
            }
          </datalist>
        </ui-field>
        <button type="submit" ui-button variant="primary" [loading]="busy()" data-testid="provider-create">
          {{ editId() ? i18n.instant('common.save') : i18n.instant('common.create') }}
        </button>
        @if (editId()) {
          <button type="button" ui-button (click)="cancelEdit()" data-testid="provider-cancel">{{ i18n.instant('common.cancel') }}</button>
        }
      </form>

      <ul class="ui-list" data-testid="provider-list">
        @for (p of providers(); track p.id) {
          <li data-testid="provider-row">
            <span>{{ p.name }} · {{ p.kind }}@if (p.default_model) {<span> · {{ p.default_model }}</span>} · {{ p.enabled ? 'on' : 'off' }} · last4 {{ p.key_last4 ?? '—' }}</span>
            <span class="ui-row-actions">
              <button type="button" ui-button size="sm" (click)="startEdit(p)" data-testid="provider-edit">{{ i18n.instant('common.edit') }}</button>
              <button type="button" ui-button size="sm" (click)="test(p.id)" data-testid="provider-test">{{ i18n.instant('ai_providers.test') }}</button>
            </span>
          </li>
        } @empty {
          <li data-testid="provider-empty">{{ i18n.instant('common.empty') }}</li>
        }
      </ul>
      @if (error()) {
        <p class="ui-error" role="alert" data-testid="provider-error">{{ error() }}</p>
      }
    </ui-page>
  `,
  styles: [
    `
      .ui-model-row {
        display: flex;
        gap: var(--space-2);
        align-items: center;
      }
      .ui-model-row input {
        flex: 1;
      }
      .ui-row-actions {
        display: inline-flex;
        gap: var(--space-2);
      }
    `,
  ],
})
export class AiProvidersPage implements OnInit {
  private readonly api = inject(ApiClient);
  readonly i18n = inject(I18n);
  private readonly toast = inject(UiToastService);

  readonly providers = signal<ProviderDto[]>([]);
  readonly error = signal('');
  readonly busy = signal(false);
  readonly tokensToday = signal(0);
  readonly models = signal<string[]>([]);
  readonly modelsLoading = signal(false);
  readonly modelsTried = signal(false);
  readonly editId = signal<string | null>(null);
  readonly editingName = computed(() => this.providers().find((p) => p.id === this.editId())?.name ?? '');

  name = 'fake-1';
  kind = 'fake';
  baseUrl = '';
  apiKey = '';
  model = '';
  readonly kinds = ['fake', 'openai', 'anthropic', 'openai_compatible'];

  readonly baseUrlHint = () => (this.kind === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1');
  readonly keyHint = () => {
    const p = this.providers().find((x) => x.id === this.editId());
    return p?.key_last4 ? `…${p.key_last4}` : '';
  };

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    this.error.set('');
    try {
      const res = await this.api.get<{ items: ProviderDto[]; used_tokens_today: number }>('/api/v1/ai-providers');
      this.providers.set(res.items);
      this.tokensToday.set(res.used_tokens_today);
    } catch (err) {
      this.error.set((err as Error).message);
    }
  }

  /** Auto-fetch the model list (endpoint + key). `quiet` swallows errors. */
  async fetchModels(quiet = false): Promise<void> {
    const body: { kind: string; base_url?: string; api_key?: string; provider_id?: string } = { kind: this.kind };
    if (this.baseUrl) body.base_url = this.baseUrl;
    if (this.apiKey) body.api_key = this.apiKey;
    else if (this.editId()) body.provider_id = this.editId()!;
    if (this.kind !== 'fake' && !body.api_key && !body.provider_id) return;
    this.modelsLoading.set(true);
    try {
      const res = await this.api.post<{ items: string[] }>('/api/v1/ai-providers/models', body);
      this.models.set(res.items);
      this.modelsTried.set(true);
    } catch (err) {
      this.models.set([]);
      this.modelsTried.set(true);
      if (!quiet) this.toast.error((err as Error).message);
    } finally {
      this.modelsLoading.set(false);
    }
  }

  /** Changing kind refreshes defaults and re-fetches automatically. */
  onKindChange(): void {
    this.baseUrl = '';
    this.models.set([]);
    this.modelsTried.set(false);
    if (this.kind !== 'fake' && (this.apiKey || this.editId())) void this.fetchModels(true);
    if (this.kind === 'fake') void this.fetchModels(true);
  }

  startEdit(p: ProviderDto): void {
    this.editId.set(p.id);
    this.name = p.name;
    this.kind = p.kind;
    this.baseUrl = p.base_url ?? '';
    this.model = p.default_model ?? '';
    this.apiKey = '';
    this.error.set('');
    // saved key is reused server-side -> the dropdown fills without retyping
    void this.fetchModels(true);
  }

  cancelEdit(): void {
    this.editId.set(null);
    this.resetForm();
  }

  private resetForm(): void {
    this.name = 'fake-1';
    this.kind = 'fake';
    this.baseUrl = '';
    this.apiKey = '';
    this.model = '';
    this.models.set([]);
    this.modelsTried.set(false);
  }

  async save(): Promise<void> {
    this.error.set('');
    this.busy.set(true);
    try {
      const body: { name: string; kind: string; base_url?: string; api_key?: string; default_model?: string } = {
        name: this.name,
        kind: this.kind,
      };
      if (this.baseUrl) body.base_url = this.baseUrl;
      if (this.apiKey) body.api_key = this.apiKey;
      if (this.model) body.default_model = this.model;
      if (this.editId()) await this.api.put(`/api/v1/ai-providers/${this.editId()}`, body);
      else await this.api.post('/api/v1/ai-providers', body);
      this.toast.ok(this.i18n.instant('common.saved'));
      this.editId.set(null);
      this.resetForm();
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
      if (res.ok) this.toast.ok('ok');
      else this.toast.error('failed');
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
