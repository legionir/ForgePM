import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, input, model, output, viewChild } from '@angular/core';
import { I18n } from '../i18n';
import { UiIcon } from './icon';

let seq = 0;

/**
 * Modal dialog: role=dialog + aria-modal, a backdrop, Escape and backdrop click
 * close it, focus moves into the dialog on open and returns to the opener on
 * close, Tab stays inside. Forms live in the projected body; the footer slot
 * (`[uiModalFooter]`) holds the actions.
 *
 *   <ui-modal [(open)]="show" [title]="…" icon="plus"> … <div uiModalFooter>…</div> </ui-modal>
 */
@Component({
  selector: 'ui-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiIcon],
  template: `
    @if (open()) {
      <div class="ui-modal-backdrop" (click)="close()" data-testid="modal-backdrop"></div>
      <div
        #dialog
        class="ui-modal"
        [class.ui-modal--lg]="size() === 'lg'"
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        [attr.aria-labelledby]="titleId"
        (keydown)="onKeydown($event)"
        data-testid="modal"
      >
        <header class="ui-modal-head">
          <h2 [id]="titleId">
            @if (icon()) {
              <ui-icon [name]="icon()" [size]="18" [inline]="false" />
            }
            {{ title() }}
          </h2>
          <button type="button" class="ui-modal-close" (click)="close()" [attr.aria-label]="i18n.instant('common.cancel')" data-testid="modal-close">
            <ui-icon name="x" [size]="16" [inline]="false" />
          </button>
        </header>
        <div class="ui-modal-body"><ng-content /></div>
        <footer class="ui-modal-foot"><ng-content select="[uiModalFooter]" /></footer>
      </div>
    }
  `,
  host: { class: 'ui-modal-host' },
})
export class UiModal {
  readonly i18n = inject(I18n);
  readonly open = model(false);
  readonly title = input('');
  readonly icon = input('');
  /** `lg` for detail views with long content (about 60rem); forms stay `md`. */
  readonly size = input<'md' | 'lg'>('md');
  readonly closed = output<void>();

  readonly titleId = `fpm-modal-${++seq}`;
  private readonly dialog = viewChild<ElementRef<HTMLElement>>('dialog');
  private opener: HTMLElement | null = null;

  constructor() {
    effect(() => {
      const el = this.dialog()?.nativeElement;
      if (!el) return;
      this.opener = (document.activeElement as HTMLElement | null) ?? null;
      const first = el.querySelector<HTMLElement>('input, select, textarea, button:not(.ui-modal-close)');
      (first ?? el).focus();
    });
  }

  close(): void {
    if (!this.open()) return;
    this.open.set(false);
    this.closed.emit();
    this.opener?.focus?.();
  }

  onKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      this.close();
      return;
    }
    if (ev.key !== 'Tab') return;
    const el = this.dialog()?.nativeElement;
    if (!el) return;
    const nodes = Array.from(el.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'));
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      first.focus();
    }
  }
}
