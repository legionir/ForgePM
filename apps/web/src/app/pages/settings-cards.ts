import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { UiButton } from '../ui/button';
import { UiBadge } from '../ui/badge';
import { UiIcon } from '../ui/icon';
import { UiControl, UiField } from '../ui/field';
import { Tokens, type ThemeChoice } from '../ui/tokens';
import { UiToastService } from '../ui/toast';
import { CamelPipe } from '../ui/camel';

interface ModuleDto {
  name: string;
  enabled: boolean;
  registered: boolean;
}

/**
 * Module switches: the runtime on/off for github, reviews, … (plan §11).
 * Enabling a module makes its panel pages appear without a hard reload.
 */
@Component({
  selector: 'modules-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiBadge, UiIcon, CamelPipe],
  template: `
    <section class="ui-card" data-testid="modules-card">
      <header class="ui-card-head">
        <h2><ui-icon name="plug" [size]="18" [inline]="false" /> {{ i18n.instant('system.modules') }}</h2>
        <ui-badge size="sm">{{ modules().length }}</ui-badge>
      </header>
      <ul class="ui-list" data-testid="module-list">
        @for (m of modules(); track m.name) {
          <li class="ui-module-row" data-testid="module-row">
            <span class="ui-module-name">{{ m.name | camel }}</span>
            <ui-badge size="sm" [status]="m.enabled ? 'active' : 'disabled'" [label]="m.enabled ? i18n.instant('system.enabled') : i18n.instant('system.disabled')" />
            <button
              type="button"
              role="switch"
              class="ui-switch"
              [attr.aria-checked]="m.enabled"
              [attr.aria-label]="m.name"
              (click)="toggle(m)"
              [disabled]="busy()"
              data-testid="module-toggle"
            ><span class="ui-switch-thumb"></span></button>
          </li>
        }
      </ul>
    </section>
  `,
})
export class ModulesCard implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly toast = inject(UiToastService);
  readonly i18n = inject(I18n);

  readonly modules = signal<ModuleDto[]>([]);
  readonly busy = signal(false);

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    try {
      this.modules.set((await this.api.get<{ modules: ModuleDto[] }>('/api/v1/system/health')).modules);
    } catch (err) {
      this.toast.error((err as Error).message);
    }
  }

  async toggle(m: ModuleDto): Promise<void> {
    this.busy.set(true);
    try {
      await this.api.put('/api/v1/modules/' + m.name + '/enabled', { enabled: !m.enabled });
      await this.load();
    } catch (err) {
      this.toast.error((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}

/** Database backup (pg_dump) trigger. */
@Component({
  selector: 'backups-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiButton, UiIcon],
  template: `
    <section class="ui-card" data-testid="backups-card">
      <header class="ui-card-head">
        <h2><ui-icon name="archive" [size]="18" [inline]="false" /> {{ i18n.instant('system.backups') }}</h2>
      </header>
      <div>
        <button type="button" ui-button (click)="backup()" [disabled]="busy()" data-testid="backup-run">{{ i18n.instant('system.backup') }}</button>
      </div>
    </section>
  `,
})
export class BackupsCard {
  private readonly api = inject(ApiClient);
  private readonly toast = inject(UiToastService);
  readonly i18n = inject(I18n);
  readonly busy = signal(false);

  async backup(): Promise<void> {
    this.busy.set(true);
    try {
      const res = await this.api.post<{ file: string }>('/api/v1/system/backup');
      this.toast.ok(this.i18n.instant('system.backup_done', { file: res.file }));
    } catch (err) {
      this.toast.error((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}

interface GithubStatusDto {
  app_id_set: boolean;
  private_key_set: boolean;
  webhook_secret_set: boolean;
  enabled: boolean;
}

/** What is configured for the GitHub integration (the secrets themselves are entered on the GitHub page). */
@Component({
  selector: 'github-status-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiBadge, UiIcon],
  template: `
    <section class="ui-card" data-testid="github-status-card">
      <header class="ui-card-head">
        <h2><ui-icon name="git-branch" [size]="18" [inline]="false" /> {{ i18n.instant('github.status') }}</h2>
      </header>
      @if (status(); as s) {
        <ul class="ui-list" data-testid="gh-status">
          @for (row of rows(s); track row.label) {
            <li class="ui-module-row">
              <span class="ui-module-name">{{ row.label }}</span>
              <ui-badge size="sm" [status]="row.ok ? 'active' : 'disabled'" [label]="row.ok ? i18n.instant('github.configured') : i18n.instant('github.missing')" />
            </li>
          }
        </ul>
      } @else {
        <p class="ui-hint">{{ i18n.instant('common.empty') }}</p>
      }
    </section>
  `,
})
export class GithubStatusCard implements OnInit {
  private readonly api = inject(ApiClient);
  readonly i18n = inject(I18n);
  readonly status = signal<GithubStatusDto | null>(null);

  async ngOnInit(): Promise<void> {
    try {
      this.status.set(await this.api.get<GithubStatusDto>('/api/v1/integrations/github/status'));
    } catch {
      // Module off (503) or no secrets permission: the card simply stays empty.
    }
  }

  rows(s: GithubStatusDto): { label: string; ok: boolean }[] {
    return [
      { label: this.i18n.instant('github.app_id'), ok: s.app_id_set },
      { label: this.i18n.instant('github.private_key'), ok: s.private_key_set },
      { label: this.i18n.instant('github.webhook_secret'), ok: s.webhook_secret_set },
      { label: this.i18n.instant('system.modules'), ok: s.enabled },
    ];
  }
}

/** Theme and language (moved here from the header). */
@Component({
  selector: 'appearance-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, UiIcon, UiControl, UiField, CamelPipe],
  template: `
    <section class="ui-card" data-testid="appearance-card">
      <header class="ui-card-head">
        <h2><ui-icon name="palette" [size]="18" [inline]="false" /> {{ i18n.instant('settings.appearance') }}</h2>
      </header>
      <div class="ui-edit-grid">
        <ui-field [label]="i18n.instant('theme.label')">
          <select uiControl name="theme" [ngModel]="tokens.theme()" (ngModelChange)="setTheme($event)" data-testid="theme-select">
            <option value="system">{{ i18n.instant('theme.system') | camel }}</option>
            <option value="light">{{ i18n.instant('theme.light') | camel }}</option>
            <option value="dark">{{ i18n.instant('theme.dark') | camel }}</option>
          </select>
        </ui-field>
        <ui-field [label]="i18n.instant('settings.language')">
          <select uiControl name="lang" [ngModel]="i18n.lang()" (ngModelChange)="setLang($event)" data-testid="lang-select">
            <option value="en">English</option>
            <option value="fa">فارسی</option>
          </select>
        </ui-field>
      </div>
    </section>
  `,
})
export class AppearanceCard {
  readonly i18n = inject(I18n);
  readonly tokens = inject(Tokens);

  setTheme(t: ThemeChoice): void {
    this.tokens.set(t);
  }

  setLang(l: 'en' | 'fa'): void {
    this.i18n.set(l);
  }
}
