import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { Session } from '../session';
import { I18n } from '../i18n';
import { ProjectContext } from '../project-context';
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
  icon: string;
}

interface NavGroup {
  id: string;
  labelKey: string;
  items: NavItem[];
  /** Project-scoped groups are hidden until a project is created/selected. */
  scoped: boolean;
}

/**
 * Single source of the primary IA (plan §6.1), ordered as the workflow runs:
 * 1. Workspace — always available (pick / create a project)
 * 2. Project   — plan → build → review; only shown with an active project
 * 3. Governance & Platform — organisation-wide, never project-gated
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'workspace',
    labelKey: 'nav.group.workspace',
    scoped: false,
    items: [{ link: '/projects', labelKey: 'nav.projects', testid: 'nav-projects', icon: 'folder' }],
  },
  {
    id: 'project',
    labelKey: 'nav.group.project',
    scoped: true,
    items: [
      { link: '/dashboard', labelKey: 'nav.dashboard', testid: 'nav-dashboard', icon: 'dashboard' },
      { link: '/features', labelKey: 'nav.features', testid: 'nav-features', icon: 'layers' },
      { link: '/work-items', labelKey: 'nav.work_items', testid: 'nav-work-items', icon: 'list' },
      { link: '/planner', labelKey: 'nav.planner', testid: 'nav-planner', icon: 'compass' },
    ],
  },
  {
    id: 'delivery',
    labelKey: 'nav.group.delivery',
    scoped: true,
    items: [
      { link: '/exec-tasks', labelKey: 'exec.tasks', testid: 'nav-exec-tasks', icon: 'check-square' },
      { link: '/exec-policy', labelKey: 'exec.policy_title', testid: 'nav-exec-policy', icon: 'shield' },
      { link: '/reviews', labelKey: 'nav.reviews', testid: 'nav-reviews', icon: 'eye' },
      { link: '/github', labelKey: 'nav.github', testid: 'nav-github', icon: 'git-branch' },
    ],
  },
  {
    id: 'governance',
    labelKey: 'nav.group.governance',
    scoped: false,
    items: [{ link: '/approvals', labelKey: 'nav.approvals', testid: 'nav-approvals', icon: 'check-circle' }],
  },
  {
    id: 'platform',
    labelKey: 'nav.group.platform',
    scoped: false,
    items: [
      { link: '/ai-providers', labelKey: 'nav.ai_providers', testid: 'nav-ai-providers', icon: 'cpu' },
      { link: '/mcp', labelKey: 'nav.mcp', testid: 'nav-mcp', icon: 'plug' },
      { link: '/api-keys', labelKey: 'nav.api_keys', testid: 'nav-api-keys', icon: 'key' },
      { link: '/settings', labelKey: 'nav.settings', testid: 'nav-settings', icon: 'sliders' },
      { link: '/system', labelKey: 'nav.system', testid: 'nav-system', icon: 'server' },
      { link: '/admin', labelKey: 'nav.audit', testid: 'nav-admin', icon: 'file-text' },
    ],
  },
];

/**
 * App shell (plan §4, P2-1): a grouped sidebar + slim top bar. Project-scoped
 * groups only exist in the DOM while a project is selected, so users are
 * walked step by step: create/select a project → plan → build → review.
 * Below --bp-md the sidebar becomes an off-canvas drawer (RSP-001); the
 * burger toggles `.nav-open` on the shell root.
 */
