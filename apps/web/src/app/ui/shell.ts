import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { Session } from '../session';
import { I18n } from '../i18n';
import { Tokens } from './tokens';
import { UiButton } from './button';
import { UiToasts } from './toast';
import { UiAvatar } from './avatar';
import { UiIcon } from './icon';
import { CommandPalette, UiCommand, UiCommandPalette } from './command-palette';
import { UiNavCurrent } from './nav-current';

interface NavItem {
  link: string;
  labelKey: string;
  testid: string;
}

/**
 * App shell (plan §4, P2-1): owns header/nav/who-area/toasts; pages supply
 * inner content via ng-content. Nav collapses to a drawer below --bp-md
 * (RSP-001): the burger button toggles `.nav-open` on the header.
 */
@Component({
  selector: 'ui-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive, UiNavCurrent, UiButton, UiToasts, UiAvatar, UiIcon, UiCommandPalette],
  template: `
    <header class="ui-shell" [class.nav-open]="navOpen()">
      <button
        type="button"
        ui-button
        variant="ghost"
        size="sm"
        class="ui-nav-burger"
        [attr.aria-expanded]="navOpen()"
        aria-controls="primary-nav"
        [attr.aria-label]="i18n.instant('shell.menu')"
        (click)="navOpen.set(!navOpen())"
        data-testid="nav-toggle"
      >
        <ui-icon name="menu" [size]="18" [inline]="false" />
      </button>
      <nav id="primary-nav" data-testid="nav" aria-label="Primary">
        @for (item of nav; track item.link) {
          <a [routerLink]="item.link" routerLinkActive="active" [attr.data-testid]="item.testid">
            {{ i18n.instant(item.labelKey) }}
          </a>
        }
      </nav>
      <div class="ui-who">
        <button type="button" ui-button variant="ghost" size="sm" (click)="tokens.cycle()" data-testid="theme-toggle" [attr.aria-label]="i18n.instant('theme.label')">
          {{ themeLabel() }}
        </button>
        <button type="button" ui-button variant="ghost" size="sm" (click)="i18n.toggle()" data-testid="lang-toggle">{{ i18n.instant('shell.lang') }}</button>
        <span class="ui-who-user" data-testid="who">
          <ui-avatar [name]="session.me()?.user?.display_name ?? ''" size="sm" />
          {{ session.me()?.user?.display_name }}
        </span>
        <button type="button" ui-button variant="ghost" size="sm" (click)="logout()" data-testid="logout">{{ i18n.instant('shell.signout') }}</button>
      </div>
    </header>
    <main><ng-content /></main>
    <ui-command-palette />
    <ui-toasts />
  `,
})
export class UiShell {
  readonly session = inject(Session);
  readonly i18n = inject(I18n);
  readonly tokens = inject(Tokens);
  readonly palette = inject(CommandPalette);
  private readonly router = inject(Router);

  readonly navOpen = signal(false);

  constructor() {
    // Command palette entries (P7-4): every nav destination + theme/lang.
    const cmds: UiCommand[] = this.nav.map((n) => ({
      id: `nav:${n.link}`,
      labelKey: n.labelKey,
      run: () => void this.router.navigate([n.link]),
    }));
    cmds.push(
      { id: 'theme:cycle', labelKey: 'command.theme', run: () => this.tokens.cycle() },
      { id: 'lang:toggle', labelKey: 'command.language', run: () => this.i18n.toggle() },
      { id: 'nav:/design-system', labelKey: 'command.design_system', run: () => void this.router.navigate(['/design-system']) },
      { id: 'new:item', labelKey: 'command.new_item', run: () => void this.router.navigate(['/work-items'], { queryParams: { new: 1 } }) },
    );
    this.palette.register(cmds);
  }

  /** Single source of the primary IA (plan §6.1); order = group order. */
  readonly nav: NavItem[] = [
    { link: '/projects', labelKey: 'nav.projects', testid: 'nav-projects' },
    { link: '/work-items', labelKey: 'nav.work_items', testid: 'nav-work-items' },
    { link: '/features', labelKey: 'nav.features', testid: 'nav-features' },
    { link: '/planner', labelKey: 'nav.planner', testid: 'nav-planner' },
    { link: '/ai-providers', labelKey: 'nav.ai_providers', testid: 'nav-ai-providers' },
    { link: '/exec-tasks', labelKey: 'exec.tasks', testid: 'nav-exec-tasks' },
    { link: '/exec-policy', labelKey: 'exec.policy_title', testid: 'nav-exec-policy' },
    { link: '/approvals', labelKey: 'nav.approvals', testid: 'nav-approvals' },
    { link: '/reviews', labelKey: 'nav.reviews', testid: 'nav-reviews' },
    { link: '/github', labelKey: 'nav.github', testid: 'nav-github' },
    { link: '/mcp', labelKey: 'nav.mcp', testid: 'nav-mcp' },
    { link: '/settings', labelKey: 'nav.settings', testid: 'nav-settings' },
    { link: '/system', labelKey: 'nav.system', testid: 'nav-system' },
    { link: '/api-keys', labelKey: 'nav.api_keys', testid: 'nav-api-keys' },
    { link: '/admin', labelKey: 'nav.audit', testid: 'nav-admin' },
  ];

  themeLabel(): string {
    return this.i18n.instant(`theme.${this.tokens.theme()}`);
  }

  async logout(): Promise<void> {
    await this.session.logout();
    await this.router.navigate(['/login']);
  }
}
