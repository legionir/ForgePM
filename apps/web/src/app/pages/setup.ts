import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Session } from '../session';
import { I18n } from '../i18n';
import { UiButton } from '../ui/button';
import { UiControl, UiField } from '../ui/field';
import { UiIcon } from '../ui/icon';
import { UiToastService } from '../ui/toast';

/** First-run setup: create the organization + admin user (plan §5.2). */
@Component({
  selector: 'page-setup',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, UiButton, UiField, UiControl, UiIcon],
  template: `
    <section class="ui-auth" data-testid="auth">
      <div class="ui-auth-brand" aria-hidden="true">
        <span class="ui-auth-logo"><ui-icon name="command" [size]="20" [inline]="false" /></span>
        <span class="ui-auth-wordmark">ForgePM</span>
      </div>
      <h1>{{ i18n.instant('setup.title') }}</h1>
      <form (ngSubmit)="submit()">
        <ui-field [label]="i18n.instant('setup.org')">
          <span class="ui-input-icon">
            <ui-icon name="building" [size]="16" />
            <input uiControl data-testid="field-org" name="org" [(ngModel)]="org" required />
          </span>
        </ui-field>
        <ui-field [label]="i18n.instant('setup.display_name')">
          <span class="ui-input-icon">
            <ui-icon name="mail" [size]="16" />
            <input uiControl data-testid="field-dname" name="dname" [(ngModel)]="dname" required />
          </span>
        </ui-field>
        <ui-field [label]="i18n.instant('common.email')">
          <span class="ui-input-icon">
            <ui-icon name="mail" [size]="16" />
            <input uiControl data-testid="field-email" name="email" type="email" autocomplete="email" [(ngModel)]="email" required />
          </span>
        </ui-field>
        <ui-field [label]="i18n.instant('common.password')">
          <span class="ui-input-icon">
            <ui-icon name="lock" [size]="16" />
            <input uiControl data-testid="field-password" name="password" type="password" autocomplete="new-password" [(ngModel)]="password" required />
          </span>
        </ui-field>
        <button type="submit" ui-button variant="primary" class="ui-auth-submit" [loading]="busy()" data-testid="setup-submit">
          {{ i18n.instant('common.create') }}
        </button>
      </form>
      <p class="ui-auth-footer">
        <a routerLink="/login" data-testid="go-login">{{ i18n.instant('login.title') }}</a>
      </p>
    </section>
  `,
})
export class SetupPage {
  private readonly toast = inject(UiToastService);
  readonly i18n = inject(I18n);
  private readonly session = inject(Session);
  private readonly router = inject(Router);

  email = '';
  password = '';
  org = '';
  dname = '';
  readonly busy = signal(false);

  async submit(): Promise<void> {
    this.busy.set(true);
    try {
      await this.session.setup({
        organization_name: this.org,
        admin_email: this.email,
        admin_password: this.password,
        admin_display_name: this.dname,
      });
      await this.router.navigate(['/projects']);
    } catch (err) {
      this.toast.error((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
