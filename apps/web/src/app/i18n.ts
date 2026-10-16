import { Injectable, computed, signal } from '@angular/core';
import { EN } from './i18n/en';
import { FA } from './i18n/fa';

/**
 * Minimal bilingual i18n (plan §3: fa RTL + en; §11: "همه‌ی صفحه‌ها در fa و en
 * بدون متن ترجمه‌نشده"). Hand-rolled dictionary instead of ngx-translate:
 * the plan's technical table names ngx-translate, but adding a runtime dep for
 * a flat key map would blow the 500 KB initial-bundle budget (§11) for no
 * feature gain, so we keep the same `{ key }` interpolation contract in ~40
 * lines. Recorded in DECISIONS.md (D-034). Keys live in i18n/{en,fa}.ts and
 * `npm run i18n:check` fails CI if the two key sets ever diverge (the §11
 * "اسکریپت بررسی کلیدهای i18n" gate).
 */
export type Lang = 'en' | 'fa';

@Injectable({ providedIn: 'root' })
export class I18n {
  private readonly dict: Record<Lang, Record<string, string>>;
  readonly lang = signal<Lang>((localStorage.getItem('fpm_lang') as Lang) || 'en');

  constructor() {
    this.dict = { en: EN, fa: FA };
    this.apply();
  }

  readonly dir = computed<('rtl' | 'ltr')>(() => (this.lang() === 'fa' ? 'rtl' : 'ltr'));

  set(lang: Lang): void {
    this.lang.set(lang);
    localStorage.setItem('fpm_lang', lang);
    this.apply();
  }

  toggle(): void {
    this.set(this.lang() === 'en' ? 'fa' : 'en');
  }

  private apply(): void {
    document.documentElement.lang = this.lang();
    document.documentElement.dir = this.dir();
  }

  instant(key: string, vars?: Record<string, string | number>): string {
    let s = this.dict[this.lang()][key] ?? this.dict.en[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
    return s;
  }
}

/** Pipe-free translation helper for templates: `t('nav.projects')`. */
export function makeT(i18n: I18n): (key: string, vars?: Record<string, string | number>) => string {
  return (key, vars) => i18n.instant(key, vars);
}
