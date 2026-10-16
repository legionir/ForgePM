import { ChangeDetectionStrategy, Component, booleanAttribute, input } from '@angular/core';

export type UiButtonVariant = 'primary' | 'secondary' | 'destructive' | 'ghost';
export type UiButtonSize = 'sm' | 'md';

/**
 * Button (plan §3 `ui/button`): variants, sizes, disabled and loading states
 * while keeping the NATIVE <button> element as the host — pages write
 * `<button ui-button type="submit">` so forms, focus and e2e selectors keep
 * working (FRM-003: one primary/secondary/destructive ordering app-wide).
 * Loading implies disabled + aria-busy (STT-001 double-submit guard).
 */
@Component({
  selector: 'button[ui-button]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (loading()) {
    <span class="ui-btn-spinner" aria-hidden="true"></span>
  }<ng-content />`,
  host: {
    '[class.ui-btn]': 'true',
    '[class.ui-btn--primary]': 'variant() === "primary"',
    '[class.ui-btn--secondary]': 'variant() === "secondary"',
    '[class.ui-btn--destructive]': 'variant() === "destructive"',
    '[class.ui-btn--ghost]': 'variant() === "ghost"',
    '[class.ui-btn--sm]': 'size() === "sm"',
    '[attr.disabled]': 'disabled() || loading() ? "" : null',
    '[attr.aria-busy]': 'loading() ? "true" : null',
  },
})
export class UiButton {
  readonly variant = input<UiButtonVariant>('secondary');
  readonly size = input<UiButtonSize>('md');
  readonly disabled = input(false, { transform: booleanAttribute });
  readonly loading = input(false, { transform: booleanAttribute });
}
