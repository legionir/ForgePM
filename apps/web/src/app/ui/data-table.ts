import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { I18n } from '../i18n';
import { UiBadge, UiBadgeVariant } from './badge';
import { UiEmptyState } from './empty-state';
import { UiLoading } from './loading';

export interface UiTableColumn<T> {
  key: string;
  label: string;
  /** Display text (defaults to `row[key]`). */
  value?: (row: T) => string | number;
  /** Sort key (defaults to value / row[key]). */
  sortValue?: (row: T) => string | number;
  sortable?: boolean;
  /** Render the cell as a routerLink anchor with these commands. */
  link?: (row: T) => unknown[];
  linkTestid?: string;
  /** Render the cell as a badge (return null to fall back to text). */
  badge?: (row: T) => { text: string; variant: UiBadgeVariant } | null;
  /** Editable input cell; pairs with editValue/editChange on the table. */
  editable?: boolean;
  editTestid?: string;
  testid?: string;
  align?: 'start' | 'end';
}

export interface UiTableRowAction<T> {
  label: string;
  run: (row: T) => void;
  destructive?: boolean;
  testid?: string;
  /** Hide the action for rows where the predicate is false. */
  when?: (row: T) => boolean;
}

/**
 * Data table (plan §3 `ui/data-table`, P4-1): columns + rows + built-in
 * empty/loading/error states, client-side sort (aria-sort), optional
 * pagination and selection, and row actions that overflow into a «…» menu
 * beyond `maxInlineActions` (P4-3 / PLATFORM_PARITY 3.4). All pages share
 * this one implementation (CMP-001/TBL-001).
 */
@Component({
  selector: 'ui-data-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, UiBadge, UiEmptyState, UiLoading],
  template: `
    @if (error()) {
      <p class="ui-error" role="alert" [attr.data-testid]="testid() ? testid() + '-error' : null">{{ error() }}</p>
    }
    @if (loading()) {
      <ui-loading kind="table" [label]="i18n.instant('common.loading')" />
    } @else {
      <div class="ui-dt-wrap">
        <table class="ui-table" [attr.data-testid]="testid() || null">
          <thead>
            <tr>
              @if (selectable()) {
                <th class="ui-dt-check">
                  <input
                    type="checkbox"
                    [checked]="allSelected()"
                    (change)="toggleAll($event)"
                    [attr.aria-label]="i18n.instant('table.select_all')"
                  />
                </th>
              }
              @for (col of columns(); track col.key) {
                <th [attr.aria-sort]="sortAttr(col)" [class.ui-dt-end]="col.align === 'end'">
                  @if (col.sortable) {
                    <button type="button" class="ui-dt-sort" (click)="toggleSort(col)">
                      {{ col.label }}
                      <span aria-hidden="true">{{ sortIcon(col) }}</span>
                    </button>
                  } @else {
                    {{ col.label }}
                  }
                </th>
              }
              @if (actions().length) {
                <th class="ui-dt-actions">{{ i18n.instant('table.actions') }}</th>
              }
            </tr>
          </thead>
          <tbody>
            @for (row of visible(); track trackKey()(row)) {
              <tr [attr.data-testid]="rowTestid()?.(row) ?? null">
                @if (selectable()) {
                  <td class="ui-dt-check">
                    <input
                      type="checkbox"
                      [checked]="selected().has(trackKey()(row))"
                      (change)="toggleOne(row)"
                      [attr.aria-label]="i18n.instant('table.select_row', { key: trackKey()(row) })"
                    />
                  </td>
                }
                @for (col of columns(); track col.key) {
                  <td [class.ui-dt-end]="col.align === 'end'" [attr.data-testid]="col.testid || null">
                    @if (col.editable) {
                      <input
                        [value]="editValue()?.(row, col.key) ?? ''"
                        (input)="onEdit(row, col, $event)"
                        [attr.data-testid]="col.editTestid ?? null"
                        [attr.aria-label]="col.label"
                      />
                    } @else if (col.badge && col.badge(row)) {
                      <ui-badge size="sm" [variant]="col.badge(row)!.variant">{{ col.badge(row)!.text }}</ui-badge>
                    } @else if (col.link) {
                      <a [routerLink]="col.link(row)" [attr.data-testid]="col.linkTestid ?? null">{{ cellText(col, row) }}</a>
                    } @else {
                      {{ cellText(col, row) }}
                    }
                  </td>
                }
                @if (actions().length) {
                  <td class="ui-dt-actions">
                    <span class="ui-dt-actions-inline">
                      @for (a of inlineActions(row); track a.label) {
                        <button
                          type="button"
                          class="ui-btn ui-btn--sm"
                          [class.ui-btn--destructive]="a.destructive"
                          (click)="a.run(row)"
                          [attr.data-testid]="a.testid ?? null"
                        >
                          {{ a.label }}
                        </button>
                      }
                    </span>
                    @if (overflowActions(row).length) {
                      <details class="ui-dt-menu">
                        <summary [attr.aria-label]="i18n.instant('table.more')">…</summary>
                        <div class="ui-dt-menu-list" role="menu">
                          @for (a of overflowActions(row); track a.label) {
                            <button type="button" role="menuitem" (click)="a.run(row); closeMenu($event)" [attr.data-testid]="a.testid ?? null">
                              {{ a.label }}
                            </button>
                          }
                        </div>
                      </details>
                    }
                  </td>
                }
              </tr>
            } @empty {
              <tr>
                <td [attr.colspan]="colspan()" [attr.data-testid]="emptyTestid() || null">
                  <ui-empty-state [message]="emptyMessage()" />
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      @if (pageCount() > 1) {
        <nav class="ui-dt-pager" aria-label="Pagination">
          <button type="button" class="ui-btn ui-btn--secondary ui-btn--sm" [disabled]="page() === 0" (click)="page.set(page() - 1)">
            {{ i18n.instant('table.prev') }}
          </button>
          <span class="ui-dt-pager-info">{{ i18n.instant('table.info', { from: from(), to: to(), total: sorted().length }) }}</span>
          <button
            type="button"
            class="ui-btn ui-btn--secondary ui-btn--sm"
            [disabled]="page() >= pageCount() - 1"
            (click)="page.set(page() + 1)"
          >
            {{ i18n.instant('table.next') }}
          </button>
        </nav>
      }
    }
  `,
})
export class UiDataTable<T> {
  readonly i18n = inject(I18n);

