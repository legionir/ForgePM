// Composite component render tests (P7-3 coverage): data-table, shell,
// command palette, project picker, nav-current and toasts under the official
// `ng test` vitest runner (jsdom + live templates/inputs).
import { describe, expect, it } from 'vitest';
import { Component as TestComp } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Component, signal, viewChild } from '@angular/core';
import { provideRouter, RouterLink, Router } from '@angular/router';
import { UiDataTable, UiTableColumn, UiTableRowAction } from './data-table';
import { UiShell } from './shell';
import { CommandPalette, UiCommandPalette } from './command-palette';
import { ProjectPickerCmp } from './project-picker';
import { UiToasts, UiToastService } from './toast';
import { Session } from '../session';
import { I18n } from '../i18n';
import { ApiClient } from '../api';
import { ProjectContext } from '../project-context';
import { UiNavCurrent } from './nav-current';

interface Row {
  id: string;
  name: string;
  prio: string;
  labels: string[];
}

const ROWS: Row[] = [
  { id: '1', name: 'beta', prio: 'high', labels: ['infra'] },
  { id: '2', name: 'alpha', prio: 'low', labels: [] },
  { id: '3', name: 'gamma', prio: 'medium', labels: ['ux', 'api'] },
];

const COLS: UiTableColumn<Row>[] = [
  { key: 'name', label: 'Name', sortable: true },
  { key: 'prio', label: 'Priority', badge: (r) => ({ text: r.prio, variant: r.prio === 'high' ? 'error' : 'default' }) },
  { key: 'labels', label: 'Labels', chips: (r) => r.labels },
];

/** Minimal routable target for in-test navigations (login, work-items, x/y). */
@TestComp({ standalone: true, template: `` })
class DummyRoute {}

const ROUTES = [
  { path: 'x', component: DummyRoute },
  { path: 'y', component: DummyRoute },
  { path: 'login', component: DummyRoute },
  { path: 'work-items', component: DummyRoute },
  { path: 'work-items/:key', component: DummyRoute },
];

async function flush(f: ComponentFixture<unknown>): Promise<void> {
  f.detectChanges();
  await f.whenStable();
  f.detectChanges();
}

@Component({
  standalone: true,
  imports: [UiDataTable],
  template: `<ui-data-table testid="t" [columns]="cols" [rows]="rows" [trackKey]="key" />`,
})
class TableHost {
  readonly cols = COLS;
  readonly rows = ROWS;
  readonly key = (r: Row) => r.id;
  readonly table = signal<UiDataTable<Row> | null>(null);
}

