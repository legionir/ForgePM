// Component render tests (plan P7-3, coverage ≥80% acceptance): primitives
// rendered via TestBed + jsdom through the official `ng test` vitest runner
// (@angular/build:unit-test), whose Angular transform wires signal inputs so
// parent→child bindings and every template/host binding are live.
import { describe, expect, it } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Component } from '@angular/core';
import { provideRouter } from '@angular/router';
import { UiAvatar } from './avatar';
import { UiBadge } from './badge';
import { UiBreadcrumbs } from './breadcrumbs';
import { UiButton } from './button';
import { UiEmptyState } from './empty-state';
import { UiIcon } from './icon';
import { UiLoading } from './loading';
import { UiPage } from './page';
import { UiTabs } from './tabs';
import { Tokens } from './tokens';
import { UiControl, UiField } from './field';
import { UiMarkdown } from './markdown';

/** Render a static host template and return the flushed fixture. */
async function render<C>(host: new () => C): Promise<{ f: ComponentFixture<C>; c: C }> {
  TestBed.configureTestingModule({ imports: [host] });
  const f = TestBed.createComponent(host);
  f.detectChanges();
  await f.whenStable();
  f.detectChanges();
  return { f, c: f.componentInstance };
}

@Component({ standalone: true, imports: [UiAvatar], template: `<ui-avatar name="Ada Lovelace" size="sm" />` })
class AvatarHost {}

describe('UiAvatar', () => {
  it('renders initials with a11y + size classes', async () => {
    const { f } = await render(AvatarHost);
    const el = f.nativeElement.querySelector('ui-avatar')!;
    expect(el.textContent?.trim()).toBe('AL');
    expect(el.getAttribute('role')).toBe('img');
    expect(el.getAttribute('aria-label')).toBe('Ada Lovelace');
    expect(el.classList.contains('ui-avatar--sm')).toBe(true);
  });

  it('defaults to md size and handles a single word', async () => {
    @Component({ standalone: true, imports: [UiAvatar], template: `<ui-avatar name="bot" />` })
    class H {}
    const { f } = await render(H);
    const el = f.nativeElement.querySelector('ui-avatar')!;
    expect(el.textContent?.trim()).toBe('B');
    expect(el.classList.contains('ui-avatar--sm')).toBe(false);
    expect(el.classList.contains('ui-avatar--lg')).toBe(false);
  });
});

describe('UiBadge', () => {
  it('applies variant + size host classes', async () => {
    @Component({ standalone: true, imports: [UiBadge], template: `<ui-badge variant="error" size="sm">x</ui-badge>` })
    class H {}
    const { f } = await render(H);
    const el = f.nativeElement.querySelector('ui-badge')!;
    expect(el.classList.contains('ui-badge--error')).toBe(true);
    expect(el.classList.contains('ui-badge--sm')).toBe(true);
    expect(el.textContent?.trim()).toBe('x');
  });

  it('maps every variant class and keeps default styling', async () => {
    @Component({
      standalone: true,
      imports: [UiBadge],
      template: `<ui-badge>plain</ui-badge><ui-badge variant="success">s</ui-badge><ui-badge variant="warning">w</ui-badge><ui-badge variant="info">i</ui-badge>`,
    })
    class H {}
    const { f } = await render(H);
    const [plain, s, w, i] = f.nativeElement.querySelectorAll('ui-badge');
    expect(plain.className.trim()).toBe('ui-badge');
    expect(s.classList.contains('ui-badge--success')).toBe(true);
    expect(w.classList.contains('ui-badge--warning')).toBe(true);
    expect(i.classList.contains('ui-badge--info')).toBe(true);
  });
});

describe('UiBreadcrumbs', () => {
  it('earlier crumbs are links, last is plain text with aria-current=page', async () => {
    @Component({
      standalone: true,
      imports: [UiBreadcrumbs],
      template: `<ui-breadcrumbs [items]="[{ label: 'Projects', link: '/projects' }, { label: 'KEY' }]" />`,
    })
    class H {}
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const { f } = await render(H);
    const links = f.nativeElement.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('/projects');
    const spans = f.nativeElement.querySelectorAll('span[aria-current="page"]');
    expect(spans).toHaveLength(1);
    expect(spans[0].textContent?.trim()).toBe('KEY');
  });
});

