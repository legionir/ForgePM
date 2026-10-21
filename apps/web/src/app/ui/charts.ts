import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export interface UiChartDatum {
  label: string;
  value: number;
  /** CSS colour (a `var(--color-*)` token). */
  color: string;
}

const R = 15.9155; // circumference 100 → values map 1:1 to percentages

/**
 * Donut chart (dependency-free SVG). The legend is always rendered next to the
 * ring and carries the numbers, so identity is never colour-alone; segments get
 * a surface gap and a `<title>` tooltip. `total` shows in the hole.
 */
@Component({
  selector: 'ui-donut',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ui-donut">
      <svg class="ui-donut-ring" viewBox="0 0 42 42" role="img" [attr.aria-label]="label()">
        <circle class="ui-donut-track" cx="21" cy="21" [attr.r]="r" fill="none" stroke-width="5" />
        @for (s of segments(); track s.label) {
          <circle
            cx="21"
            cy="21"
            [attr.r]="r"
            fill="none"
            stroke-width="5"
            [attr.stroke]="s.color"
            [attr.stroke-dasharray]="s.dash"
            [attr.stroke-dashoffset]="s.offset"
            transform="rotate(-90 21 21)"
          >
            <title>{{ s.label }}: {{ s.value }}</title>
          </circle>
        }
      </svg>
      <div class="ui-donut-center" aria-hidden="true">
        <strong class="ui-donut-total">{{ total() }}</strong>
        <span class="ui-donut-sub">{{ centerLabel() }}</span>
      </div>
      <ul class="ui-legend">
        @for (d of data(); track d.label) {
          <li>
            <span class="ui-legend-dot" [style.background]="d.color"></span>
            <span class="ui-legend-label">{{ d.label }}</span>
            <span class="ui-legend-value">{{ d.value }}</span>
          </li>
        }
      </ul>
    </div>
  `,
})
export class UiDonut {
  readonly data = input<UiChartDatum[]>([]);
  readonly label = input('');
  readonly centerLabel = input('');
  readonly r = R;

  readonly total = computed(() => this.data().reduce((n, d) => n + d.value, 0));

  readonly segments = computed(() => {
    const total = this.total();
    if (!total) return [];
    let acc = 0;
    return this.data()
      .filter((d) => d.value > 0)
      .map((d) => {
        const pct = (d.value / total) * 100;
        const gap = pct > 4 ? 1 : 0;
        const seg = { ...d, dash: `${Math.max(pct - gap, 0)} ${100 - Math.max(pct - gap, 0)}`, offset: String(-acc) };
        acc += pct;
        return seg;
      });
  });
}

/** Horizontal bars with value labels — magnitude comparison across a category. */
@Component({
  selector: 'ui-bars',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ul class="ui-bars" [attr.aria-label]="label()">
      @for (d of data(); track d.label) {
        <li class="ui-bars-row" [title]="d.label + ': ' + d.value">
          <span class="ui-bars-label">{{ d.label }}</span>
          <span class="ui-bars-track"><span class="ui-bars-fill" [style.inline-size.%]="pct(d.value)" [style.background]="d.color"></span></span>
          <span class="ui-bars-value">{{ d.value }}</span>
        </li>
      }
    </ul>
  `,
})
export class UiBars {
  readonly data = input<UiChartDatum[]>([]);
  readonly label = input('');
  readonly max = computed(() => Math.max(1, ...this.data().map((d) => d.value)));

  pct(v: number): number {
    return (v / this.max()) * 100;
  }
}

/** Single progress meter (0–100) with accessible role. */
@Component({
  selector: 'ui-progress',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span
      class="ui-progress"
      role="progressbar"
      aria-valuemin="0"
      aria-valuemax="100"
      [attr.aria-valuenow]="clamped()"
      [attr.aria-label]="label()"
    >
      <span class="ui-progress-fill" [style.inline-size.%]="clamped()"></span>
    </span>
  `,
})
export class UiProgress {
  readonly value = input(0);
  readonly label = input('');
  readonly clamped = computed(() => Math.min(100, Math.max(0, Math.round(this.value()))));
}

/** Tiny bar-sparkline for a numeric series (e.g. activity per day). */
@Component({
  selector: 'ui-spark',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg class="ui-spark" viewBox="0 0 100 28" preserveAspectRatio="none" role="img" [attr.aria-label]="label()">
      @for (b of bars(); track $index) {
        <rect [attr.x]="b.x" [attr.y]="28 - b.h" [attr.width]="b.w" [attr.height]="b.h" rx="1.5">
          <title>{{ b.v }}</title>
        </rect>
      }
    </svg>
  `,
})
export class UiSpark {
  readonly values = input<number[]>([]);
  readonly label = input('');

  readonly bars = computed(() => {
    const v = this.values();
    if (!v.length) return [];
    const max = Math.max(1, ...v);
    const slot = 100 / v.length;
    return v.map((n, i) => ({ v: n, x: i * slot + slot * 0.15, w: slot * 0.7, h: Math.max(n ? 2 : 0.8, (n / max) * 28) }));
  });
}
