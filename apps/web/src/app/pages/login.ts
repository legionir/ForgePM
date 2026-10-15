import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Session } from '../session';
import { I18n } from '../i18n';
import { UiButton } from '../ui/button';

/** Sign in with an existing session (httpOnly cookie + CSRF) (plan §5.3). */
@Component({
  selector: 'page-login',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, UiButton],
  template: `
    <section class="ui-auth" data-testid="auth">
      <h1>{{ i18n.instant('login.title') }}</h1>
      <label>{{ i18n.instant('common.email') }}<input data-testid="field-email" name="email" type="email" [(ngModel)]="email" /></label>
      <label>{{ i18n.instant('common.password') }}<input data-testid="field-password" name="password" type="password" [(ngModel)]="password" /></label>
      <button type="button" ui-button data-testid="login-submit" (click)="submit()">{{ i18n.instant('login.title') }}</button>
      <p><a data-testid="go-setup" routerLink="/setup">{{ i18n.instant('login.first_run') }}</a></p>
      @if (error()) {
        <p class="ui-error" data-testid="error">{{ error() }}</p>
      }
    </section>
  `,
})
export class LoginPage {
  readonly i18n = inject(I18n);
  private readonly session = inject(Session);
  private readonly router = inject(Router);

  email = '';
  password = '';
  readonly error = signal('');

  async submit(): Promise<void> {
    this.error.set('');
    try {
      await this.session.login(this.email, this.password);
      await this.router.navigate(['/projects']);
    } catch (err) {
      this.error.set((err as Error).message);
    }
  }
}
