import { ChangeDetectionStrategy, Component, booleanAttribute, input, output } from '@angular/core';

/**
 * Empty state (plan §3 `ui/empty-state`): icon + message + optional CTA.
 * Every list/table/search shows this instead of silent blank space (CMP-002).
 */
@Component({
  selector: 'ui-empty-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="ui-empty-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="12" cy="12" r="9" stroke-dasharray="4 3" />
        <path d="M8 13a4 4 0 0 1 8 0" stroke-linecap="round" />
      </svg>
    </span>
    <p class="ui-empty-message">{{ message() }}</p>
    @if (actionText()) {
      <button type="button" class="ui-btn ui-btn--secondary ui-btn--sm" (click)="action.emit()">
        {{ actionText() }}
      </button>
    }
  `,
  host: { class: 'ui-empty' },
})
export class UiEmptyState {
  readonly message = input('');
  readonly actionText = input('');
  readonly action = output<void>();
  readonly compact = input(false, { transform: booleanAttribute });
}
