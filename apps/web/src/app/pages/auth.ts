import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Session } from '../session';

/**
 * Login page with a first-run "create organization + admin" mode (plan §5.2).
 * /auth/setup is CONFLICT-on-second-run, so we detect the message and offer a
 * direct sign-in link — the one-time setup flow the panel must expose.
 */
@Component({
  selector: 'page-auth',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <section class="auth" data-testid="auth">
      @if (!mode()) {
        <h1>ForgePM — first-run setup</h1>
        <p class="hint">Create the organization and admin user.</p>
        <label>Organization<input name="org" [(ngModel)]="org" /></label>
        <label>Admin name<input name="dname" [(ngModel)]="dname" /></label>
        <label>Email<input name="email" type="email" [(ngModel)]="email" /></label>
        <label>Password<input name="password" type="password" [(ngModel)]="password" /></label>
        <button type="button" data-testid="setup-submit" (click)="submitSetup()">Setup</button>
        <p class="link">
          <a data-testid="go-login" href="javascript:void(0)" (click)="mode.set('login')">Sign in instead</a>
        </p>
      } @else {
        <h1>Sign in</h1>
        <label>Email<input name="email" type="email" [(ngModel)]="email" /></label>
        <label>Password<input name="password" type="password" [(ngModel)]="password" /></label>
        <button type="button" data-testid="login-submit" (click)="submitLogin()">Sign in</button>
        <p class="link">
          <a data-testid="go-setup" href="javascript:void(0)" (click)="mode.set(null)">First run? Setup</a>
        </p>
      }
      @if (error()) {
        <p class="error" data-testid="error">{{ error() }}</p>
      }
    </section>
  `,
})
export class AuthPage {
  private readonly session = inject(Session);
  private readonly router = inject(Router);

  readonly mode = signal<'login' | null>(null);
  email = 'admin@example.com';
  password = 'changeme-1234';
  org = '';
  dname = '';
  readonly error = signal('');

  async submitSetup(): Promise<void> {
    this.error.set('');
    try {
      await this.session.setup({
        organization_name: this.org,
        admin_email: this.email,
        admin_password: this.password,
        admin_display_name: this.dname,
      });
      await this.router.navigate(['/projects']);
    } catch (err) {
      // Already configured → this is a returning user, show login instead.
      if ((err as Error).message.toLowerCase().includes('already')) this.mode.set('login');
      else this.error.set((err as Error).message);
    }
  }

  async submitLogin(): Promise<void> {
    this.error.set('');
    try {
      await this.session.login(this.email, this.password);
      await this.router.navigate(['/projects']);
    } catch (err) {
      this.error.set((err as Error).message);
    }
  }
}
