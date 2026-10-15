import { ChangeDetectionStrategy, Component, ElementRef, Injectable, inject, signal, viewChild } from '@angular/core';
import { I18n } from '../i18n';
import { filterCommands } from './logic';

export { filterCommands };

/** One runnable palette entry (label resolved lazily for i18n). */
export interface UiCommand {
  id: string;
  labelKey: string;
  run: () => void;
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
 * Palette overlay: role=dialog + aria-modal, focus moves to the input and
 * returns to the opener on close. Keyboard: Cmd/Ctrl+K toggles anywhere,
 * `/` opens when not typing, ArrowUp/Down move, Enter runs, Escape closes.
 */
@Component({
  selector: 'ui-command-palette',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (svc.open()) {
      <div class="ui-cmdk-backdrop" (click)="svc.hide()"></div>
      <div class="ui-cmdk" role="dialog" aria-modal="true" [attr.aria-label]="i18n.instant('command.title')" data-testid="command-palette">
        <input
          #q
          class="ui-cmdk-input"
          type="text"
          [value]="query()"
          (input)="query.set(q.value); active.set(0)"
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
        <p class="ui-cmdk-hint">⌘K / Ctrl+K</p>
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

  private readonly input = viewChild<ElementRef<HTMLInputElement>>('q');

  readonly query = signal('');
  readonly active = signal(0);

  readonly results = () => filterCommands(this.svc.commands(), this.query(), (c) => this.i18n.instant(c.labelKey));

  onDocKeydown(ev: KeyboardEvent): void {
    const t = ev.target as HTMLElement | null;
    const typing =
      !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if ((ev.key === 'k' || ev.key === 'K') && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      this.svc.toggle();
    } else if (ev.key === '/' && !typing && !this.svc.open()) {
      ev.preventDefault();
      this.svc.show();
    } else if (ev.key === 'Escape' && this.svc.open()) {
      this.svc.hide();
    }
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
    this.query.set('');
    this.active.set(0);
    c.run();
  }
}
