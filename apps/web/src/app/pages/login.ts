import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Session } from '../session';
import { I18n } from '../i18n';
import { UiButton } from '../ui/button';
import { UiControl, UiField } from '../ui/field';
import { UiIcon } from '../ui/icon';

/**
 * Sign in (httpOnly cookie + CSRF, plan §5.3) — auth template: brand row,
 * ui-field inputs with leading icons, one full-width primary action, error
 * line, footer link. Theme/lang toggles live in the auth branch of app.ts.
 */
@Component({
  selector: 'page-login',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, UiButton, UiField, UiControl, UiIcon],
  template: `
    <section class="ui-auth" data-testid="auth">
      <div class="ui-auth-brand" aria-hidden="true">
        <span class="ui-auth-logo"><ui-icon name="command" [size]="20" [inline]="false" /></span>
        <span class="ui-auth-wordmark">ForgePM</span>
      </div>
      <h1>{{ i18n.instant('login.title') }}</h1>
      <form (ngSubmit)="submit()">
        <ui-field [label]="i18n.instant('common.email')">
          <span class="ui-input-icon">
            <ui-icon name="mail" [size]="16" />
            <input uiControl data-testid="field-email" name="email" type="email" autocomplete="email" [(ngModel)]="email" required />
          </span>
        </ui-field>
        <ui-field [label]="i18n.instant('common.password')">
          <span class="ui-input-icon">
            <ui-icon name="lock" [size]="16" />
            <input uiControl data-testid="field-password" name="password" type="password" autocomplete="current-password" [(ngModel)]="password" required />
          </span>
        </ui-field>
        <button type="submit" ui-button variant="primary" class="ui-auth-submit" [loading]="busy()" data-testid="login-submit">
          {{ i18n.instant('login.title') }}
        </button>
      </form>
      @if (error()) {
        <p class="ui-error" role="alert" data-testid="error">{{ error() }}</p>
      }
      <p class="ui-auth-footer">
        <a routerLink="/setup" data-testid="go-setup">{{ i18n.instant('login.first_run') }}</a>
      </p>
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
  readonly busy = signal(false);

  async submit(): Promise<void> {
    this.error.set('');
    this.busy.set(true);
    try {
      await this.session.login(this.email, this.password);
      await this.router.navigate(['/']);
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
