import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { UiButton } from '../ui/button';
import { UiToastService } from '../ui/toast';
import { UiPage } from '../ui/page';
import { ProjectContext } from '../project-context';

interface RepoDto {
  id: string;
  full_name: string;
  external_id: string;
}
interface StatusDto {
  app_id_set: boolean;
  private_key_set: boolean;
  webhook_secret_set: boolean;
  enabled: boolean;
}

/**
 * Integrations ← GitHub (plan §9 panel). Secret entry via the panel (§3b-1.5:
 * env only bootstraps, DB/panel is the source of truth). With the module off,
 * the page shows activation guidance only (§11) — enabling happens in
 * Settings → Modules at runtime and appears here without a hard reload.
 */
@Component({
  selector: 'page-github',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, UiButton, UiPage],
  template: `
    <ui-page data-testid="github" [title]="i18n.instant('github.title')">
      @if (!status()?.enabled) {
        <p class="ui-banner ui-banner--warning" data-testid="gh-stub-banner" role="alert">
          GitHub integration not configured — stub active (B-008). Review output returns 422 until configured.
        </p>
      }
      <section class="ui-card">
      <header class="ui-card-head"><h2>{{ i18n.instant('github.title') }}</h2></header>
      <form class="ui-stack" (ngSubmit)="save()" data-testid="gh-config">
        <label>{{ i18n.instant('github.app_id') }}<input name="appId" [(ngModel)]="appId" data-testid="gh-app-id" /></label>
        <label>{{ i18n.instant('github.private_key') }}
          <textarea name="pk" [(ngModel)]="privateKey" rows="3" data-testid="gh-private-key"></textarea>
        </label>
        <label>{{ i18n.instant('github.webhook_secret') }}<input name="ws" [(ngModel)]="webhookSecret" data-testid="gh-webhook-secret" /></label>
        <button type="submit" ui-button variant="primary" [disabled]="busy()" data-testid="gh-save">{{ i18n.instant('github.save') }}</button>
      </form>
      @if (status(); as s) {
        <p data-testid="gh-status">
          {{ i18n.instant('github.status') }}: app={{ s.app_id_set }} key={{ s.private_key_set }} hook={{
          s.webhook_secret_set }} enabled={{ s.enabled }}
        </p>
      }
      </section>

      @if (status()?.enabled) {
        <section class="ui-card">
        <header class="ui-card-head"><h2>{{ i18n.instant('github.repos') }}</h2></header>
        <ul class="ui-list" data-testid="gh-repos">
          @for (r of repos(); track r.id) {
            <li data-testid="gh-repo-row">
              {{ r.full_name }}
              <button type="button" ui-button (click)="link(r.id)" [disabled]="busy()" data-testid="gh-link">
                {{ i18n.instant('github.link') }}
              </button>
            </li>
          } @empty {
            <li data-testid="gh-repos-empty">{{ i18n.instant('common.empty') }}</li>
          }
        </ul>
        </section>
      } @else {
        <p class="ui-hint" data-testid="gh-disabled">
          {{ i18n.instant('github.disabled') }} — {{ i18n.instant('common.disabled_hint') }}
        </p>
      }
      @if (msg()) {
        <p class="ui-ok" data-testid="gh-msg">{{ msg() }}</p>
      }
      @if (error()) {
        <p class="ui-error" role="alert" data-testid="gh-error">{{ error() }}</p>
      }
    </ui-page>
  `,
})
export class GithubPage implements OnInit {
  private readonly api = inject(ApiClient);
  readonly i18n = inject(I18n);
  readonly ctx = inject(ProjectContext);

  readonly status = signal<StatusDto | null>(null);
  readonly repos = signal<RepoDto[]>([]);
  readonly msg = signal('');
  readonly error = signal('');
  readonly busy = signal(false);
  private readonly toast = inject(UiToastService);
  appId = '';
  privateKey = '';
  webhookSecret = '';

  async ngOnInit(): Promise<void> {
    await this.ctx.ensureLoaded();
    await this.load();
  }

  async load(): Promise<void> {
    this.error.set('');
    try {
      this.status.set(await this.api.get<StatusDto>('/api/v1/integrations/github/status'));
      if (this.status()?.enabled) {
        this.repos.set((await this.api.get<{ items: RepoDto[] }>('/api/v1/repositories')).items);
      }
    } catch (err) {
      // Module off => 503 MODULE_DISABLED: the disabled hint branch handles it.
      const e = err as { status?: number; message?: string };
      if (e.status !== 503 && !/MODULE_DISABLED/i.test(e.message ?? '')) {
        this.error.set(e.message ?? 'error');
      }
    }
  }

  async save(): Promise<void> {
    this.error.set('');
    this.busy.set(true);
    try {
      const body: { app_id?: string; app_private_key?: string; webhook_secret?: string } = {};
      if (this.appId) body.app_id = this.appId;
      if (this.privateKey) body.app_private_key = this.privateKey;
      if (this.webhookSecret) body.webhook_secret = this.webhookSecret;
      const res = await this.api.post<{ configured: string[] }>('/api/v1/integrations/github/config', body);
      this.msg.set(`stored: ${res.configured.join(', ')}`);
      this.toast.ok(`stored: ${res.configured.join(', ')}`);
      this.privateKey = '';
      this.webhookSecret = '';
      await this.load();
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  async link(repositoryId: string): Promise<void> {
    this.error.set('');
    this.busy.set(true);
    try {
      await this.api.post(`/api/v1/projects/${this.ctx.selectedId()}/repositories`, { repository_id: repositoryId });
      this.msg.set('linked');
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
