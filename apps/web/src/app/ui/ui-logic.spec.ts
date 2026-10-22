import { describe, expect, it } from 'vitest';
import {
  camelCase,
  statusMeta,
  filterCommands,
  initialsOf,
  nextTabIndex,
  pageSlice,
  parseMarkdown,
  resolveTheme,
  sortRows,
  stateVariant,
  type SortCol,
} from './logic';
import type { UiCommand } from './command-palette';
import type { UiTableColumn } from './data-table';

describe('initialsOf', () => {
  it('takes the first letters of the first two words', () => {
    expect(initialsOf('Ada Lovelace')).toBe('AL');
    expect(initialsOf('alan turing')).toBe('AT');
  });
  it('handles single names and blank input', () => {
    expect(initialsOf('Cher')).toBe('C');
    expect(initialsOf('')).toBe('');
    expect(initialsOf('   ')).toBe('');
  });
});

describe('nextTabIndex (roving tabindex)', () => {
  it('wraps forwards and backwards', () => {
    expect(nextTabIndex(3, 0, 'ArrowRight')).toBe(1);
    expect(nextTabIndex(3, 2, 'ArrowRight')).toBe(0);
    expect(nextTabIndex(3, 0, 'ArrowLeft')).toBe(2);
    expect(nextTabIndex(3, 2, 'ArrowDown')).toBe(0);
  });
  it('supports Home/End and ignores other keys', () => {
    expect(nextTabIndex(3, 1, 'Home')).toBe(0);
    expect(nextTabIndex(3, 1, 'End')).toBe(2);
    expect(nextTabIndex(3, 1, 'Space')).toBeNull();
    expect(nextTabIndex(0, 0, 'ArrowRight')).toBeNull();
  });
});

interface Row {
  id: string;
  title: string;
  prio: string;
}
const cols: (UiTableColumn<Row> | SortCol<Row>)[] = [
  { key: 'id' },
  { key: 'title', sortable: true },
  { key: 'prio', sortable: true, sortValue: (r) => ({ urgent: 3, high: 2, low: 1 }[r.prio] ?? 0) },
];
const rows: Row[] = [
  { id: 'a', title: 'Beta', prio: 'high' },
  { id: 'b', title: 'Alpha', prio: 'urgent' },
  { id: 'c', title: 'Gamma', prio: 'low' },
];

describe('sortRows', () => {
  it('sorts by raw field and custom sortValue', () => {
    expect(sortRows(rows, cols, 'title', true).map((r) => r.title)).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(sortRows(rows, cols, 'prio', true).map((r) => r.prio)).toEqual(['low', 'high', 'urgent']);
    expect(sortRows(rows, cols, 'prio', false).map((r) => r.prio)).toEqual(['urgent', 'high', 'low']);
  });
  it('does not mutate the input and ignores unknown sort keys', () => {
    const snapshot = [...rows];
    expect(sortRows(rows, cols, '', true)).toEqual(snapshot);
    expect(rows).toEqual(snapshot);
  });
});

describe('pageSlice', () => {
  it('slices and clamps the page index', () => {
    expect(pageSlice([1, 2, 3, 4, 5], 0, 2)).toEqual([1, 2]);
    expect(pageSlice([1, 2, 3, 4, 5], 2, 2)).toEqual([5]);
    expect(pageSlice([1, 2, 3, 4, 5], 99, 2)).toEqual([5]);
    expect(pageSlice([1, 2, 3], 0, 0)).toEqual([1, 2, 3]);
  });
});

describe('filterCommands', () => {
  const cmds = [
    { id: '1', labelKey: 'nav.projects' },
    { id: '2', labelKey: 'nav.work_items' },
    { id: '3', labelKey: 'command.theme' },
  ] as UiCommand[];
  it('filters case-insensitively on the resolved label', () => {
    expect(filterCommands(cmds, 'proj', (c) => c.labelKey)).toHaveLength(1);
    expect(filterCommands(cmds, 'THE', (c) => c.labelKey)).toHaveLength(1);
    expect(filterCommands(cmds, '  ', (c) => c.labelKey)).toHaveLength(3);
    expect(filterCommands(cmds, 'zzz', (c) => c.labelKey)).toHaveLength(0);
  });
});

