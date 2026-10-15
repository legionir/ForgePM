import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type UiLoadingKind = 'lines' | 'card' | 'table' | 'button';

/**
 * Loading (plan §3 `ui/loading`): one canonical skeleton per shape — lines
 * (text), card (panel), table (grid), button (inline spinner). Skeletons
 * mirror the eventual layout (§5) and freeze under prefers-reduced-motion.
 */
@Component({
  selector: 'ui-loading',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (kind() === 'table') {
      <div class="ui-skel-table" aria-hidden="true">
        @for (_ of rows; track $index) {
          <span class="ui-skel"></span>
          <span class="ui-skel"></span>
          <span class="ui-skel"></span>
        }
      </div>
    } @else if (kind() === 'card') {
      <div class="ui-skel-card" aria-hidden="true">
        <span class="ui-skel ui-skel--w40"></span>
        <span class="ui-skel"></span>
        <span class="ui-skel ui-skel--w60"></span>
      </div>
    } @else if (kind() === 'button') {
      <span class="ui-btn-spinner" aria-hidden="true"></span>
    } @else {
      <div class="ui-skel-lines" aria-hidden="true">
        <span class="ui-skel"></span>
        <span class="ui-skel ui-skel--w60"></span>
      </div>
    }
  `,
  host: {
    class: 'ui-loading',
    '[attr.aria-busy]': 'true',
    '[attr.aria-label]': 'label()',
  },
})
export class UiLoading {
  readonly kind = input<UiLoadingKind>('lines');
  readonly label = input('Loading');
  readonly rows = [1, 2, 3];
}
