import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { I18n } from '../i18n';
import { Tokens } from '../ui/tokens';
import { UiButton } from '../ui/button';
import { UiBadge } from '../ui/badge';
import { UiAvatar } from '../ui/avatar';
import { UiEmptyState } from '../ui/empty-state';
import { UiLoading } from '../ui/loading';
import { UiTabs, UiTabItem } from '../ui/tabs';
import { UiIcon } from '../ui/icon';
import { UiMarkdown } from '../ui/markdown';
import { UiDataTable, UiTableColumn } from '../ui/data-table';
import { UiToastService } from '../ui/toast';
import { UiPage } from '../ui/page';
import { UiControl, UiField } from '../ui/field';

interface SwatchDto {
  name: string;
  value: string;
}
interface DemoRow {
  id: string;
  key: string;
  title: string;
  state: string;
  labels: string[];
}

/**
 * Living style reference (plan §10 P7-1, ENF-002): a real page rendering the
 * token register and every ui/* component in all its states, so drift is
 * visible in review and screenshots. Reached at /design-system (palette or
 * direct URL) — deliberately not in the primary nav. Duplicated values in
 * this demo ARE the canonical token list (styles.scss stays the source).
 */
@Component({
  selector: 'page-design-system',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, UiButton, UiBadge, UiAvatar, UiEmptyState, UiLoading, UiTabs, UiIcon, UiMarkdown, UiDataTable, UiField, UiControl, UiPage],
  template: `
    <ui-page data-testid="design-system" title="Design system">
      <h2>Colour tokens</h2>
      <ul class="ui-list ds-swatches">
        @for (c of colours; track c.name) {
          <li>
            <span class="ds-swatch" [style.background]="c.value" [attr.title]="c.value"></span>
            <code>--color-{{ c.name }}</code>
            <span class="ds-value">{{ c.value }}</span>
          </li>
        }
      </ul>

      <h2>Spacing / radius / shadow / motion</h2>
      <div class="ds-row">
        @for (s of spacings; track s) {
          <span class="ds-space" [style.inline-size]="s" [title]="'--space ' + s"></span>
        }
      </div>
      <div class="ds-row">
        <span class="ds-radius" style="border-radius: var(--radius-sm)">sm</span>
        <span class="ds-radius" style="border-radius: var(--radius-md)">md</span>
        <span class="ds-radius" style="border-radius: var(--radius-lg)">lg</span>
        <span class="ds-radius" style="border-radius: var(--radius-full)">full</span>
        <span class="ds-radius" style="box-shadow: var(--shadow-sm)">shadow-sm</span>
        <span class="ds-radius" style="box-shadow: var(--shadow-md)">shadow-md</span>
        <span class="ds-radius" style="box-shadow: var(--shadow-modal)">shadow-modal</span>
      </div>
      <p class="ds-value">motion: {{ motionTokens().join(' · ') }} — <button type="button" ui-button size="sm" (click)="tokens.cycle()" data-testid="ds-theme">{{ i18n.instant('command.theme') }}</button></p>

      <h2>Typography</h2>
      <div>
        <p style="font-size: var(--font-size-h1); margin: 0">h1 — font-size-h1</p>
        <p style="font-size: var(--font-size-h2); margin: 0">h2 — font-size-h2</p>
        <p style="margin: 0">body — font-size-body</p>
        <p style="font-size: var(--font-size-label); margin: 0">label — font-size-label</p>
        <p style="font-size: var(--font-size-caption); margin: 0">caption — font-size-caption</p>
      </div>

      <h2>Buttons</h2>
      <div class="ds-row ds-wrap">
        <button type="button" ui-button variant="primary">primary</button>
        <button type="button" ui-button>secondary</button>
        <button type="button" ui-button variant="destructive">destructive</button>
        <button type="button" ui-button variant="ghost">ghost</button>
        <button type="button" ui-button variant="primary" disabled>disabled</button>
        <button type="button" ui-button variant="primary" [loading]="true">loading</button>
        <button type="button" ui-button size="sm">sm</button>
      </div>

      <h2>Badges / chips / avatars / icons</h2>
      <div class="ds-row ds-wrap">
        <ui-badge>default</ui-badge>
        <ui-badge variant="success">success</ui-badge>
        <ui-badge variant="warning">warning</ui-badge>
        <ui-badge variant="error">error</ui-badge>
        <ui-badge variant="info">info</ui-badge>
        <span class="ui-chip">chip</span>
        <ui-avatar name="Ada Lovelace" />
        <ui-avatar name="Alan Turing" size="sm" />
        <ui-avatar name="Iron Man" size="lg" />
        <ui-icon name="plus" />
        <ui-icon name="inbox" />
        <ui-icon name="command" />
        <ui-icon name="palette" />
      </div>

      <h2>Fields</h2>
      <form class="ds-form">
        <ui-field label="With hint" hint="helper text">
          <input uiControl name="a" />
        </ui-field>
        <ui-field label="With error" error="Something went wrong">
          <input uiControl name="b" />
        </ui-field>
      </form>

      <h2>Tabs / loading / empty</h2>
      <ui-tabs [items]="tabs" [active]="tab()" ariaLabel="Demo" (tabChange)="tab.set($event)" />
      <ui-loading kind="lines" label="lines" />
      <ui-loading kind="table" label="table" />
      <ui-empty-state message="Nothing here yet" actionText="Create" (action)="toast.ok('CTA clicked')" />

      <h2>Data table</h2>
      <ui-data-table
        testid="ds-table"
        emptyTestid="ds-table-empty"
        [columns]="tableColumns"
        [rows]="tableRows"
        [trackKey]="trackRow"
        [pageSize]="2"
        [selectable]="true"
        [emptyMessage]="'Empty demo'"
      />

      <h2>Markdown</h2>
      <ui-markdown [text]="mdSample" />

      <h2>Toast</h2>
      <div class="ds-row">
        <button type="button" ui-button size="sm" (click)="toast.ok('Saved.')">ok</button>
        <button type="button" ui-button size="sm" (click)="toast.error('Failed.')">error</button>
        <button type="button" ui-button size="sm" (click)="toast.show('Info.')">info</button>
      </div>

      <h2>Icons</h2>
      <div class="ds-row ds-wrap">
        @for (ic of iconNames; track ic) {
          <span class="ds-icon" [title]="ic"><ui-icon [name]="ic" [size]="18" [inline]="false" /></span>
        }
      </div>

      <p class="ds-value">⌘K opens the command palette · / opens search · this page: /design-system (P7-1)</p>
    </ui-page>
  `,
})
export class DesignSystemPage {
  readonly i18n = inject(I18n);
  readonly tokens = inject(Tokens);
  readonly toast = inject(UiToastService);