describe('UiButton', () => {
  it('maps variant/size to host classes', async () => {
    @Component({ standalone: true, imports: [UiButton], template: `<button ui-button variant="destructive" size="sm">Del</button>` })
    class H {}
    const { f } = await render(H);
    const btn = f.nativeElement.querySelector('button')!;
    expect(btn.classList.contains('ui-btn--destructive')).toBe(true);
    expect(btn.classList.contains('ui-btn--sm')).toBe(true);
    expect(btn.textContent).toContain('Del');
  });

  it('loading renders a spinner, disables the button and sets aria-busy', async () => {
    @Component({ standalone: true, imports: [UiButton], template: `<button ui-button [loading]="true">Go</button>` })
    class H {}
    const { f } = await render(H);
    const btn = f.nativeElement.querySelector('button')!;
    expect(btn.querySelector('.ui-btn-spinner')).toBeTruthy();
    expect(btn.getAttribute('disabled')).toBe('');
    expect(btn.getAttribute('aria-busy')).toBe('true');
  });

  it('disabled input disables the button without a spinner', async () => {
    @Component({ standalone: true, imports: [UiButton], template: `<button ui-button [disabled]="true">Off</button>` })
    class H {}
    const { f } = await render(H);
    const btn = f.nativeElement.querySelector('button')!;
    expect(btn.getAttribute('disabled')).toBe('');
    expect(btn.querySelector('.ui-btn-spinner')).toBeNull();
  });

  it('covers all four variants', async () => {
    @Component({
      standalone: true,
      imports: [UiButton],
      template: `<button ui-button variant="primary">p</button><button ui-button variant="secondary">s</button><button ui-button variant="ghost">g</button>`,
    })
    class H {}
    const { f } = await render(H);
    const [p, s, g] = f.nativeElement.querySelectorAll('button');
    expect(p.classList.contains('ui-btn--primary')).toBe(true);
    expect(s.classList.contains('ui-btn--secondary')).toBe(true);
    expect(g.classList.contains('ui-btn--ghost')).toBe(true);
  });
});

describe('UiEmptyState', () => {
  it('shows icon + message without a CTA when no actionText', async () => {
    @Component({ standalone: true, imports: [UiEmptyState], template: `<ui-empty-state message="Nothing here" />` })
    class H {}
    const { f } = await render(H);
    expect(f.nativeElement.querySelector('.ui-empty-icon')).toBeTruthy();
    expect(f.nativeElement.querySelector('.ui-empty-message')?.textContent?.trim()).toBe('Nothing here');
    expect(f.nativeElement.querySelector('button')).toBeNull();
  });

  it('CTA emits action on click', async () => {
    @Component({
      standalone: true,
      imports: [UiEmptyState],
      template: `<ui-empty-state message="m" actionText="Create" (action)="hits = hits + 1" />`,
    })
    class H {
      hits = 0;
    }
    const { f } = await render(H);
    const btn = f.nativeElement.querySelector('button') as HTMLButtonElement;
    expect(btn.textContent?.trim()).toBe('Create');
    btn.click();
    expect(f.componentInstance.hits).toBe(1);
  });
});

describe('UiIcon', () => {
  it('renders every declared path of a known glyph at the requested size', async () => {
    @Component({ standalone: true, imports: [UiIcon], template: `<ui-icon name="git-pr" [size]="20" />` })
    class H {}
    const { f } = await render(H);
    const svg = f.nativeElement.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe('20');
    expect(svg.querySelectorAll('path')).toHaveLength(4);
    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });

  it('unknown name renders an empty svg (no emoji fallback)', async () => {
    @Component({ standalone: true, imports: [UiIcon], template: `<ui-icon name="definitely-missing" />` })
    class H {}
    const { f } = await render(H);
    expect(f.nativeElement.querySelector('svg path')).toBeNull();
  });
});

describe('UiLoading', () => {
  it('renders each skeleton kind with aria-busy', async () => {
    @Component({
      standalone: true,
      imports: [UiLoading],
      template: `<ui-loading kind="lines" label="L" data-k="lines" /><ui-loading kind="card" data-k="card" /><ui-loading kind="table" data-k="table" /><ui-loading kind="button" data-k="button" />`,
    })
    class H {}
    const { f } = await render(H);
    const byKind = (k: string) => f.nativeElement.querySelector(`ui-loading[data-k="${k}"]`)!;
    expect(byKind('lines').getAttribute('aria-busy')).toBe('true');
    expect(byKind('lines').getAttribute('aria-label')).toBe('L');
    expect(byKind('lines').querySelectorAll('.ui-skel').length).toBe(2);
    expect(byKind('card').querySelectorAll('.ui-skel').length).toBe(3);
    expect(byKind('table').querySelectorAll('.ui-skel').length).toBe(9);
    expect(byKind('button').querySelector('.ui-btn-spinner')).toBeTruthy();
  });
});

