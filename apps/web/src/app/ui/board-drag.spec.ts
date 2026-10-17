// Board drag-and-drop wiring (issue #11, D-046). Two paths, one gesture:
// native HTML5 DnD (real browsers) and a pointer session (works under
// headless Chromium, where `dragTo` never starts a drag session). The pure
// reducer lives in logic.ts; the directives here are thin DOM plumbing, so the
// phase/threshold/zone rules are tested as units AND through rendered DOM to
// catch wiring typos a pure test cannot see.
import { describe, expect, it } from 'vitest';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  canDragFrom,
  DRAG_IDLE,
  DRAG_THRESHOLD_PX,
  dragDown,
  dragEnd,
  dragMove,
  dragTarget,
  dragToNative,
} from './logic';
import { UiBoard, UiDrop, UiDropZone, UiDragSource } from './board-drag';

/** A pointer event by name: jsdom has no PointerEvent constructor, and the
 *  handlers only read type/clientX/clientY/target, so MouseEvent is faithful. */
function pointer(el: Element, type: string, x: number, y: number, extra: Record<string, unknown> = {}): void {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  for (const [k, v] of Object.entries(extra)) Object.defineProperty(ev, k, { value: v, configurable: true });
  el.dispatchEvent(ev);
}

describe('board drag reducer', () => {
  it('refuses to drag from interactive elements so links and buttons keep working', () => {
    expect(canDragFrom('A')).toBe(false);
    expect(canDragFrom('button')).toBe(false);
    expect(canDragFrom('INPUT')).toBe(false);
    expect(canDragFrom('select')).toBe(false);
    expect(canDragFrom('summary')).toBe(false);
    expect(canDragFrom('SPAN')).toBe(true);
    expect(canDragFrom('ui-badge')).toBe(true);
    expect(canDragFrom(undefined)).toBe(false);
  });

  it('press alone is only pending and stamps a fresh gesture token', () => {
    const s = dragDown(DRAG_IDLE, 'EPRJ-1', 'st-backlog', 100, 50);
    expect(s).toMatchObject({ phase: 'pending', key: 'EPRJ-1', fromStateId: 'st-backlog', x: 100, y: 50 });
    expect(s.token).toBe(1);
    expect(dragDown(s, 'EPRJ-2', 'st-todo', 0, 0).token).toBe(2);
  });

  it('keeps a jitter inside the threshold a click, and promotes past it', () => {
    const s = dragDown(DRAG_IDLE, 'K-1', 'a', 100, 50);
    expect(dragMove(s, 100 + DRAG_THRESHOLD_PX - 1, 50).phase).toBe('pending');
    expect(dragMove(s, 100, 50 + DRAG_THRESHOLD_PX).phase).toBe('dragging');
    expect(dragMove(s, 109, 50).phase).toBe('dragging');
  });

  it('ignores moves outside a gesture without churning the session object', () => {
    expect(dragMove(DRAG_IDLE, 500, 500)).toBe(DRAG_IDLE);
    const s = dragMove(dragDown(DRAG_IDLE, 'K-1', 'a', 0, 0), 50, 50);
    expect(dragMove(s, 51, 51)).toBe(s); // already dragging: coords stay at the press point
  });

  it('drops only a dragging gesture over a foreign zone', () => {
    const pending = dragDown(DRAG_IDLE, 'K-1', 'a', 0, 0);
    expect(dragTarget(pending, 'b')).toBeNull(); // moved too little: it was a click
    expect(dragTarget(DRAG_IDLE, 'b')).toBeNull();
    const dragging = dragMove(pending, 40, 40);
    expect(dragTarget(dragging, null)).toBeNull(); // released over the board, not a column
    expect(dragTarget(dragging, 'a')).toBeNull(); // same column is not a move
    expect(dragTarget(dragging, 'b')).toBe('b');
  });

  it('ends and stands down keeping the token, so a gesture cannot apply twice', () => {
    const s = dragEnd(dragMove(dragDown(DRAG_IDLE, 'K-1', 'a', 0, 0), 40, 40));
    expect(s).toEqual({ ...DRAG_IDLE, token: 1 });
    const n = dragToNative(dragMove(dragDown(DRAG_IDLE, 'K-2', 'a', 0, 0), 40, 40));
    expect(n.phase).toBe('idle');
    expect(n.token).toBe(1); // the HTML5 path claims the same token
    expect(dragTarget(n, 'b')).toBeNull(); // so the pointer path can no longer produce a drop
  });
});