describe('UiDataTable', () => {
  it('renders header + cells via value/badge/chips accessors', async () => {
    TestBed.configureTestingModule({ imports: [TableHost], providers: [provideRouter([])] });
    const f = TestBed.createComponent(TableHost);
    await flush(f);
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('table')?.getAttribute('data-testid')).toBe('t');
    const body = el.querySelectorAll('tbody tr');
    expect(body).toHaveLength(3);
    expect(body[0].textContent).toContain('beta');
    expect(body[0].querySelector('.ui-badge--error')?.textContent?.trim()).toBe('High');
    expect(body[0].querySelectorAll('.ui-chip').length).toBe(1);
    expect(body[2].querySelectorAll('.ui-chip').length).toBe(2);
  });

  it('sortable headers toggle aria-sort and reorder rows', async () => {
    TestBed.configureTestingModule({ imports: [TableHost], providers: [provideRouter([])] });
    const f = TestBed.createComponent(TableHost);
    await flush(f);
    const el = f.nativeElement as HTMLElement;
    const th = el.querySelector('th')!;
    expect(th.getAttribute('aria-sort')).toBe('none');
    (th.querySelector('button') as HTMLButtonElement).click();
    await flush(f);
    expect(el.querySelector('th')!.getAttribute('aria-sort')).toBe('ascending');
    expect(el.querySelector('tbody tr')?.textContent).toContain('alpha');
    (el.querySelector('th button') as HTMLButtonElement).click();
    await flush(f);
    expect(el.querySelector('th')!.getAttribute('aria-sort')).toBe('descending');
    expect(el.querySelector('tbody tr')?.textContent).toContain('gamma');
  });

  it('paginates with prev/next and renders the range info', async () => {
    @Component({
      standalone: true,
      imports: [UiDataTable],
      template: `<ui-data-table [columns]="cols" [rows]="rows" [trackKey]="key" [pageSize]="2" />`,
    })
    class H extends TableHost {}
    TestBed.configureTestingModule({ imports: [H], providers: [provideRouter(ROUTES)] });
    const f = TestBed.createComponent(H);
    await flush(f);
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(el.querySelector('.ui-dt-pager-info')?.textContent).toContain('1');
    const btns = el.querySelectorAll('.ui-dt-pager button');
    expect((btns[0] as HTMLButtonElement).disabled).toBe(true);
    (btns[1] as HTMLButtonElement).click();
    await flush(f);
    expect(el.querySelectorAll('tbody tr')).toHaveLength(1);
    expect((el.querySelectorAll('.ui-dt-pager button')[1] as HTMLButtonElement).disabled).toBe(true);
  });

  it('empty state shows the message + CTA and emits emptyAction', async () => {
    let cta = 0;
    @Component({
      standalone: true,
      imports: [UiDataTable],
      template: `<ui-data-table [columns]="cols" [rows]="rows" [trackKey]="key" emptyMessage="No rows" emptyActionLabel="Create" (emptyAction)="cta = cta + 1" emptyTestid="e" />`,
    })
    class H extends TableHost {
      cta = 0;
      override readonly rows: Row[] = [];
    }
    TestBed.configureTestingModule({ imports: [H], providers: [provideRouter(ROUTES)] });
    const f = TestBed.createComponent(H);
    const inst = f.componentInstance;
    await flush(f);
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="e"]')?.textContent).toContain('No rows');
    const btn = el.querySelector('.ui-empty button') as HTMLButtonElement;
    expect(btn.textContent?.trim()).toBe('Create');
    btn.click();
    expect(inst.cta).toBe(1);
    void cta;
  });

  it('loading + error states render; error is announced', async () => {
    @Component({
      standalone: true,
      imports: [UiDataTable],
      template: `<ui-data-table [columns]="cols" [rows]="rows" [trackKey]="key" [loading]="loading()" [error]="err()" testid="t" />`,
    })
    class H extends TableHost {
      readonly loading = signal(true);
      readonly err = signal('');
    }
    TestBed.configureTestingModule({ imports: [H], providers: [provideRouter(ROUTES)] });
    const f = TestBed.createComponent(H);
    await flush(f);
    expect(f.nativeElement.querySelector('.ui-skel-table')).toBeTruthy();
    f.componentInstance.err.set('boom');
    f.componentInstance.loading.set(false);
    await flush(f);
    const err = f.nativeElement.querySelector('[data-testid="t-error"]')!;
    expect(err.textContent).toContain('boom');
    expect(err.getAttribute('role')).toBe('alert');
  });

  it('row actions: inline beyond max overflow into the menu; when() hides; destructive class', async () => {
    let ran = '';
    const actions: UiTableRowAction<Row>[] = [
      { label: 'Open', run: (r) => (ran = `open:${r.id}`), testid: 'a-open' },
      { label: 'Archive', run: (r) => (ran = `arch:${r.id}`) },
      { label: 'Delete', run: (r) => (ran = `del:${r.id}`), destructive: true, when: (r) => r.id === '1' },
    ];
    @Component({
      standalone: true,
      imports: [UiDataTable],
      template: `<ui-data-table [columns]="cols" [rows]="rows" [trackKey]="key" [actions]="actions" [maxInlineActions]="2" />`,
    })
    class H extends TableHost {
      readonly actions = actions;
    }
    TestBed.configureTestingModule({ imports: [H], providers: [provideRouter(ROUTES)] });
    const f = TestBed.createComponent(H);
    await flush(f);
    const row1 = f.nativeElement.querySelectorAll('tbody tr')[0];
    const inline1 = row1.querySelectorAll('.ui-dt-actions-inline button');
    expect(inline1.length).toBe(2);
    expect(row1.querySelector('details summary')).toBeTruthy();
    (inline1[0] as HTMLButtonElement).click();
    expect(ran).toBe('open:1');
    const menuBtn = row1.querySelectorAll('details button')[0] as HTMLButtonElement;
    expect(menuBtn.getAttribute('role')).toBe('menuitem');
    menuBtn.click();
    expect(ran).toBe('del:1');
    const row2 = f.nativeElement.querySelectorAll('tbody tr')[1];
    // row 2: Delete hidden by when() -> two inline actions, no overflow
    expect(row2.querySelectorAll('.ui-dt-actions-inline button').length).toBe(2);
    expect(row2.querySelector('details')).toBeNull();
  });

  it('selection: header checkbox selects all, row toggles emit the selection', async () => {
    let last: Row[] = [];
    @Component({
      standalone: true,
      imports: [UiDataTable],
      template: `<ui-data-table [columns]="cols" [rows]="rows" [trackKey]="key" [selectable]="true" (selectionChange)="sel = $event" />`,
    })
    class H extends TableHost {
      sel: Row[] = [];
    }
    TestBed.configureTestingModule({ imports: [H], providers: [provideRouter(ROUTES)] });
    const f = TestBed.createComponent(H);
    await flush(f);
    const head = f.nativeElement.querySelector('thead input') as HTMLInputElement;
    head.click();
    await flush(f);
    expect(f.componentInstance.sel).toHaveLength(3);
    const row = f.nativeElement.querySelectorAll('tbody input')[0] as HTMLInputElement;
    row.click();
    await flush(f);
    expect(f.componentInstance.sel).toHaveLength(2);
    expect(last).toHaveLength(0);
    void last;
  });
});