describe('parseMarkdown', () => {
  it('tokenizes bold/italic/code/links into typed segments', () => {
    const [p] = parseMarkdown('**bold** and *it* and `code()` and [x](https://e.com)');
    expect(p).toEqual([
      { t: 'bold', v: 'bold' },
      { t: 'text', v: ' and ' },
      { t: 'italic', v: 'it' },
      { t: 'text', v: ' and ' },
      { t: 'code', v: 'code()' },
      { t: 'text', v: ' and ' },
      { t: 'link', v: 'x', href: 'https://e.com' },
    ]);
  });
  it('splits blank lines and keeps html as inert text segments', () => {
    const paras = parseMarkdown('a\nb\n\n<script>alert(1)</script>');
    expect(paras).toHaveLength(2);
    // The <script> never becomes a construct the renderer would emit as
    // markup — it stays a 'text' segment, which Angular renders escaped.
    expect(paras[1].every((seg) => seg.t === 'text')).toBe(true);
    expect(paras[1][0].t).toBe('text');
  });
  it('rejects non-http link protocols', () => {
    const [p] = parseMarkdown('[x](javascript:alert(1))');
    expect(p[0].t).toBe('text');
  });
});

describe('resolveTheme', () => {
  it('explicit choice wins; system follows the media query', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});

describe('stateVariant (workflow colours)', () => {
  it('maps categories to badge variants', () => {
    expect(stateVariant('completed')).toBe('success');
    expect(stateVariant('started')).toBe('info');
    expect(stateVariant('in_review')).toBe('warning');
    expect(stateVariant('canceled')).toBe('default');
    expect(stateVariant('backlog')).toBe('default');
  });
});

import { UiToastService } from './toast';
import { CommandPalette } from './command-palette';
import { vi } from 'vitest';

describe('UiToastService (STT-002)', () => {
  it('adds and dismisses toasts; ok/error helpers set the kind', () => {
    const svc = new UiToastService();
    expect(svc.toasts()).toHaveLength(0);
    const okId = svc.ok('saved');
    const errId = svc.error('boom');
    expect(svc.toasts().map((t) => t.kind)).toEqual(['ok', 'error']);
    svc.dismiss(okId);
    expect(svc.toasts().map((t) => t.id)).toEqual([errId]);
  });

  it('supports inline actions (undo) and auto-dismisses after the window', () => {
    vi.useFakeTimers();
    const svc = new UiToastService();
    let undone = false;
    svc.show('archived', 'ok', 5000, { label: 'Undo', run: () => (undone = true) });
    const [toast] = svc.toasts();
    expect(toast.actionLabel).toBe('Undo');
    toast.action?.();
    expect(undone).toBe(true);
    vi.advanceTimersByTime(5001);
    expect(svc.toasts()).toHaveLength(0);
    vi.useRealTimers();
  });
});

describe('CommandPalette service', () => {
  it('registers commands and toggles open state', () => {
    const svc = new CommandPalette();
    expect(svc.open()).toBe(false);
    svc.register([{ id: 'a', labelKey: 'nav.projects', run: () => {} }]);
    expect(svc.commands()).toHaveLength(1);
    svc.show();
    expect(svc.open()).toBe(true);
    svc.toggle();
    expect(svc.open()).toBe(false);
    svc.hide();
    expect(svc.open()).toBe(false);
  });
});

describe('camelCase', () => {
  it('turns snake, spaced and upper case into CamelCase', () => {
    expect(camelCase('in_progress')).toBe('InProgress');
    expect(camelCase('In Progress')).toBe('InProgress');
    expect(camelCase('IN PROGRESS')).toBe('InProgress');
    expect(camelCase('feature_task')).toBe('FeatureTask');
    expect(camelCase('urgent')).toBe('Urgent');
  });

  it('leaves text without Latin letters and empty values unchanged', () => {
    expect(camelCase('در حال انجام')).toBe('در حال انجام');
    expect(camelCase('')).toBe('');
    expect(camelCase(null)).toBe('');
  });
});

describe('statusMeta', () => {
  it('maps known statuses to a variant and an icon', () => {
    expect(statusMeta('completed')).toEqual({ variant: 'success', icon: 'check-circle' });
    expect(statusMeta('failed').variant).toBe('error');
    expect(statusMeta('in_review').variant).toBe('warning');
    expect(statusMeta('In Progress')).toEqual({ variant: 'info', icon: 'play' });
  });

  it('keeps unknown values neutral', () => {
    expect(statusMeta('whatever')).toEqual({ variant: 'default', icon: 'circle' });
    expect(statusMeta(undefined).variant).toBe('default');
  });
});