@Component({
  standalone: true,
  imports: [UiBoard, UiDropZone, UiDragSource],
  template: `
    <div class="ui-board" uiBoard (dragDrop)="dropped = $event">
      @for (st of states; track st) {
        <div class="ui-board-col" uiDropZone [uiDropZone]="st" (dropped)="dropped = $event">
          @if (st === from) {
            <div class="ui-board-card" uiDragSource [uiDragSource]="key" [uiDragFrom]="st" data-testid="board-card">
              <span class="t">drag me</span>
              <a href="/x">EPRJ-1</a>
            </div>
          }
        </div>
      }
    </div>
  `,
})
class BoardHost {
  states = ['a', 'b', 'c'];
  from = 'a';
  key = 'EPRJ-1';
  dropped: UiDrop | null = null;
}

describe('board drag directives', () => {
  beforeEach(async () => {
    TestBed.configureTestingModule({ imports: [BoardHost] });
  });

  it('moves the item through the transition output when the pointer is released on another column', async () => {
    const f = TestBed.createComponent(BoardHost);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    const card = el.querySelector<HTMLElement>('[data-testid="board-card"]')!;
    const targetCol = el.querySelectorAll<HTMLElement>('.ui-board-col')[2];
    expect(targetCol.getAttribute('data-drop-zone')).toBe('c'); // how the board resolves a release point

    pointer(card, 'pointerdown', 10, 10);
    expect(f.componentInstance.dropped).toBeNull();

    f.detectChanges();
    expect(card.classList.contains('ui-board-card--drag')).toBe(false); // a press alone is not a drag

    pointer(card, 'pointermove', 20, 20); // crosses the threshold inside the origin column
    f.detectChanges();
    expect(card.classList.contains('ui-board-card--drag')).toBe(true); // feedback while dragging

    pointer(targetCol, 'pointermove', 300, 300); // over the third column
    pointer(targetCol, 'pointerup', 300, 300); // released there -> drop
    f.detectChanges();

    expect(f.componentInstance.dropped).toEqual({ key: 'EPRJ-1', to: 'c' });
    expect(card.classList.contains('ui-board-card--drag')).toBe(false);
  });

  it('treats a press without travel as a click and leaves the gesture alone', async () => {
    const f = TestBed.createComponent(BoardHost);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    const card = el.querySelector<HTMLElement>('[data-testid="board-card"]')!;

    pointer(card, 'pointerdown', 10, 10);
    pointer(card, 'pointermove', 12, 11); // 2px: jitter
    pointer(card, 'pointerup', 12, 11);
    f.detectChanges();

    expect(f.componentInstance.dropped).toBeNull();
  });

  it('never starts a drag from the link inside the card', async () => {
    const f = TestBed.createComponent(BoardHost);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    const link = el.querySelector<HTMLElement>('a')!;
    const col = el.querySelectorAll<HTMLElement>('.ui-board-col')[1];

    pointer(link, 'pointerdown', 10, 10);
    pointer(link, 'pointermove', 300, 300);
    pointer(col, 'pointerup', 300, 300);
    f.detectChanges();

    expect(f.componentInstance.dropped).toBeNull();
  });

  it('ignores touch and secondary buttons so their own semantics survive', async () => {
    const f = TestBed.createComponent(BoardHost);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    const card = el.querySelector<HTMLElement>('[data-testid="board-card"]')!;
    const col = el.querySelectorAll<HTMLElement>('.ui-board-col')[1];

    pointer(card, 'pointerdown', 10, 10, { pointerType: 'touch' });
    pointer(card, 'pointermove', 300, 300, { pointerType: 'touch' });
    pointer(col, 'pointerup', 300, 300, { pointerType: 'touch' });
    f.detectChanges();
    expect(f.componentInstance.dropped).toBeNull();

    pointer(card, 'pointerdown', 10, 10, { button: 2 }); // right-click must not drag
    pointer(card, 'pointermove', 300, 300);
    pointer(col, 'pointerup', 300, 300);
    f.detectChanges();
    expect(f.componentInstance.dropped).toBeNull();
  });

  it('lets dragstart stand the pointer session down, and cancels on leaving the board', async () => {
    const f = TestBed.createComponent(BoardHost);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    const card = el.querySelector<HTMLElement>('[data-testid="board-card"]')!;
    const board = el.querySelector<HTMLElement>('.ui-board')!;
    const col = el.querySelectorAll<HTMLElement>('.ui-board-col')[1];

    pointer(card, 'pointerdown', 10, 10);
    pointer(card, 'pointermove', 60, 60);
    card.dispatchEvent(new Event('dragstart', { bubbles: true })); // native drag took over
    pointer(col, 'pointerup', 300, 300);
    expect(f.componentInstance.dropped).toBeNull();

    pointer(card, 'pointerdown', 10, 10);
    pointer(card, 'pointermove', 60, 60);
    pointer(board, 'pointerleave', 60, 60); // left the board: gesture is off
    pointer(board, 'pointerup', 60, 60);
    f.detectChanges();
    expect(f.componentInstance.dropped).toBeNull();
    expect(card.classList.contains('ui-board-card--drag')).toBe(false);
  });

  it('keeps the HTML5 path working for real browsers: payload drop + dragover accept', async () => {
    const f = TestBed.createComponent(BoardHost);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    const card = el.querySelector<HTMLElement>('[data-testid="board-card"]')!;
    const col = el.querySelectorAll<HTMLElement>('.ui-board-col')[1];

    // dragover must be accepted or Chromium refuses the drop before it starts
    const over = new Event('dragover', { bubbles: true, cancelable: true });
    col.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);

    card.dispatchEvent(new Event('dragstart', { bubbles: true })); // native drag begins
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', {
      value: { getData: (t: string) => (t === 'text/plain' ? 'EPRJ-1' : '') },
    });
    col.dispatchEvent(drop);
    f.detectChanges();
    expect(f.componentInstance.dropped).toEqual({ key: 'EPRJ-1', to: 'b' });
  });

  it('drops nothing when the payload carries no key', async () => {
    const f = TestBed.createComponent(BoardHost);
    f.detectChanges();
    const col = (f.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('.ui-board-col')[1];

    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { getData: () => '' } });
    col.dispatchEvent(drop);
    f.detectChanges();
    expect(f.componentInstance.dropped).toBeNull();
  });

  it('applies one gesture at most, however the two paths interleave', async () => {
    const f = TestBed.createComponent(BoardHost);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    const card = el.querySelector<HTMLElement>('[data-testid="board-card"]')!;
    const col = el.querySelectorAll<HTMLElement>('.ui-board-col')[1];

    pointer(card, 'pointerdown', 10, 10);
    pointer(card, 'pointermove', 60, 60);
    pointer(col, 'pointerup', 300, 300);
    expect(f.componentInstance.dropped).toEqual({ key: 'EPRJ-1', to: 'b' });

    // Same gesture, second claim (e.g. a stray pointerup after the native drop): no-op.
    pointer(col, 'pointerup', 300, 300);
    expect(f.componentInstance.dropped).toEqual({ key: 'EPRJ-1', to: 'b' });

    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { getData: () => 'EPRJ-1' } });
    el.querySelectorAll<HTMLElement>('.ui-board-col')[2].dispatchEvent(drop);
    f.detectChanges();
    expect(f.componentInstance.dropped).toEqual({ key: 'EPRJ-1', to: 'b' }); // still the first one
  });
});
