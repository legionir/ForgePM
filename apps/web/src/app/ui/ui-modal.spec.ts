import { describe, expect, it } from 'vitest';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UiModal } from './modal';

@Component({
  standalone: true,
  imports: [UiModal],
  template: `
    <button id="opener" (click)="show.set(true)">open</button>
    <ui-modal [(open)]="show" title="New thing" icon="plus" (closed)="closedCount = closedCount + 1">
      <input id="first" />
      <div uiModalFooter><button id="save">Save</button></div>
    </ui-modal>
  `,
})
class Host {
  readonly show = signal(false);
  closedCount = 0;
}

async function mount() {
  TestBed.configureTestingModule({ imports: [Host] });
  const f = TestBed.createComponent(Host);
  f.detectChanges();
  await f.whenStable();
  return { f, el: f.nativeElement as HTMLElement, host: f.componentInstance };
}

const q = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('UiModal', () => {
  it('modal open close: renders only while open, closes on Escape and backdrop, and emits closed', async () => {
    const { f, el, host } = await mount();
    expect(q(el, 'modal')).toBeNull();

    host.show.set(true);
    f.detectChanges();
    await f.whenStable();
    expect(q(el, 'modal')?.getAttribute('role')).toBe('dialog');
    expect(q(el, 'modal')?.getAttribute('aria-modal')).toBe('true');
    expect(el.querySelector('h2')?.textContent).toContain('New thing');
    expect(el.querySelector('#save')).toBeTruthy();

    q(el, 'modal')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    f.detectChanges();
    expect(host.show()).toBe(false);
    expect(q(el, 'modal')).toBeNull();
    expect(host.closedCount).toBe(1);

    host.show.set(true);
    f.detectChanges();
    await f.whenStable();
    q(el, 'modal-backdrop')!.click();
    f.detectChanges();
    expect(host.show()).toBe(false);
    expect(host.closedCount).toBe(2);
  });

  it('moves focus into the dialog on open', async () => {
    const { f, el, host } = await mount();
    host.show.set(true);
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
    expect(el.querySelector('#first')).toBe(document.activeElement);
  });
});
