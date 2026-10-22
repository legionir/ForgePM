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
  message: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  'git-pr': ['M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M13 6h3a2 2 0 0 1 2 2v7', 'M6 9v12', 'M18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  dashboard: ['M3 3h7v9H3z', 'M14 3h7v5h-7z', 'M14 12h7v9h-7z', 'M3 16h7v5H3z'],
  folder: ['M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z'],
  list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
  layers: ['M12 2L2 7l10 5 10-5-10-5z', 'M2 17l10 5 10-5', 'M2 12l10 5 10-5'],
  compass: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M16.24 7.76l-2.12 6.36-6.36 2.12 2.12-6.36 6.36-2.12z'],
  eye: ['M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  'git-branch': ['M6 3v12', 'M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M18 9a9 9 0 0 1-9 9'],
  shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'M9 12l2 2 4-4'],
  cpu: ['M4 4h16v16H4z', 'M9 9h6v6H9z', 'M9 1v3', 'M15 1v3', 'M9 20v3', 'M15 20v3', 'M20 9h3', 'M20 14h3', 'M1 9h3', 'M1 14h3'],
  key: ['M21 2l-2 2', 'M11.39 11.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78z', 'M11.39 11.61L15.5 7.5', 'M15.5 7.5l3 3L22 7l-3-3'],
  sliders: ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M1 14h6', 'M9 8h6', 'M17 16h6'],
  activity: ['M22 12h-4l-3 9L9 3l-3 9H2'],
  server: ['M2 2h20v8H2z', 'M2 14h20v8H2z', 'M6 6h.01', 'M6 18h.01'],
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M21 21l-4.35-4.35'],
  sun: ['M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z', 'M12 1v2', 'M12 21v2', 'M4.22 4.22l1.42 1.42', 'M18.36 18.36l1.42 1.42', 'M1 12h2', 'M21 12h2', 'M4.22 19.78l1.42-1.42', 'M18.36 5.64l1.42-1.42'],
  moon: ['M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z'],
  user: ['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'],
  alert: ['M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z', 'M12 9v4', 'M12 17h.01'],
  clock: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 6v6l4 2'],
  flag: ['M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z', 'M4 22v-7'],
  target: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12z', 'M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'],
  x: ['M18 6L6 18', 'M6 6l12 12'],
  'check-circle': ['M22 11.08V12a10 10 0 1 1-5.93-9.14', 'M22 4L12 14.01l-3-3'],
  circle: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z'],
  archive: ['M21 8v13H3V8', 'M1 3h22v5H1z', 'M10 12h4'],
  zap: ['M13 2L3 14h9l-1 8 10-12h-9l1-8z'],
  plug: ['M12 22v-5', 'M9 8V2', 'M15 8V2', 'M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z'],
  'file-text': ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6', 'M16 13H8', 'M16 17H8', 'M10 9H8'],
  'chevrons-up-down': ['M7 15l5 5 5-5', 'M7 9l5-5 5 5'],
  rocket: ['M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z', 'M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z', 'M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0', 'M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5'],
  link: ['M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71', 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'],
  unlink: ['M18.84 12.25l1.72-1.71a5 5 0 0 0-.12-7.07 5 5 0 0 0-6.95 0l-1.72 1.71', 'M5.17 11.75l-1.71 1.71a5 5 0 0 0 .12 7.07 5 5 0 0 0 6.95 0l1.71-1.71', 'M8 2v3', 'M2 8h3', 'M16 22v-3', 'M22 16h-3'],
  edit: ['M12 20h9', 'M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z'],
  play: ['M5 3l14 9-14 9V3z'],
  'x-circle': ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M15 9l-6 6', 'M9 9l6 6'],
  image: ['M3 3h18v18H3z', 'M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z', 'M21 15l-5-5L5 21'],
  'help-circle': ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3', 'M12 17h.01'],
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