  readonly tab = signal('one');
  readonly tabs: UiTabItem[] = [
    { id: 'one', label: 'One' },
    { id: 'two', label: 'Two' },
    { id: 'three', label: 'Three' },
  ];

  readonly colours: SwatchDto[] = [
    { name: 'bg', value: 'var(--color-bg)' },
    { name: 'surface', value: 'var(--color-surface)' },
    { name: 'fg', value: 'var(--color-fg)' },
    { name: 'muted', value: 'var(--color-muted)' },
    { name: 'line', value: 'var(--color-line)' },
    { name: 'accent', value: 'var(--color-accent)' },
    { name: 'error', value: 'var(--color-error)' },
    { name: 'ok', value: 'var(--color-ok)' },
    { name: 'warning', value: 'var(--color-warning)' },
    { name: 'info', value: 'var(--color-info)' },
  ];
  readonly spacings = ['var(--space-1)', 'var(--space-2)', 'var(--space-3)', 'var(--space-4)', 'var(--space-6)', 'var(--space-8)'];
  readonly iconNames = ['plus', 'chevron-left', 'chevron-right', 'arrow-left', 'check', 'check-square', 'square', 'sort-neutral', 'caret-up', 'caret-down', 'dots-h', 'inbox', 'palette', 'languages', 'log-out', 'menu', 'command'];

  readonly mdSample = 'Supported: **bold**, *italic*, `code()`, link [ForgePM](https://github.com/legionir/ForgePM).\n\nUnsafe HTML is escaped by construction — segments render as typed values, never innerHTML.';

  readonly trackRow = (r: DemoRow): string => r.id;
  readonly tableColumns: UiTableColumn<DemoRow>[] = [
    { key: 'key', label: 'Key', sortable: true },
    { key: 'title', label: 'Title', sortable: true },
    { key: 'state', label: 'State', badge: (r) => ({ text: r.state, variant: r.state === 'done' ? 'success' : 'info' }) },
    { key: 'labels', label: 'Labels', chips: (r) => r.labels },
  ];
  readonly tableRows: DemoRow[] = [
    { id: '1', key: 'PROJ-1', title: 'First', state: 'done', labels: ['core'] },
    { id: '2', key: 'PROJ-2', title: 'Second', state: 'open', labels: ['ui', 'a11y'] },
    { id: '3', key: 'PROJ-3', title: 'Third', state: 'open', labels: [] },
  ];

  motionTokens(): string[] {
    return ['fast 120ms', 'base 200ms', 'slow 320ms'];
  }
}
