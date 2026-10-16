import { Injectable, signal } from '@angular/core';
import { resolveTheme } from './logic';

export { resolveTheme };

/**
 * Theme tokens (docs/FRONTEND_EXECUTION_PLAN.md §3 / DSN-T01..T05).
 * Three-state cycle: system → light → dark. Stored in the `forgepm_theme`
 * cookie so the pre-Angular bootstrap script in index.html can apply the
 * resolved theme before first paint (no flash). Application model:
 * - `theme-dark` class on <html>  → force dark vars
 * - `theme-light` class on <html> → force light vars (suppresses the media query)
 * - neither class                 → follow `prefers-color-scheme`
 */
export type ThemeChoice = 'system' | 'light' | 'dark';

const COOKIE = 'forgepm_theme';
const ORDER: ThemeChoice[] = ['system', 'light', 'dark'];
const YEAR = 60 * 60 * 24 * 365;

@Injectable({ providedIn: 'root' })
export class Tokens {
  readonly theme = signal<ThemeChoice>('system');
  readonly systemDark = signal(false);

  init(): void {
    const mql = window.matchMedia?.('(prefers-color-scheme: dark)');
    this.systemDark.set(mql?.matches ?? false);
    mql?.addEventListener('change', (e) => {
      this.systemDark.set(e.matches);
      this.apply();
    });
    const m = document.cookie.match(/(?:^|; )forgepm_theme=([^;]*)/);
    const raw = m ? decodeURIComponent(m[1]) : '';
    this.theme.set(ORDER.includes(raw as ThemeChoice) ? (raw as ThemeChoice) : 'system');
    this.apply();
  }

  /** system → light → dark → system */
  cycle(): void {
    this.set(ORDER[(ORDER.indexOf(this.theme()) + 1) % ORDER.length]);
  }

  set(t: ThemeChoice): void {
    this.theme.set(t);
    document.cookie = `${COOKIE}=${encodeURIComponent(t)}; path=/; max-age=${YEAR}; SameSite=Lax`;
    this.apply();
  }

  private apply(): void {
    const root = document.documentElement;
    const dark = resolveTheme(this.theme(), this.systemDark()) === 'dark';
    root.classList.toggle('theme-dark', dark);
    root.classList.toggle('theme-light', !dark);
    root.style.colorScheme = dark ? 'dark' : 'light';
  }
}