  readonly columns = input.required<UiTableColumn<T>[]>();
  readonly rows = input<T[]>([]);
  readonly trackKey = input.required<(row: T) => string>();
  readonly loading = input(false);
  readonly error = input('');
  readonly emptyMessage = input('');
  readonly emptyTestid = input('');
  readonly testid = input('');
  readonly rowTestid = input<((row: T) => string) | null>(null);
  readonly selectable = input(false);
  readonly pageSize = input(0);
  readonly actions = input<UiTableRowAction<T>[]>([]);
  readonly maxInlineActions = input(2);
  readonly editValue = input<((row: T, key: string) => string) | null>(null);
  readonly editChange = input<((row: T, key: string, value: string) => void) | null>(null);

  readonly selectionChange = output<T[]>();

  readonly sortKey = signal('');
  readonly sortAsc = signal(true);
  readonly page = signal(0);
  readonly selected = signal<Set<string>>(new Set());

  readonly sorted = computed(() => {
    const list = [...this.rows()];
    const key = this.sortKey();
    if (!key) return list;
    const col = this.columns().find((c) => c.key === key);
    const get = (r: T): string | number =>
      col?.sortValue ? col.sortValue(r) : col?.value ? col.value(r) : String((r as Record<string, unknown>)[key] ?? '');
    const asc = this.sortAsc();
    return list.sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return asc ? cmp : -cmp;
    });
  });

  readonly pageCount = computed(() =>
    this.pageSize() > 0 ? Math.max(1, Math.ceil(this.sorted().length / this.pageSize())) : 1,
  );
  readonly visible = computed(() => {
    const ps = this.pageSize();
    if (!ps) return this.sorted();
    const p = Math.min(this.page(), this.pageCount() - 1);
    return this.sorted().slice(p * ps, p * ps + ps);
  });
  readonly from = computed(() => (this.pageSize() ? this.page() * this.pageSize() + 1 : 1));
  readonly to = computed(() =>
    this.pageSize() ? Math.min((this.page() + 1) * this.pageSize(), this.sorted().length) : this.sorted().length,
  );
  readonly colspan = computed(() => this.columns().length + (this.selectable() ? 1 : 0) + (this.actions().length ? 1 : 0));

  allSelected(): boolean {
    const rows = this.visible();
    return rows.length > 0 && rows.every((r) => this.selected().has(this.trackKey()(r)));
  }

  toggleAll(ev: Event): void {
    const on = (ev.target as HTMLInputElement).checked;
    const next = new Set(this.selected());
    for (const r of this.visible()) {
      if (on) next.add(this.trackKey()(r));
      else next.delete(this.trackKey()(r));
    }
    this.selected.set(next);
    this.emitSelection();
  }

  toggleOne(row: T): void {
    const key = this.trackKey()(row);
    const next = new Set(this.selected());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.selected.set(next);
    this.emitSelection();
  }

  private emitSelection(): void {
    const sel = this.selected();
    this.selectionChange.emit(this.rows().filter((r) => sel.has(this.trackKey()(r))));
  }

  toggleSort(col: UiTableColumn<T>): void {
    if (this.sortKey() === col.key) this.sortAsc.update((v) => !v);
    else {
      this.sortKey.set(col.key);
      this.sortAsc.set(true);
    }
  }

  sortAttr(col: UiTableColumn<T>): 'ascending' | 'descending' | 'none' {
    if (!col.sortable || this.sortKey() !== col.key) return 'none';
    return this.sortAsc() ? 'ascending' : 'descending';
  }

  sortIcon(col: UiTableColumn<T>): string {
    if (this.sortKey() !== col.key) return '↕';
    return this.sortAsc() ? '▲' : '▼';
  }

  cellText(col: UiTableColumn<T>, row: T): string | number {
    return col.value ? col.value(row) : String((row as Record<string, unknown>)[col.key] ?? '');
  }

  onEdit(row: T, col: UiTableColumn<T>, ev: Event): void {
    this.editChange()?.(row, col.key, (ev.target as HTMLInputElement).value);
  }

  inlineActions(row: T): UiTableRowAction<T>[] {
    return this.actionsFor(row).slice(0, this.maxInlineActions());
  }

  overflowActions(row: T): UiTableRowAction<T>[] {
    return this.actionsFor(row).slice(this.maxInlineActions());
  }

  private actionsFor(row: T): UiTableRowAction<T>[] {
    return this.actions().filter((a) => !a.when || a.when(row));
  }

  closeMenu(ev: Event): void {
    (ev.target as HTMLElement).closest('details')?.removeAttribute('open');
  }
}
