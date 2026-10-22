import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { UiIcon } from './icon';
import { camelCase, statusMeta } from './logic';

export type UiBadgeVariant = 'default' | 'success' | 'warning' | 'error' | 'info';
export type UiBadgeSize = 'sm' | 'md';

/**
 * Badge (plan §3 `ui/badge`): state/priority/label pill used by lists, the
 * board cards and detail pages (PLATFORM_PARITY 3.2).
 *
 * Plain use projects its content (counts, labels). With `status` set the badge
 * resolves its own variant and icon from the value and shows the label in
 * CamelCase (`in_progress` → `InProgress`); `label` overrides the shown text and
 * `variant`/`icon` still win when given explicitly.
 */
@Component({
  selector: 'ui-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiIcon],
  template: `
    @if (iconName()) {
      <ui-icon [name]="iconName()" [size]="12" [inline]="false" />
    }
    @if (status()) {
      <span class="ui-badge-text">{{ text() }}</span>
    } @else {
      <ng-content />
    }
  `,
  host: {
    class: 'ui-badge',
    '[class.ui-badge--success]': 'tone() === "success"',
    '[class.ui-badge--warning]': 'tone() === "warning"',
    '[class.ui-badge--error]': 'tone() === "error"',
    '[class.ui-badge--info]': 'tone() === "info"',
    '[class.ui-badge--sm]': 'size() === "sm"',
  },
})
export class UiBadge {
  readonly variant = input<UiBadgeVariant | null>(null);
  readonly size = input<UiBadgeSize>('md');
  readonly icon = input('');
  readonly status = input('');
  readonly label = input('');

  readonly tone = computed<UiBadgeVariant>(() => this.variant() ?? (this.status() ? statusMeta(this.status()).variant : 'default'));
  readonly iconName = computed(() => this.icon() || (this.status() ? statusMeta(this.status()).icon : ''));
  readonly text = computed(() => camelCase(this.label() || this.status()));
}
