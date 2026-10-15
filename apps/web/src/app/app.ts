import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Session } from './session';
import { Tokens } from './ui/tokens';
import { UiShell } from './ui/shell';
import { UiToasts } from './ui/toast';

/**
 * Root: auth gating + router outlet. The authenticated chrome (header/nav/
 * who-area/toasts/main) lives in `ui/shell` (plan §4); login/setup render
 * into a centered main. Theme resolution starts here so pre-login screens
 * follow the stored choice too (index.html applies classes pre-paint).
 */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, UiShell, UiToasts],
  template: `
    @if (session.me()) {
      <ui-shell><router-outlet /></ui-shell>
    } @else if (session.ready()) {
      <main class="ui-center"><router-outlet /></main>
      <ui-toasts />
    }
  `,
})
export class App implements OnInit {
  readonly session = inject(Session);
  private readonly tokens = inject(Tokens);

  constructor() {
    this.tokens.init();
  }

  async ngOnInit(): Promise<void> {
    await this.session.refresh();
  }
}