@Component({
  standalone: true,
  imports: [UiShell],
  template: `<ui-shell><p>body</p></ui-shell>`,
})
class ShellHost {}

function stubSession(): Session {
  return {
    me: signal({ actor: { type: 'user', id: 'u1', organization_id: 'o1', org_role: 'owner' }, user: { id: 'u1', email: 'a@b.c', display_name: 'Ada', locale: 'en', timezone: 'UTC' }, csrf_token: null }),
    logout: async () => {},
  } as unknown as Session;
}

function stubApi(): Partial<ApiClient> {
  return {
    get: async <T = unknown>(): Promise<T> => ({ items: [] }) as T,
    post: async <T = unknown>(): Promise<T> => ({}) as T,
  };
}

describe('UiShell', () => {
  it('without a project: only workspace/governance/platform nav is rendered; burger toggles the drawer', async () => {
    localStorage.removeItem('fpm_project');
    TestBed.configureTestingModule({
      imports: [ShellHost],
      providers: [provideRouter(ROUTES), { provide: Session, useValue: stubSession() }, { provide: ApiClient, useValue: stubApi() }],
    });
    const f = TestBed.createComponent(ShellHost);
    await flush(f);
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelectorAll('[data-testid="nav"] a').length).toBe(8);
    expect(el.querySelector('[data-testid="nav-projects"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="nav-work-items"]')).toBeNull();
    expect(el.querySelector('[data-testid="nav-dashboard"]')).toBeNull();
    expect(el.querySelector('[data-testid="shell-create-project"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="who"]')?.textContent).toContain('Ada');
    const root = el.querySelector('.ui-shell')!;
    expect(root.classList.contains('nav-open')).toBe(false);
    (el.querySelector('[data-testid="nav-toggle"]') as HTMLButtonElement).click();
    f.detectChanges();
    expect(root.classList.contains('nav-open')).toBe(true);

    expect(TestBed.inject(CommandPalette).commands().length).toBe(11);
  });

  it('with a project: the project-scoped sections unlock (16 destinations)', async () => {
    localStorage.removeItem('fpm_project');
    const api: Partial<ApiClient> = {
      get: async <T = unknown>(): Promise<T> => ({ items: [{ id: 'p1', key: 'P', name: 'Proj', status: 'active' }] }) as T,
      post: async <T = unknown>(): Promise<T> => ({}) as T,
    };
    TestBed.configureTestingModule({
      imports: [ShellHost],
      providers: [provideRouter(ROUTES), { provide: Session, useValue: stubSession() }, { provide: ApiClient, useValue: api }],
    });
    const f = TestBed.createComponent(ShellHost);
    await flush(f);
    await f.whenStable();
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelectorAll('[data-testid="nav"] a').length).toBe(16);
    for (const id of ['nav-dashboard', 'nav-features', 'nav-work-items', 'nav-planner', 'nav-exec-tasks', 'nav-reviews', 'nav-github']) {
      expect(el.querySelector(`[data-testid="${id}"]`), id).toBeTruthy();
    }
    expect(el.querySelector('[data-testid="shell-project-select"]')).toBeTruthy();
    expect(TestBed.inject(CommandPalette).commands().length).toBe(20);
    localStorage.removeItem('fpm_project');
  });

  it('theme + lang toggles mutate tokens/i18n; logout routes to /login', async () => {
    TestBed.configureTestingModule({
      imports: [ShellHost],
      providers: [provideRouter(ROUTES), { provide: Session, useValue: stubSession() }, { provide: ApiClient, useValue: stubApi() }],
    });
    const { Tokens } = await import('./tokens');
    const { I18n } = await import('../i18n');
    const f = TestBed.createComponent(ShellHost);
    await flush(f);
    const tokens = TestBed.inject(Tokens);
    const i18n = TestBed.inject(I18n);
    i18n.set('en');
    const el = f.nativeElement as HTMLElement;
    (el.querySelector('[data-testid="theme-toggle"]') as HTMLButtonElement).click();
    expect(tokens.theme()).toBe('light');
    (el.querySelector('[data-testid="lang-toggle"]') as HTMLButtonElement).click();
    expect(i18n.lang()).toBe('fa');
    i18n.set('en'); // don't leak fa into other tests in this worker
    (el.querySelector('[data-testid="logout"]') as HTMLButtonElement).click();
    await f.whenStable();
    expect(TestBed.inject(Router).url).toBe('/login');
  });
});

