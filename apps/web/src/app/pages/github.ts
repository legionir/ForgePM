import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { UiButton } from '../ui/button';
import { UiBadge } from '../ui/badge';
import { UiIcon } from '../ui/icon';
import { UiControl, UiField } from '../ui/field';
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
 * The repository list shows which repositories are connected to the selected
 * project: a green link icon connects, a red unlink icon disconnects.
 */
@Component({
  selector: 'page-github',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, UiButton, UiBadge, UiIcon, UiField, UiControl, UiPage],
  template: `
    <ui-page data-testid="github" [title]="i18n.instant('github.title')">
      @if (!status()?.enabled) {
        <p class="ui-banner ui-banner--warning" data-testid="gh-stub-banner" role="alert">
          GitHub integration not configured — stub active (B-008). Review output returns 422 until configured.
        </p>
      }
      <section class="ui-card">
      <header class="ui-card-head"><h2><ui-icon name="key" [size]="18" [inline]="false" /> {{ i18n.instant('github.title') }}</h2></header>
      <form class="ui-stack" (ngSubmit)="save()" data-testid="gh-config">
        <label>{{ i18n.instant('github.app_id') }}<input name="appId" [(ngModel)]="appId" data-testid="gh-app-id" /></label>
        <label>{{ i18n.instant('github.private_key') }}
          <textarea name="pk" [(ngModel)]="privateKey" rows="3" data-testid="gh-private-key"></textarea>
        </label>
        <label>{{ i18n.instant('github.webhook_secret') }}<input name="ws" [(ngModel)]="webhookSecret" data-testid="gh-webhook-secret" /></label>
        <button type="submit" ui-button variant="primary" [disabled]="busy()" data-testid="gh-save">{{ i18n.instant('github.save') }}</button>
      </form>
      </section>

      @if (status()?.enabled) {
        <section class="ui-card">
        <header class="ui-card-head">
          <div class="ui-card-title">
            <h2><ui-icon name="git-branch" [size]="18" [inline]="false" /> {{ i18n.instant('github.repos') }}</h2>
            <ui-badge size="sm" data-testid="gh-count">{{ filtered().length }}</ui-badge>
            <ui-badge size="sm" variant="success" icon="link" data-testid="gh-connected-count">{{ connectedCount() }}</ui-badge>
          </div>
        </header>
        <ui-field class="ui-search-field" [label]="i18n.instant('github.search')">
          <input uiControl type="search" name="q" [ngModel]="query()" (ngModelChange)="query.set($event)" [placeholder]="i18n.instant('github.search_placeholder')" data-testid="gh-search" />
        </ui-field>
        <ul class="ui-list" data-testid="gh-repos">
          @for (r of filtered(); track r.id) {
            <li data-testid="gh-repo-row" [class.ui-repo-connected]="isConnected(r.id)">
              <span class="ui-provider-line">
                <ui-icon name="git-branch" [size]="14" [inline]="false" />
                {{ r.full_name }}
                @if (isConnected(r.id)) {
                  <ui-badge size="sm" status="active" [label]="i18n.instant('github.connected')" data-testid="gh-connected" />
                }
              </span>
              @if (isConnected(r.id)) {
                <button
                  type="button"
                  class="ui-link-btn ui-link-btn--off"
                  (click)="unlink(r.id)"
                  [disabled]="busy()"
                  [attr.aria-label]="i18n.instant('github.unlink') + ' — ' + r.full_name"
                  [title]="i18n.instant('github.unlink')"
                  data-testid="gh-unlink"
                >
                  <ui-icon name="unlink" [size]="16" [inline]="false" />
                </button>
              } @else {
                <button
                  type="button"
                  class="ui-link-btn ui-link-btn--on"
                  (click)="link(r.id)"
                  [disabled]="busy()"
                  [attr.aria-label]="i18n.instant('github.link') + ' — ' + r.full_name"
                  [title]="i18n.instant('github.link')"
                  data-testid="gh-link"
                >
                  <ui-icon name="link" [size]="16" [inline]="false" />
                </button>
              }
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
    </ui-page>
  `,
})
export class GithubPage implements OnInit {
  private readonly api = inject(ApiClient);
  readonly i18n = inject(I18n);
  readonly ctx = inject(ProjectContext);

  readonly status = signal<StatusDto | null>(null);
  readonly repos = signal<RepoDto[]>([]);
  readonly connected = signal<Set<string>>(new Set());
  readonly query = signal('');
  readonly msg = signal('');
  readonly busy = signal(false);
  private readonly toast = inject(UiToastService);
  appId = '';
  privateKey = '';
  webhookSecret = '';

  /** Every typed character narrows the list. */
  readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    return q ? this.repos().filter((r) => r.full_name.toLowerCase().includes(q)) : this.repos();
  });
  readonly connectedCount = computed(() => this.repos().filter((r) => this.connected().has(r.id)).length);

  isConnected(id: string): boolean {
    return this.connected().has(id);
  }

  async ngOnInit(): Promise<void> {
    await this.ctx.ensureLoaded();
    await this.load();
  }

  async load(): Promise<void> {
    try {
      this.status.set(await this.api.get<StatusDto>('/api/v1/integrations/github/status'));
      if (this.status()?.enabled) {
        this.repos.set((await this.api.get<{ items: RepoDto[] }>('/api/v1/repositories')).items);
        await this.loadConnected();
      }
    } catch (err) {
      // Module off => 503 MODULE_DISABLED: the disabled hint branch handles it.
      const e = err as { status?: number; message?: string };
      if (e.status !== 503 && !/MODULE_DISABLED/i.test(e.message ?? '')) {
        this.toast.error(e.message ?? 'error');
      }
    }
  }

  private async loadConnected(): Promise<void> {
    const pid = this.ctx.selectedId();
    if (!pid) return;
    const res = await this.api.get<{ items: RepoDto[] }>(`/api/v1/projects/${pid}/repositories`);
    this.connected.set(new Set(res.items.map((r) => r.id)));
  }

  async save(): Promise<void> {
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
      this.toast.error((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  async link(repositoryId: string): Promise<void> {
    this.busy.set(true);
    try {
      await this.api.post(`/api/v1/projects/${this.ctx.selectedId()}/repositories`, { repository_id: repositoryId });
      this.msg.set('linked');
      await this.loadConnected();
    } catch (err) {
      this.toast.error((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  async unlink(repositoryId: string): Promise<void> {
    this.busy.set(true);
    try {
      await this.api.send('DELETE', `/api/v1/projects/${this.ctx.selectedId()}/repositories/${repositoryId}`);
      this.msg.set('unlinked');
      await this.loadConnected();
    } catch (err) {
      this.toast.error((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
