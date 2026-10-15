import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  Directive,
  ElementRef,
  inject,
  booleanAttribute,
  contentChild,
  effect,
  input,
  signal,
} from '@angular/core';

/**
 * Put on the control inside a <ui-field> so the field can wire the explicit
 * label[for] / aria-describedby / aria-invalid contract (FRM-002).
 */
@Directive({
  selector: 'input[uiControl],select[uiControl],textarea[uiControl]',
})
export class UiControl {
  readonly el = inject<ElementRef<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>>(
    ElementRef,
  );
}

let seq = 0;

/**
 * Form field wrapper (plan §3 `ui/input`): label + control + error/hint with
 * the full a11y wiring (explicit for/id, aria-invalid, aria-describedby).
 * The control stays authored by the page (ngModel etc. unchanged) — only the
 * surrounding markup moves into the field. Validation stays on-submit; the
 * `hint` slot documents per-field exceptions (§3 timing policy).
 */
@Component({
  selector: 'ui-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <label class="ui-field-label" [attr.for]="ctrlId()">
      {{ label() }}@if (required()) {<span class="ui-field-req" aria-hidden="true"> *</span>}
    </label>
    <ng-content />
    @if (error()) {
      <span class="ui-field-error" role="alert" [id]="errId">{{ error() }}</span>
    } @else if (hint()) {
      <span class="ui-field-hint" [id]="hintId">{{ hint() }}</span>
    }
  `,
  host: { class: 'ui-field' },
})
export class UiField implements AfterViewInit {
  readonly label = input('');
  readonly required = input(false, { transform: booleanAttribute });
  readonly error = input('');
  readonly hint = input('');

  private readonly control = contentChild(UiControl);
  private readonly errId = `fpm-err-${++seq}`;
  private readonly hintId = `fpm-hint-${++seq}`;
  private readonly id = `fpm-f-${++seq}`;
  readonly ctrlId = signal('');

  constructor() {
    effect(() => {
      const c = this.control();
      if (!c) return;
      const el = c.el.nativeElement;
      if (!el.id) el.id = this.id;
      this.ctrlId.set(el.id);
      const err = this.error();
      const hint = this.hint();
      el.setAttribute('aria-invalid', err ? 'true' : 'false');
      const describedBy = err ? this.errId : hint ? this.hintId : null;
      if (describedBy) el.setAttribute('aria-describedby', describedBy);
      else el.removeAttribute('aria-describedby');
    });
  }

  ngAfterViewInit(): void {
    // Signal queries resolve before this hook; run once for static controls.
    if (!this.ctrlId()) {
      const c = this.control();
      const el = c?.el.nativeElement;
      if (el) {
        if (!el.id) el.id = this.id;
        this.ctrlId.set(el.id);
      }
    }
  }
}
