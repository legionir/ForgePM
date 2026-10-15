import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Session } from './session';
import { I18n } from './i18n';
import { Tokens } from './ui/tokens';
import { UiShell } from './ui/shell';
import { UiToasts } from './ui/toast';
import { UiButton } from './ui/button';

/**
 * Root: auth gating + router outlet. The authenticated chrome (header/nav/
 * who-area/toasts/main) lives in `ui/shell` (plan §4); login/setup render
 * into a centered main. Theme resolution starts here so pre-login screens
 * follow the stored choice too (index.html applies classes pre-paint).
 */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, UiShell, UiToasts, UiButton],
  template: `
    @if (session.me()) {
      <ui-shell><router-outlet /></ui-shell>
    } @else if (session.ready()) {
      <div class="ui-auth-tools">
        <button type="button" ui-button variant="ghost" size="sm" (click)="tokens.cycle()" [attr.aria-label]="i18n.instant('theme.label')">
          {{ i18n.instant('theme.label') }}
        </button>
        <button type="button" ui-button variant="ghost" size="sm" (click)="i18n.toggle()" data-testid="lang-toggle">
          {{ i18n.instant('shell.lang') }}
        </button>
      </div>
      <main class="ui-center"><router-outlet /></main>
      <ui-toasts />
    }
  `,
})
export class App implements OnInit {
  readonly session = inject(Session);
  readonly i18n = inject(I18n);
  readonly tokens = inject(Tokens);

  constructor() {
    this.tokens.init();
  }

  async ngOnInit(): Promise<void> {
    await this.session.refresh();
  }
}
