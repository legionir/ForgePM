import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Session } from '../session';

/** First-run setup: create the organization + admin user (plan §5.2). */
@Component({
  selector: 'page-setup',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <section class="auth" data-testid="auth">
      <h1>ForgePM — first-run setup</h1>
      <p class="hint">Create the organization and admin user.</p>
      <label>Organization<input data-testid="field-org" name="org" [(ngModel)]="org" /></label>
      <label>Admin name<input data-testid="field-dname" name="dname" [(ngModel)]="dname" /></label>
      <label>Email<input data-testid="field-email" name="email" type="email" [(ngModel)]="email" /></label>
      <label>Password<input data-testid="field-password" name="password" type="password" [(ngModel)]="password" /></label>
      <button type="button" data-testid="setup-submit" (click)="submit()">Setup</button>
      <p class="link"><a data-testid="go-login" routerLink="/login">Sign in instead</a></p>
      @if (error()) {
        <p class="error" data-testid="error">{{ error() }}</p>
      }
    </section>
  `,
})
export class SetupPage {
  private readonly session = inject(Session);
  private readonly router = inject(Router);

  email = '';
  password = '';
  org = '';
  dname = '';
  readonly error = signal('');

  async submit(): Promise<void> {
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
      this.error.set((err as Error).message);
    }
  }
}
