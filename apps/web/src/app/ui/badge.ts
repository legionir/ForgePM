import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type UiBadgeVariant = 'default' | 'success' | 'warning' | 'error' | 'info';
export type UiBadgeSize = 'sm' | 'md';

/**
 * Badge (plan §3 `ui/badge`): state/priority/label pill used by lists, the
 * board cards and detail pages (PLATFORM_PARITY 3.2).
 */
@Component({
  selector: 'ui-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<ng-content />`,
  host: {
    class: 'ui-badge',
    '[class.ui-badge--success]': 'variant() === "success"',
    '[class.ui-badge--warning]': 'variant() === "warning"',
    '[class.ui-badge--error]': 'variant() === "error"',
    '[class.ui-badge--info]': 'variant() === "info"',
    '[class.ui-badge--sm]': 'size() === "sm"',
  },
})
export class UiBadge {
  readonly variant = input<UiBadgeVariant>('default');
  readonly size = input<UiBadgeSize>('md');
}
