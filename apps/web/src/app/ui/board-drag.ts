// Board drag-and-drop plumbing (issue #11, D-046). The phase rules are pure and
// unit-tested in logic.ts; these three directives only connect them to the DOM.
//
//   [uiBoard]      — the wrapper that sees every pointermove/pointerup of a gesture
//   [uiDragSource] — a card: press starts (or refuses) a gesture, HTML5 dragstart
//                    hands the gesture to the browser and stands the pointer down
//   [uiDropZone]   — a column: the HTML5 drop target, and what a release is over
//
// Why both paths exist: a real browser drags `draggable` elements through HTML5 DnD,
// which is what users get. Headless Chromium does not open a drag session for
// Playwright's `dragTo` at all, so the `drop` handler never runs and a drag-only board
// is untestable end to end (main has been red on exactly that). Pointer events cover
// both engines and real touch/pen later. A gesture applies once, whichever path gets
// there first — see UiBoardDrag.claim.

import { Directive, EventEmitter, inject, Input, Output } from '@angular/core';
import {
  canDragFrom,
  dragDown,
  dragEnd,
  dragMove,
  dragTarget,
  dragToNative,
  DRAG_IDLE,
  type DragSession,
} from './logic';

export interface UiDrop {
  key: string;
  to: string;
}

/** Which column is under a point? The attribute is also what tests assert on. */
export function zoneOf(target: EventTarget | null): string | null {
  const el = (target as Element | null)?.closest?.('[data-drop-zone]');
  return el?.getAttribute('data-drop-zone') ?? null;
}

/** One board's drag gesture, shared by its wrapper, cards and columns. */
export class UiBoardDrag {
  private session: DragSession = DRAG_IDLE;
  private claimed = -1;

  /** The gesture that produced the last applied drop; -1 so token 0 can still claim. */
  get dragging(): boolean {
    return this.session.phase === 'dragging';
  }

  get activeKey(): string {
    return this.session.key;
  }

  down(key: string, fromStateId: string, x: number, y: number): void {
    this.session = dragDown(this.session, key, fromStateId, x, y);
  }

  move(x: number, y: number): void {
    this.session = dragMove(this.session, x, y);
  }

  /** `dragstart`: the browser owns this gesture, so the pointer path stands down. */
  standDown(): void {
    this.session = dragToNative(this.session);
  }

  /** Release outside a target, a cancelled pointer, `dragend`: nothing to apply. */
  cancel(): void {
    this.session = dragEnd(this.session);
  }

  /** Pointer release inside the board; `zone` is the column under the release point. */
  release(zone: string | null): UiDrop | null {
    const prev = this.session;
    const to = dragTarget(prev, zone);
    this.session = dragEnd(prev);
    return to && this.claim(prev.token) ? { key: prev.key, to } : null;
  }

  /** HTML5 drop: the payload carries the key, the zone the destination. */
  nativeDrop(key: string, zone: string): UiDrop | null {
    if (!key || !zone) return null;
    return this.claim(this.session.token) ? { key, to: zone } : null;
  }

  /** Only the first path to finish a gesture may act on it. */
  private claim(token: number): boolean {
    if (this.claimed === token) return false;
    this.claimed = token;
    return true;
  }
}

@Directive({
  selector: '[uiBoard]',
  providers: [UiBoardDrag],
  host: {
    '(pointermove)': 'onMove($event)',
    '(pointerup)': 'onUp($event)',
    '(pointercancel)': 'drag.cancel()',
    '(pointerleave)': 'drag.cancel()',
  },
})
export class UiBoard {
  /** Emitted once per gesture that ended over a foreign column. */
  @Output() readonly dragDrop = new EventEmitter<UiDrop>();

  private readonly drag = inject(UiBoardDrag);

  onMove(e: PointerEvent): void {
    this.drag.move(e.clientX, e.clientY);
  }

  onUp(e: PointerEvent): void {
    const drop = this.drag.release(zoneOf(e.target));
    if (drop) this.dragDrop.emit(drop);
  }
}

@Directive({
  selector: '[uiDragSource]',
  host: {
    draggable: 'true',
    '[class.ui-board-card--drag]': 'drag.dragging && drag.activeKey === uiDragSource',
    '(pointerdown)': 'onDown($event)',
    '(dragstart)': 'drag.standDown()',
    '(dragend)': 'drag.cancel()',
  },
})
export class UiDragSource {
  /** Work-item key of the card, i.e. what a drop carries. */
  @Input({ required: true }) uiDragSource!: string;
  /** State the card currently sits in — a drag back onto its own column is a no-op. */
  @Input({ required: true }) uiDragFrom!: string;

  private readonly drag = inject(UiBoardDrag);

  onDown(e: PointerEvent): void {
    if (e.pointerType === 'touch' || e.button > 0) return; // touch and secondary buttons keep their own meaning
    if (!canDragFrom((e.target as Element | null)?.tagName)) return; // links and buttons stay clickable
    this.drag.down(this.uiDragSource, this.uiDragFrom, e.clientX, e.clientY);
  }
}

@Directive({
  selector: '[uiDropZone]',
  host: {
    '[attr.data-drop-zone]': 'uiDropZone',
    '[class.ui-board-col--over]': 'over && drag.dragging',
    '(pointerenter)': 'over = true',
    '(pointerleave)': 'over = false',
    '(dragover)': '$event.preventDefault()',
    '(drop)': 'onDrop($event)',
  },
})
export class UiDropZone {
  /** State id this column moves items to. */
  @Input({ required: true }) uiDropZone!: string;
  /** Emitted by the HTML5 path; the pointer path emits on the board instead. */
  @Output() readonly dropped = new EventEmitter<UiDrop>();

  over = false;
  private readonly drag = inject(UiBoardDrag);

  onDrop(e: DragEvent): void {
    e.preventDefault();
    const drop = this.drag.nativeDrop(e.dataTransfer?.getData('text/plain') ?? '', this.uiDropZone);
    if (drop) this.dropped.emit(drop);
  }
}