describe('CommandPalette (component)', () => {
  @Component({ standalone: true, imports: [UiCommandPalette], template: `<ui-command-palette />` })
  class PaletteHost {
    readonly pal = viewChild.required(UiCommandPalette);
  }

  function paletteSetup() {
    TestBed.configureTestingModule({
      imports: [PaletteHost],
      providers: [provideRouter(ROUTES), { provide: ApiClient, useValue: { get: async <T = unknown>(): Promise<T> => ({ items: [{ key: 'PRJ-1', title: 'First' }] }) as unknown as T } }],
    });
    // root singletons + localStorage persist across tests in a worker — pin
    // the language so label filtering is deterministic.
    TestBed.inject(I18n).set('en');
    const f = TestBed.createComponent(PaletteHost);
    const svc = TestBed.inject(CommandPalette);
    return { f, svc };
  }

  it('hidden by default; show() renders commands filtered by query; Enter runs the active one', async () => {
    const { f, svc } = paletteSetup();
    await flush(f);
    expect(f.nativeElement.querySelector('[data-testid="command-palette"]')).toBeNull();
    svc.register([
      { id: 'nav:/projects', labelKey: 'nav.projects', run: () => {} },
      { id: 'nav:/settings', labelKey: 'nav.settings', run: () => {} },
    ]);
    svc.show();
    await flush(f);
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelectorAll('[role="option"]')).toHaveLength(2);
    const input = el.querySelector('[data-testid="command-input"]') as HTMLInputElement;
    input.value = 'sett';
    input.dispatchEvent(new Event('input'));
    await flush(f);
    await new Promise((r) => setTimeout(r, 300)); // debounce
    await flush(f);
    // command options only (the live search hits render their own options)
    expect(el.querySelectorAll('[role="option"]:not(.ui-cmdk-hit)').length).toBe(1);
    (input as HTMLInputElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(svc.open()).toBe(false);
  });

  it("'?' opens the help dialog; Escape closes; arrow keys move the active row", async () => {
    const { f, svc } = paletteSetup();
    await flush(f);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
    await flush(f);
    expect(f.nativeElement.querySelector('[data-testid="help-dialog"]')).toBeTruthy();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush(f);
    expect(f.nativeElement.querySelector('[data-testid="help-dialog"]')).toBeNull();

    svc.register([
      { id: 'a', labelKey: 'nav.projects', run: () => {} },
      { id: 'b', labelKey: 'nav.settings', run: () => {} },
    ]);
    svc.show();
    await flush(f);
    // arrows are handled by the query input (list navigation), not the doc handler
    const input = f.nativeElement.querySelector('[data-testid="command-input"]') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await flush(f);
    const opts = f.nativeElement.querySelectorAll('[role="option"]:not(.ui-cmdk-hit)');
    expect(opts[1].classList.contains('active')).toBe(true);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await flush(f);
    expect(f.nativeElement.querySelectorAll('[role="option"]:not(.ui-cmdk-hit)')[0].classList.contains('active')).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush(f);
    expect(svc.open()).toBe(false);
  });

  it("'c' navigates to /work-items?new=1; search hits navigate to the item", async () => {
    const { f, svc } = paletteSetup();
    const router = TestBed.inject(Router);
    await flush(f);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
    await f.whenStable();
    expect(router.url).toBe('/work-items?new=1');

    svc.register([{ id: 'x', labelKey: 'nav.projects', run: () => {} }]);
    svc.show();
    await flush(f);
    const input = f.nativeElement.querySelector('[data-testid="command-input"]') as HTMLInputElement;
    input.value = 'fir';
    input.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 350));
    await flush(f);
    const hit = f.nativeElement.querySelector('.ui-cmdk-hit') as HTMLElement;
    expect(hit?.textContent).toContain('PRJ-1');
    hit.click();
    await f.whenStable();
    expect(router.url).toBe('/work-items/PRJ-1');
  });
});

