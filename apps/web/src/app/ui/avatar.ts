import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type UiAvatarSize = 'sm' | 'md' | 'lg';

/**
 * Avatar (plan §3 `ui/avatar`): initials fallback (first letters of the first
 * two words), used in nav, comments and assignee slots (PLATFORM_PARITY 3.1).
 */
@Component({
  selector: 'ui-avatar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `{{ initials() }}`,
  host: {
    class: 'ui-avatar',
    role: 'img',
    '[attr.aria-label]': 'name()',
    '[class.ui-avatar--sm]': 'size() === "sm"',
    '[class.ui-avatar--lg]': 'size() === "lg"',
  },
})
export class UiAvatar {
  readonly name = input('');
  readonly size = input<UiAvatarSize>('md');

  readonly initials = computed(() =>
    this.name()
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w.charAt(0).toUpperCase())
      .join(''),
  );
}
