import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type UiPageVariant = 'list' | 'detail' | 'form' | 'dashboard';

/**
 * Page template (plan §4, P2-2): exactly one h1 page title with the action
 * row on the inline-end (RTL-safe), back navigation first in content flow.
 * Pages project their body; the standard shell/content spacing comes from
 * `.ui-page`. The `variant` input selects the standard page-template layout
 * (list/detail/form/dashboard). Every authenticated page wraps its content
 * in <ui-page>.
 */
@Component({
  selector: 'ui-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="ui-page-head">
      <h1>{{ title() }}</h1>
      <div class="ui-page-actions"><ng-content select="[pageActions]" /></div>
    </header>
    <ng-content />
  `,
  host: { '[class]': '"ui-page ui-page--" + variant()' },
})
export class UiPage {
  readonly title = input('');
  /** Page template variant (plan §4): standard spacing per layout kind. */
  readonly variant = input<UiPageVariant>('list');
}