describe('ProjectPickerCmp', () => {
  @Component({ standalone: true, imports: [ProjectPickerCmp], template: `<ui-project-picker />` })
  class PickerHost {}

  function pickerSetup() {
    TestBed.configureTestingModule({
      imports: [PickerHost],
      providers: [provideRouter(ROUTES), { provide: ApiClient, useValue: { get: async <T = unknown>(): Promise<T> => ({ items: [] }) as unknown as T } }],
    });
    const f = TestBed.createComponent(PickerHost);
    return { f, ctx: TestBed.inject(ProjectContext) };
  }

  it('loading skeleton -> list with KEY · Name options -> select() on change', async () => {
    const { f, ctx } = pickerSetup();
    ctx.loading.set(true);
    await flush(f);
    expect(f.nativeElement.querySelector('.ui-picker ui-loading')).toBeTruthy();

    ctx.loading.set(false);
    ctx.projects.set([
      { id: 'p1', key: 'PRJ', name: 'Alpha', status: 'active' },
      { id: 'p2', key: 'BET', name: 'Beta', status: 'active' },
    ]);
    ctx.selectedId.set('p1');
    await flush(f);
    const select = f.nativeElement.querySelector('[data-testid="project-select"]') as HTMLSelectElement;
    expect(select.value).toBe('p1');
    const opts = select.querySelectorAll('option');
    expect(opts[0].textContent?.trim()).toBe('PRJ · Alpha');
    select.value = 'p2';
    select.dispatchEvent(new Event('change'));
    expect(ctx.selectedId()).toBe('p2');
  });

  it('error state shows retry (message goes to a toast); empty state when no projects', async () => {
    const { f, ctx } = pickerSetup();
    ctx.loading.set(false);
    ctx.error.set('boom');
    await flush(f);
    const err = f.nativeElement.querySelector('[data-testid="project-picker-error"]')!;
    expect(err.textContent).toContain('Retry');
    expect(f.nativeElement.querySelector('.ui-error')).toBeNull();
    const retry = f.nativeElement.querySelector('.ui-picker button') as HTMLButtonElement;
    retry.click(); // calls ctx.load() — api stub returns empty
    await f.whenStable();
    expect(ctx.error()).toBe('');
    ctx.projects.set([]);
    ctx.selectedId.set(null);
    await flush(f);
    expect(f.nativeElement.querySelector('.ui-empty')).toBeTruthy();
  });
});

describe('UiNavCurrent', () => {
  it('sets aria-current on the active routerLink anchor only', async () => {
    @Component({
      standalone: true,
      imports: [UiNavCurrent, RouterLink],
      template: `<a routerLink="/x" data-testid="lx">X</a><a routerLink="/y" data-testid="ly">Y</a>`,
    })
    class H {}
    TestBed.configureTestingModule({ imports: [H], providers: [provideRouter(ROUTES)] });
    const f = TestBed.createComponent(H);
    await flush(f);
    const lx = f.nativeElement.querySelector('[data-testid="lx"]')!;
    const ly = f.nativeElement.querySelector('[data-testid="ly"]')!;
    expect(lx.getAttribute('aria-current')).toBeNull();
    const router = TestBed.inject(Router);
    await router.navigate(['/x']);
    await flush(f);
    expect(lx.getAttribute('aria-current')).toBe('page');
    expect(ly.getAttribute('aria-current')).toBeNull();
    f.destroy(); // unsubscribe path
  });
});

describe('UiToasts', () => {
  @Component({ standalone: true, imports: [UiToasts], template: `<ui-toasts />` })
  class ToastHost {}

  it('renders kinds + roles; action runs and dismisses; clicking the toast dismisses', async () => {
    TestBed.configureTestingModule({ imports: [ToastHost] });
    const f = TestBed.createComponent(ToastHost);
    const svc = TestBed.inject(UiToastService);
    let undone = false;
    svc.show('saved', 'ok', 60_000);
    svc.show('boom', 'error', 60_000);
    svc.show('undo me', 'info', 60_000, { label: 'Undo', run: () => (undone = true) });
    await flush(f);
    const el = f.nativeElement as HTMLElement;
    const toasts = el.querySelectorAll('.ui-toast');
    expect(toasts).toHaveLength(3);
    expect(toasts[1].getAttribute('role')).toBe('alert');
    expect(toasts[0].getAttribute('role')).toBe('status');
    (toasts[2].querySelector('button') as HTMLButtonElement).click();
    expect(undone).toBe(true);
    await flush(f);
    expect(el.querySelectorAll('.ui-toast')).toHaveLength(2);
    (el.querySelector('.ui-toast') as HTMLElement).click();
    await flush(f);
    expect(el.querySelectorAll('.ui-toast')).toHaveLength(1);
  });
});
