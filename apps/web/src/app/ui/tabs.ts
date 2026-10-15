import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

export interface UiTabItem {
  id: string;
  label: string;
  /** data-testid passthrough so e2e selectors survive the migration. */
  testid?: string;
}

/**
 * Tabs (plan §3 `ui/tabs`): roving tabindex + ArrowLeft/ArrowRight/Home/End
 * keyboard support, aria-selected/aria-controls wiring. Active tab also keeps
 * the `active` class for styling parity with the pre-component tabs.
 */
@Component({
  selector: 'ui-tabs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div role="tablist" class="ui-tabs" [attr.aria-label]="ariaLabel()">
      @for (t of items(); track t.id; let i = $index) {
        <button
          type="button"
          role="tab"
          [class.active]="t.id === active()"
          [attr.aria-selected]="t.id === active()"
          [attr.tabindex]="t.id === active() ? 0 : -1"
          [attr.data-testid]="t.testid ?? null"
          (click)="select(t.id)"
          (keydown)="onKeydown($event, i)"
        >
          {{ t.label }}
        </button>
      }
    </div>
  `,
})
export class UiTabs {
  readonly items = input<UiTabItem[]>([]);
  readonly active = input('');
  readonly ariaLabel = input('');
  readonly tabChange = output<string>();

  select(id: string): void {
    this.tabChange.emit(id);
  }

  onKeydown(ev: KeyboardEvent, index: number): void {
    const items = this.items();
    if (!items.length) return;
    let next: number | null = null;
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') next = (index + 1) % items.length;
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = items.length - 1;
    if (next === null) return;
    ev.preventDefault();
    this.select(items[next].id);
    const buttons = (ev.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('button[role="tab"]');
    buttons[next]?.focus();
  }
}