@Component({
  selector: 'ui-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive, UiNavCurrent, UiButton, UiToasts, UiAvatar, UiIcon, UiCommandPalette],
  template: `
    <div class="ui-app ui-shell" [class.nav-open]="navOpen()">
      <aside class="ui-sidebar" id="primary-nav-wrap">
        <a class="ui-brand" routerLink="/" (click)="closeNav()">
          <span class="ui-brand-logo"><ui-icon name="zap" [size]="16" [inline]="false" /></span>
          <span class="ui-brand-name">ForgePM</span>
        </a>

        <div class="ui-sidebar-project" data-testid="shell-project">
          @if (ctx.hasProject()) {
            <label class="ui-sidebar-project-label">
              <span>{{ i18n.instant('shell.current_project') }}</span>
              <select [value]="ctx.selectedId() ?? ''" (change)="pickProject($event)" [attr.aria-label]="i18n.instant('shell.current_project')" data-testid="shell-project-select">
                @for (p of activeProjects(); track p.id) {
                  <option [value]="p.id">{{ p.name }} ({{ p.key }})</option>
                }
              </select>
            </label>
          } @else if (ctx.loaded()) {
            <a class="ui-sidebar-cta" routerLink="/projects" (click)="closeNav()" data-testid="shell-create-project">
              <ui-icon name="plus" [size]="14" /> {{ i18n.instant('shell.create_project') }}
            </a>
            <p class="ui-sidebar-hint">{{ i18n.instant('shell.locked_hint') }}</p>
          }
        </div>

        <nav id="primary-nav" data-testid="nav" aria-label="Primary">
          @for (g of visibleGroups(); track g.id) {
            <div class="ui-nav-group" [attr.data-group]="g.id">
              <p class="ui-nav-label">{{ i18n.instant(g.labelKey) }}</p>
              @for (item of g.items; track item.link) {
                <a [routerLink]="item.link" routerLinkActive="active" [attr.data-testid]="item.testid" (click)="closeNav()">
                  <ui-icon [name]="item.icon" [size]="16" [inline]="false" />
                  <span>{{ i18n.instant(item.labelKey) }}</span>
                </a>
              }
            </div>
          }
        </nav>
      </aside>
      <button type="button" class="ui-scrim" tabindex="-1" aria-hidden="true" (click)="closeNav()"></button>

      <div class="ui-main-col">
        <header class="ui-topbar">
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
          <button type="button" class="ui-search-trigger" (click)="palette.show()" [attr.aria-label]="i18n.instant('command.title')" data-testid="search-trigger">
            <ui-icon name="search" [size]="15" [inline]="false" />
            <span>{{ i18n.instant('command.placeholder') }}</span>
            <kbd>⌘K</kbd>
          </button>
          <div class="ui-who">
            <button type="button" ui-button variant="ghost" size="sm" (click)="tokens.cycle()" data-testid="theme-toggle" [attr.aria-label]="i18n.instant('theme.label')" [title]="themeLabel()">
              <ui-icon [name]="themeIcon()" [size]="16" [inline]="false" />
              <span class="ui-hide-sm">{{ themeLabel() }}</span>
            </button>
            <button type="button" ui-button variant="ghost" size="sm" (click)="i18n.toggle()" data-testid="lang-toggle">{{ i18n.instant('shell.lang') }}</button>
            <span class="ui-who-user" data-testid="who">
              <ui-avatar [name]="session.me()?.user?.display_name ?? ''" size="sm" />
              <span class="ui-hide-sm">{{ session.me()?.user?.display_name }}</span>
            </span>
            <button type="button" ui-button variant="ghost" size="sm" (click)="logout()" data-testid="logout" [attr.aria-label]="i18n.instant('shell.signout')">
              <ui-icon name="log-out" [size]="16" [inline]="false" />
              <span class="ui-hide-sm">{{ i18n.instant('shell.signout') }}</span>
            </button>
          </div>
        </header>
        <main><ng-content /></main>
      </div>
    </div>
    <ui-command-palette />
    <ui-toasts />
  `,
})
export class UiShell {
  readonly session = inject(Session);
  readonly i18n = inject(I18n);
  readonly tokens = inject(Tokens);
  readonly palette = inject(CommandPalette);
  readonly ctx = inject(ProjectContext);
  private readonly router = inject(Router);

  readonly navOpen = signal(false);
  readonly groups = NAV_GROUPS;
  /** Flat list (all groups) kept for tests/palette; the template renders `visibleGroups`. */
  readonly nav: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

  readonly visibleGroups = computed(() => NAV_GROUPS.filter((g) => !g.scoped || this.ctx.hasProject()));
  readonly activeProjects = computed(() => this.ctx.projects().filter((p) => p.status === 'active'));
  readonly themeIcon = computed(() => (this.tokens.theme() === 'dark' ? 'moon' : this.tokens.theme() === 'light' ? 'sun' : 'palette'));

  constructor() {
    void this.ctx.ensureLoaded();
    this.router.events.subscribe((e) => {
      if (e instanceof NavigationEnd) this.navOpen.set(false);
    });
    // Command palette entries (P7-4): visible nav destinations + theme/lang.
    effect(() => {
      const cmds: UiCommand[] = this.visibleGroups()
        .flatMap((g) => g.items)
        .map((n) => ({
          id: `nav:${n.link}`,
          labelKey: n.labelKey,
          run: () => void this.router.navigate([n.link]),
        }));
      cmds.push(
        { id: 'theme:cycle', labelKey: 'command.theme', run: () => this.tokens.cycle() },
        { id: 'lang:toggle', labelKey: 'command.language', run: () => this.i18n.toggle() },
        { id: 'nav:/design-system', labelKey: 'command.design_system', run: () => void this.router.navigate(['/design-system']) },
      );
      if (this.ctx.hasProject()) {
        cmds.push({ id: 'new:item', labelKey: 'command.new_item', run: () => void this.router.navigate(['/work-items'], { queryParams: { new: 1 } }) });
      }
      this.palette.register(cmds);
    });
  }

  themeLabel(): string {
    return this.i18n.instant(`theme.${this.tokens.theme()}`);
  }

  closeNav(): void {
    this.navOpen.set(false);
  }

  pickProject(ev: Event): void {
    const id = (ev.target as HTMLSelectElement).value;
    if (id) this.ctx.select(id);
  }

  async logout(): Promise<void> {
    await this.session.logout();
    await this.router.navigate(['/login']);
  }
}
