import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Session } from './session';

/** Authenticated shell: nav + logout; redirects anonymous users to /auth. */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    @if (session.me(); as me) {
      <header class="shell">
        <nav data-testid="nav" aria-label="Primary">
          <a routerLink="/projects" routerLinkActive="active" data-testid="nav-projects">Projects</a>
          <a routerLink="/api-keys" routerLinkActive="active" data-testid="nav-api-keys">API Keys</a>
        </nav>
        <div class="who">
          <span data-testid="who">{{ me.user?.display_name }}</span>
          <button type="button" (click)="logout()" data-testid="logout">Sign out</button>
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
  private readonly router = inject(Router);

  async ngOnInit(): Promise<void> {
    await this.session.refresh();
  }

  async logout(): Promise<void> {
    await this.session.logout();
    await this.router.navigate(['/login']);
  }
}