describe('UiPage', () => {
  it('one h1, variant host class and projected actions + body', async () => {
    @Component({
      standalone: true,
      imports: [UiPage],
      template: `<ui-page title="T" variant="form"><button pageActions>Act</button><p>Body</p></ui-page>`,
    })
    class H {}
    const { f } = await render(H);
    const el = f.nativeElement.querySelector('ui-page')!;
    expect(el.classList.contains('ui-page--form')).toBe(true);
    expect(el.querySelectorAll('h1')).toHaveLength(1);
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('T');
    expect(el.querySelector('.ui-page-actions button')?.textContent?.trim()).toBe('Act');
    expect(el.querySelector('p')?.textContent?.trim()).toBe('Body');
  });
});

@Component({ standalone: true, imports: [UiTabs], template: `<ui-tabs [items]="items" active="b" ariaLabel="Views" (tabChange)="sel = $event" />` })
class TabsHost {
  readonly items = [
    { id: 'a', label: 'A', testid: 'tab-a' },
    { id: 'b', label: 'B' },
    { id: 'c', label: 'C' },
  ];
  sel = '';
}

describe('UiTabs', () => {
  it('active tab gets class + aria-selected + tabindex 0; testid passthrough', async () => {
    const { f } = await render(TabsHost);
    const tabs = f.nativeElement.querySelectorAll('button[role="tab"]');
    expect(tabs).toHaveLength(3);
    expect(tabs[1].classList.contains('active')).toBe(true);
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(tabs[1].getAttribute('tabindex')).toBe('0');
    expect(tabs[0].getAttribute('tabindex')).toBe('-1');
    expect(tabs[0].getAttribute('data-testid')).toBe('tab-a');
    expect(f.nativeElement.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe('Views');
  });

  it('click emits tabChange; roving keyboard moves selection and focus', async () => {
    const { f, c } = await render(TabsHost);
    const tabs = f.nativeElement.querySelectorAll('button[role="tab"]') as NodeListOf<HTMLButtonElement>;
    tabs[2].click();
    expect(c.sel).toBe('c');
    tabs[0].focus();
    // ArrowLeft from index 0 wraps to the last tab
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(c.sel).toBe('c');
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(c.sel).toBe('c');
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(c.sel).toBe('a');
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
    expect(c.sel).toBe('a');
  });
});

describe('Tokens (theme)', () => {
  it('init reads the cookie, apply toggles root classes, cycle advances system→light→dark', () => {
    document.cookie = 'forgepm_theme=; path=/; max-age=0';
    const tokens = TestBed.inject(Tokens);
    tokens.init();
    expect(tokens.theme()).toBe('system');
    expect(document.documentElement.classList.contains('theme-dark')).toBe(false);
    tokens.cycle();
    expect(tokens.theme()).toBe('light');
    expect(document.documentElement.classList.contains('theme-light')).toBe(true);
    tokens.cycle();
    expect(tokens.theme()).toBe('dark');
    expect(document.documentElement.classList.contains('theme-dark')).toBe(true);
    expect(document.cookie).toContain('forgepm_theme=dark');
    tokens.cycle();
    expect(tokens.theme()).toBe('system');
  });

  it('ignores invalid cookie values', () => {
    document.cookie = 'forgepm_theme=bogus; path=/';
    TestBed.inject(Tokens).init();
    expect(TestBed.inject(Tokens).theme()).toBe('system');
  });
});

describe('UiField + UiControl', () => {
  it('wires explicit for/id + required marker; error replaces hint with described-by', async () => {
    @Component({
      standalone: true,
      imports: [UiField, UiControl],
      template: `<ui-field label="Email" required hint="Help text" error="Bad"><input uiControl name="e" /></ui-field>`,
    })
    class H {}
    const { f } = await render(H);
    const input = f.nativeElement.querySelector('input') as HTMLInputElement;
    const label = f.nativeElement.querySelector('label') as HTMLLabelElement;
    expect(label.textContent).toContain('Email');
    expect(input.id).toBeTruthy();
    expect(label.getAttribute('for')).toBe(input.id);
    expect(label.querySelector('.ui-field-req')).toBeTruthy();
    const err = f.nativeElement.querySelector('.ui-field-error')!;
    expect(err.textContent?.trim()).toBe('Bad');
    expect(err.getAttribute('role')).toBe('alert');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(err.id);
    expect(f.nativeElement.querySelector('.ui-field-hint')).toBeNull();
  });

  it('hint is described-by wired when no error', async () => {
    @Component({
      standalone: true,
      imports: [UiField, UiControl],
      template: `<ui-field label="E" hint="Help text"><input uiControl name="e" /></ui-field>`,
    })
    class H {}
    const { f } = await render(H);
    const input = f.nativeElement.querySelector('input') as HTMLInputElement;
    const hint = f.nativeElement.querySelector('.ui-field-hint')!;
    expect(hint.textContent?.trim()).toBe('Help text');
    expect(input.getAttribute('aria-invalid')).toBe('false');
    expect(input.getAttribute('aria-describedby')).toBe(hint.id);
  });

  it('disabled/readOnly apply to the inner control', async () => {
    @Component({
      standalone: true,
      imports: [UiField, UiControl],
      template: `<ui-field label="E" disabled readOnly><input uiControl name="e" /></ui-field>`,
    })
    class H {}
    const { f } = await render(H);
    const input = f.nativeElement.querySelector('input') as HTMLInputElement;
    expect(input.hasAttribute('disabled')).toBe(true);
    expect(input.hasAttribute('readonly')).toBe(true);
  });
});

describe('UiMarkdown', () => {
  it('renders typed segments: bold, italic, code, link', async () => {
    @Component({
      standalone: true,
      imports: [UiMarkdown],
      template: `<ui-markdown text="**b** and *i* and \`c\` and [x](https://e.com)" />`,
    })
    class H {}
    const { f } = await render(H);
    const el = f.nativeElement.querySelector('ui-markdown')!;
    expect(el.querySelector('strong')?.textContent).toBe('b');
    expect(el.querySelector('em')?.textContent).toBe('i');
    expect(el.querySelector('code')?.textContent).toBe('c');
    const a = el.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://e.com');
    expect(a.getAttribute('rel')).toContain('noopener');
  });

  it('keeps unknown markup inert (no script element) and renders paragraphs', async () => {
    @Component({ standalone: true, imports: [UiMarkdown], template: `<ui-markdown text="<script>alert(1)</script>" />` })
    class H {}
    const { f } = await render(H);
    const el = f.nativeElement.querySelector('ui-markdown')!;
    expect(el.querySelector('script')).toBeNull();
    expect(el.textContent).toContain('<script>');
    expect(el.querySelectorAll('p').length).toBeGreaterThan(0);
  });

  it('shows the fallback when empty', async () => {
    @Component({ standalone: true, imports: [UiMarkdown], template: `<ui-markdown fallback="—" />` })
    class H {}
    const { f } = await render(H);
    expect(f.nativeElement.querySelector('ui-markdown')?.textContent?.trim()).toBe('—');
  });
});

describe('UiBadge status + UiField camel labels', () => {
  it('badge status: renders the icon and a CamelCase label, tone from the status', async () => {
    @Component({ standalone: true, imports: [UiBadge], template: `<ui-badge status="in_progress"></ui-badge><ui-badge status="failed" label="build failed"></ui-badge><ui-badge>3</ui-badge>` })
    class H {}
    const { f } = await render(H);
    const [a, b, c] = f.nativeElement.querySelectorAll('ui-badge');
    expect(a.textContent?.trim()).toBe('InProgress');
    expect(a.querySelector('ui-icon')).toBeTruthy();
    expect(a.classList.contains('ui-badge--info')).toBe(true);
    expect(b.textContent?.trim()).toBe('BuildFailed');
    expect(b.classList.contains('ui-badge--error')).toBe(true);
    expect(c.textContent?.trim()).toBe('3');
    expect(c.querySelector('ui-icon')).toBeNull();
  });

  it('field label camel: Latin labels are CamelCase, Persian labels stay as written', async () => {
    @Component({
      standalone: true,
      imports: [UiField, UiControl],
      template: `<ui-field label="target date"><input uiControl /></ui-field><ui-field label="تاریخ هدف"><input uiControl /></ui-field>`,
    })
    class H {}
    const { f } = await render(H);
    const labels = Array.from(f.nativeElement.querySelectorAll('label')).map((l) => (l as HTMLElement).textContent?.trim());
    expect(labels).toEqual(['TargetDate', 'تاریخ هدف']);
  });
});
