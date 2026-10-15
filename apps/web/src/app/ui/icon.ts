import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Icon set (plan §10 P7-6, TYG-003 / MINIMAL 2): dependency-free inline SVG
 * (feather-style 24×24 strokes, currentColor) instead of emoji/unicode
 * glyphs. One <ui-icon name="…"> per icon; decorative by default.
 */
const PATHS: Record<string, string[]> = {
  plus: ['M12 5v14', 'M5 12h14'],
  'chevron-left': ['M15 18l-6-6 6-6'],
  'chevron-right': ['M9 18l6-6-6-6'],
  'arrow-left': ['M19 12H5', 'M12 19l-7-7 7-7'],
  check: ['M20 6L9 17l-5-5'],
  'check-square': ['M9 11l3 3 8-8', 'M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11'],
  square: ['M5 5h14v14H5z'],
  'sort-neutral': ['M8 9l4-4 4 4', 'M16 15l-4 4-4-4'],
  'caret-up': ['M18 15l-6-6-6 6'],
  'caret-down': ['M6 9l6 6 6-6'],
  'dots-h': ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  inbox: ['M22 12h-6l-2 3h-4l-2-3H2', 'M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z'],
  palette: ['M12 22a10 10 0 1 1 10-10c0 1.66-1.34 3-3 3h-2a2 2 0 0 0-2 2c0 .5.2 1 .5 1.4.3.4.5.9.5 1.4a2 2 0 0 1-2 2z', 'M7.5 10.5h.01', 'M12 7.5h.01', 'M16.5 10.5h.01'],
  languages: ['M5 8l6 6', 'M4 14l6-6 2-3', 'M2 5h12', 'M7 2h1', 'M22 22l-5-10-5 10', 'M14 18h6'],
  'log-out': ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],
  menu: ['M3 6h18', 'M3 12h18', 'M3 18h18'],
  mail: ['M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z', 'M22 6l-10 7L2 6'],
  lock: ['M5 11h14v10H5z', 'M8 11V7a4 4 0 0 1 8 0v4'],
  building: ['M3 21h18', 'M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16', 'M9 7h.01', 'M15 7h.01', 'M9 11h.01', 'M15 11h.01', 'M9 15h.01', 'M15 15h.01', 'M11 21v-4h2v4'],
  command: ['M18 3a3 3 0 0 0-3 3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3'],
};

export type UiIconName = keyof typeof PATHS | (string & {});

@Component({
  selector: 'ui-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      viewBox="0 0 24 24"
      [attr.width]="size()"
      [attr.height]="size()"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      @for (d of paths(); track $index) {
        <path [attr.d]="d" />
      }
    </svg>
  `,
  host: {
    class: 'ui-icon',
    '[class.ui-icon--inline]': 'inline()',
  },
})
export class UiIcon {
  readonly name = input<UiIconName>('');
  readonly size = input(16);
  /** Inline icons align with surrounding text (vertical-align). */
  readonly inline = input(true);

  paths(): string[] {
    return PATHS[this.name()] ?? [];
  }
}
