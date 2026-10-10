import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Session } from './session';
import { I18n } from './i18n';

/**
 * Authenticated shell: nav + logout + language toggle (§11 RTL/fa/en).
 * Optional-module pages (github, reviews) are always listed but each renders
 * activation guidance while its module is disabled — matching §11 "منوها و
 * صفحه‌های مربوط فقط راهنمای فعال‌سازی را نشان می‌دهند". Enabling happens at
 * runtime from the System page; nav needs no reload because pages re-fetch.
 */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    @if (session.me(); as me) {
      <header class="shell">
        <nav data-testid="nav" aria-label="Primary">
          <a routerLink="/projects" routerLinkActive="active" data-testid="nav-projects">{{ i18n.instant('nav.projects') }}</a>
          <a routerLink="/work-items" routerLinkActive="active" data-testid="nav-work-items">{{ i18n.instant('nav.work_items') }}</a>
          <a routerLink="/features" routerLinkActive="active" data-testid="nav-features">{{ i18n.instant('nav.features') }}</a>
          <a routerLink="/planner" routerLinkActive="active" data-testid="nav-planner">{{ i18n.instant('nav.planner') }}</a>
          <a routerLink="/ai-providers" routerLinkActive="active" data-testid="nav-ai-providers">{{ i18n.instant('nav.ai_providers') }}</a>
          <a routerLink="/approvals" routerLinkActive="active" data-testid="nav-approvals">{{ i18n.instant('nav.approvals') }}</a>
          <a routerLink="/reviews" routerLinkActive="active" data-testid="nav-reviews">{{ i18n.instant('nav.reviews') }}</a>
          <a routerLink="/github" routerLinkActive="active" data-testid="nav-github">{{ i18n.instant('nav.github') }}</a>
          <a routerLink="/mcp" routerLinkActive="active" data-testid="nav-mcp">{{ i18n.instant('nav.mcp') }}</a>
          <a routerLink="/settings" routerLinkActive="active" data-testid="nav-settings">{{ i18n.instant('nav.settings') }}</a>
          <a routerLink="/system" routerLinkActive="active" data-testid="nav-system">{{ i18n.instant('nav.system') }}</a>
          <a routerLink="/api-keys" routerLinkActive="active" data-testid="nav-api-keys">{{ i18n.instant('nav.api_keys') }}</a>
          <a routerLink="/admin" routerLinkActive="active" data-testid="nav-admin">{{ i18n.instant('nav.audit') }}</a>
        </nav>
        <div class="who">
          <button type="button" (click)="i18n.toggle()" data-testid="lang-toggle">{{ i18n.instant('shell.lang') }}</button>
          <span data-testid="who">{{ me.user?.display_name }}</span>
          <button type="button" (click)="logout()" data-testid="logout">{{ i18n.instant('shell.signout') }}</button>
        </div>
      </header>
      <main><router-outlet /></main>
    } @else if (session.ready()) {
      <main class="center"><router-outlet /></main>
    }
  `,
})
export class App implements OnInit {
  readonly session = inject(Session);
  readonly i18n = inject(I18n);
  private readonly router = inject(Router);

  async ngOnInit(): Promise<void> {
    await this.session.refresh();
  }

  async logout(): Promise<void> {
    await this.session.logout();
    await this.router.navigate(['/login']);
  }
}
