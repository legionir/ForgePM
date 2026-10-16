import { ChangeDetectionStrategy, Component, ElementRef, Injectable, inject, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { filterCommands } from './logic';

export { filterCommands };

/** One runnable palette entry (label resolved lazily for i18n). */
export interface UiCommand {
  id: string;
  labelKey: string;
  run: () => void;
}

interface SearchHit {
  key: string;
  title: string;
}

/**
 * Command palette state (plan §10 P7-4, PLATFORM_PARITY 8.2 Cmd+K). The
 * shell registers navigation/theme/language commands; any page can open the
 * palette via the service.
 */
@Injectable({ providedIn: 'root' })
export class CommandPalette {
  readonly open = signal(false);
  readonly commands = signal<UiCommand[]>([]);

  register(cmds: UiCommand[]): void {
    this.commands.set(cmds);
  }

  show(): void {
    this.open.set(true);
  }

  hide(): void {
    this.open.set(false);
  }

  toggle(): void {
    this.open.update((v) => !v);
  }
}

/**
 * Palette overlay (P7-4 complete): static commands + LIVE work-item search
 * (`GET /api/v1/search`, debounced) + shortcut help (`?`) + `c` new-item.
 * role=dialog + aria-modal; focus moves to the input. Keyboard:
 * Cmd/Ctrl+K toggle anywhere, `/` opens when not typing, `?` opens help,
 * `c` jumps to the new-item form, Arrow/Enter run, Escape closes.
 */
@Component({
  selector: 'ui-command-palette',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (helpOpen()) {
      <div class="ui-cmdk-backdrop" (click)="helpOpen.set(false)"></div>
      <div class="ui-cmdk" role="dialog" aria-modal="true" [attr.aria-label]="i18n.instant('help.title')" data-testid="help-dialog">
        <h2 class="ui-cmdk-title">{{ i18n.instant('help.title') }}</h2>
        <ul class="ui-cmdk-list ui-help-list">
          <li><kbd>⌘K / Ctrl+K</kbd> — {{ i18n.instant('help.k_cmdk') }}</li>
          <li><kbd>/</kbd> — {{ i18n.instant('help.k_slash') }}</li>
          <li><kbd>c</kbd> — {{ i18n.instant('help.k_c') }}</li>
          <li><kbd>Esc</kbd> — {{ i18n.instant('help.k_esc') }}</li>
        </ul>
      </div>
    } @else if (svc.open()) {
      <div class="ui-cmdk-backdrop" (click)="svc.hide()"></div>
      <div class="ui-cmdk" role="dialog" aria-modal="true" [attr.aria-label]="i18n.instant('command.title')" data-testid="command-palette">
        <input
          #q
          class="ui-cmdk-input"
          type="text"
          [value]="query()"
          (input)="onQuery(q.value)"
          (keydown)="onKeydown($event)"
          [attr.placeholder]="i18n.instant('command.placeholder')"
          [attr.aria-label]="i18n.instant('command.placeholder')"
          data-testid="command-input"
        />
        <ul class="ui-cmdk-list" role="listbox">
          @for (c of results(); track c.id) {
            <li
              role="option"
              [attr.aria-selected]="$index === active()"
              [class.active]="$index === active()"
              (click)="run(c)"
              (mousemove)="active.set($index)"
            >
              {{ i18n.instant(c.labelKey) }}
            </li>
          } @empty {
            <li class="ui-cmdk-empty">{{ i18n.instant('common.empty') }}</li>
          }
        </ul>
        @if (searching()) {
          <p class="ui-cmdk-section">{{ i18n.instant('common.loading') }}</p>
        } @else if (hits().length) {
          <p class="ui-cmdk-section">{{ i18n.instant('command.results') }}</p>
          <ul class="ui-cmdk-list" role="listbox" [attr.aria-label]="i18n.instant('command.results')">
            @for (h of hits(); track h.key) {
              <li role="option" [attr.aria-selected]="false" (click)="goItem(h)" class="ui-cmdk-hit">
                <span class="ui-cmdk-hit-key">{{ h.key }}</span> {{ h.title }}
              </li>
            }
          </ul>
        }
        <p class="ui-cmdk-hint">⌘K / Ctrl+K · / · c · ?</p>
      </div>
    }
  `,
  host: {
    '(document:keydown)': 'onDocKeydown($event)',
  },
})
export class UiCommandPalette {
  readonly svc = inject(CommandPalette);
  readonly i18n = inject(I18n);
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);

  private readonly input = viewChild<ElementRef<HTMLInputElement>>('q');

  readonly query = signal('');
  readonly active = signal(0);
  readonly helpOpen = signal(false);
  readonly hits = signal<SearchHit[]>([]);
  readonly searching = signal(false);

  private searchSeq = 0;

  readonly results = () => filterCommands(this.svc.commands(), this.query(), (c) => this.i18n.instant(c.labelKey));

  onDocKeydown(ev: KeyboardEvent): void {
    const t = ev.target as HTMLElement | null;
    const typing =
      !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if ((ev.key === 'k' || ev.key === 'K') && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      this.helpOpen.set(false);
      this.svc.toggle();
    } else if (ev.key === '?' && !typing && !this.svc.open()) {
      ev.preventDefault();
      this.helpOpen.update((v) => !v);
    } else if (ev.key === 'c' && !typing && !this.svc.open() && !this.helpOpen() && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      // `c` → new work item (P6-7): route with ?new=1; the page focuses the form.
      ev.preventDefault();
      void this.router.navigate(['/work-items'], { queryParams: { new: 1 } });
    } else if (ev.key === '/' && !typing && !this.svc.open() && !this.helpOpen()) {
      ev.preventDefault();
      this.svc.show();
    } else if (ev.key === 'Escape' && (this.svc.open() || this.helpOpen())) {
      this.helpOpen.set(false);
      this.svc.hide();
    }
  }

  onQuery(value: string): void {
    this.query.set(value);
    this.active.set(0);
    // Debounced live search over the org-scoped /search endpoint (P7-4).
    const seq = ++this.searchSeq;
    const q = value.trim();
    if (q.length < 2) {
      this.hits.set([]);
      this.searching.set(false);
      return;
    }
    this.searching.set(true);
    setTimeout(async () => {
      if (seq !== this.searchSeq) return;
      try {
        const res = await this.api.get<{ items: SearchHit[] }>(`/api/v1/search?q=${encodeURIComponent(q)}&limit=5`);
        if (seq === this.searchSeq) this.hits.set(res.items);
      } catch {
        if (seq === this.searchSeq) this.hits.set([]);
      } finally {
        if (seq === this.searchSeq) this.searching.set(false);
      }
    }, 250);
  }

  onKeydown(ev: KeyboardEvent): void {
    const results = this.results();
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      this.active.update((i) => Math.min(i + 1, results.length - 1));
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      this.active.update((i) => Math.max(i - 1, 0));
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const c = results[this.active()];
      if (c) this.run(c);
    }
  }

  run(c: UiCommand): void {
    this.svc.hide();
    this.reset();
    c.run();
  }

  goItem(h: SearchHit): void {
    this.svc.hide();
    this.reset();
    void this.router.navigate(['/work-items', h.key]);
  }

  private reset(): void {
    this.query.set('');
    this.active.set(0);
    this.hits.set([]);
    this.searching.set(false);
  }
}
