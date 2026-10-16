import { ChangeDetectionStrategy, Component, Injectable, inject, signal } from '@angular/core';

export type UiToastKind = 'ok' | 'error' | 'info';

export interface UiToast {
  id: number;
  message: string;
  kind: UiToastKind;
  /** Optional inline action (e.g. Undo); keeps the toast open on click. */
  actionLabel?: string;
  action?: () => void;
}

/**
 * Toast service (plan §3 `ui/toast`, §5 success/confirmation): the ONE shared
 * confirmation mechanism (STT-002). Auto-dismisses; errors stay a bit longer.
 */
@Injectable({ providedIn: 'root' })
export class UiToastService {
  private static readonly DEFAULT_MS = 4000;
  private static readonly ERROR_MS = 7000;
  private next = 0;

  readonly toasts = signal<UiToast[]>([]);

  show(message: string, kind: UiToastKind = 'info', durationMs?: number, action?: { label: string; run: () => void }): number {
    const id = ++this.next;
    const ms = durationMs ?? (kind === 'error' ? UiToastService.ERROR_MS : UiToastService.DEFAULT_MS);
    this.toasts.update((list) => [...list, { id, message, kind, actionLabel: action?.label, action: action?.run }]);
    setTimeout(() => this.dismiss(id), ms);
    return id;
  }

  ok(message: string): number {
    return this.show(message, 'ok');
  }

  error(message: string): number {
    return this.show(message, 'error');
  }

  dismiss(id: number): void {
    this.toasts.update((list) => list.filter((t) => t.id !== id));
  }
}

/**
 * Toast host — rendered once by the shell; safe to include on every layout.
 * Announcements: ok/info are polite status, errors assertive (§5 error rule).
 */
@Component({
  selector: 'ui-toasts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (t of svc.toasts(); track t.id) {
      <div
        class="ui-toast"
        [class.ui-toast--ok]="t.kind === 'ok'"
        [class.ui-toast--error]="t.kind === 'error'"
        [attr.role]="t.kind === 'error' ? 'alert' : 'status'"
        (click)="svc.dismiss(t.id)"
      >
        {{ t.message }}
        @if (t.action) {
          <button
            type="button"
            class="ui-btn ui-btn--secondary ui-btn--sm ui-toast-action"
            (click)="$event.stopPropagation(); t.action?.(); svc.dismiss(t.id)"
          >
            {{ t.actionLabel }}
          </button>
        }
      </div>
    }
  `,
  host: { class: 'ui-toasts', 'aria-live': 'polite' },
})
export class UiToasts {
  readonly svc = inject(UiToastService);
}
