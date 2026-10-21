import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { UiButton } from '../ui/button';
import { UiPage } from '../ui/page';
import { UiField, UiControl } from '../ui/field';
import { ProjectContext } from '../project-context';
// local minimal validation mirrors execPolicySchema: version:number, rules:array
const isValidPolicy = (v: unknown): { ok: boolean; msg?: string } => {
  if (!v || typeof v !== 'object') return { ok: false, msg: 'must be object' };
  const o = v as Record<string, unknown>;
  if (typeof o['version'] !== 'number') return { ok: false, msg: 'version:number required' };
  if (!Array.isArray(o['rules'])) return { ok: false, msg: 'rules:array required' };
  return { ok: true };
};

@Component({
  selector: 'page-exec-policy',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, UiButton, UiPage, UiField, UiControl],
  template: `
    <ui-page data-testid="exec-policy" [title]="i18n.instant('exec.policy_title')">
      <p data-testid="exec-policy-desc">{{ i18n.instant('exec.policy_desc') }}</p>
      @if (error()) {
        <p class="ui-error" role="alert" data-testid="exec-policy-error">{{ error() }}</p>
      }
      <ui-field [label]="i18n.instant('exec.policy_json')">
        <textarea uiControl name="policy" [(ngModel)]="jsonText" rows="20" data-testid="exec-policy-input"></textarea>
      </ui-field>
      @if (validation()) {
        <p class="ui-error" data-testid="exec-policy-validation">{{ validation() }}</p>
      }
      @if (diff()) {
        <pre data-testid="exec-policy-diff">{{ diff() }}</pre>
      }
      <button type="button" ui-button variant="secondary" (click)="validate()" data-testid="exec-policy-validate">{{ i18n.instant('exec.validate') }}</button>
      <button type="button" ui-button variant="primary" (click)="save()" [disabled]="!!validation() || !jsonText.trim()" [loading]="busy()" data-testid="exec-policy-save">{{ i18n.instant('common.save') }}</button>
      @if (saved()) { <p data-testid="exec-policy-saved">{{ i18n.instant('common.saved') }}</p> }
    </ui-page>
  `,
})
export class ExecPolicyPage implements OnInit {
  private readonly api = inject(ApiClient);
  readonly i18n = inject(I18n);
  private readonly ctx = inject(ProjectContext);

  readonly error = signal('');
  readonly busy = signal(false);
  readonly validation = signal<string | null>(null);
  readonly diff = signal<string | null>(null);
  readonly saved = signal(false);
  jsonText = '';
  private original = '';

  async ngOnInit(): Promise<void> {
    await this.ctx.ensureLoaded();
    await this.load();
  }

  async load(): Promise<void> {
    const pid = this.ctx.selectedId();
    try {
      // settings API: GET /settings/effective?scope=&scope_id=
      const q = pid ? `scope=project&scope_id=${pid}&key=exec.policy` : `scope=system&key=exec.policy`;
      const res = await this.api.get<{ value: unknown }>(`/api/v1/settings/effective?${q}`);
      this.jsonText = JSON.stringify(res.value ?? {}, null, 2);
      this.original = this.jsonText;
      this.validate();
    } catch (e) {
      // if not found, load default
      this.jsonText = JSON.stringify({ version: 1, default_level: 'review', rules: [] }, null, 2);
      this.original = this.jsonText;
      this.error.set((e as Error).message);
    }
  }

  validate(): void {
    try {
      const parsed = JSON.parse(this.jsonText);
      const result = isValidPolicy(parsed);
      if (!result.ok) {
        this.validation.set(result.msg ?? 'invalid');
        this.diff.set(null);
        return;
      }
      this.validation.set(null);
      if (this.original && this.original !== this.jsonText) {
        this.diff.set(this.computeDiff(this.original, this.jsonText));
      } else {
        this.diff.set(null);
      }
    } catch (e) {
      this.validation.set((e as Error).message);
      this.diff.set(null);
    }
  }

  computeDiff(a: string, b: string): string {
    const al = a.split('\n');
    const bl = b.split('\n');
    let out = '';
    const max = Math.max(al.length, bl.length);
    for (let i = 0; i < max; i++) {
      if (al[i] !== bl[i]) {
        if (al[i] !== undefined) out += `- ${al[i]}\n`;
        if (bl[i] !== undefined) out += `+ ${bl[i]}\n`;
      }
    }
    return out || '(no diff)';
  }

  async save(): Promise<void> {
    this.validate();
    if (this.validation()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const pid = this.ctx.selectedId();
      const value = JSON.parse(this.jsonText);
      if (pid) {
        await this.api.put(`/api/v1/settings/project/${pid}/exec.policy`, { value });
      } else {
        await this.api.put(`/api/v1/settings/system/exec.policy`, { value });
      }
      this.original = this.jsonText;
      this.diff.set(null);
      this.saved.set(true);
      setTimeout(() => this.saved.set(false), 2000);
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
