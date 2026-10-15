import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { UiButton } from '../ui/button';
import { UiPage } from '../ui/page';
import { UiTabItem, UiTabs } from '../ui/tabs';
import { ProjectContext } from '../project-context';
import { ProjectPickerCmp } from '../ui/project-picker';

interface DefDto {
  key: string;
  category: string;
  default: unknown;
}
interface EffDto {
  key: string;
  value: unknown;
  source: 'system' | 'organization' | 'project' | 'default';
}

/**
 * Settings (plan §5.7/§5.11, §11): registry-driven editor for two scopes
 * (system and project), each key showing its effective value + source badge
 * ("inherited" vs "override"), an override control and "back to inherited"
 * (DELETE). This closes the §1 panel requirement that was backend-only so far.
 */
@Component({
  selector: 'page-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ProjectPickerCmp, UiButton, UiPage, UiTabs],
  template: `
    <ui-page data-testid="settings" [title]="i18n.instant('settings.title')">

      <ui-tabs [items]="scopeTabs" [active]="scope()" [ariaLabel]="i18n.instant('settings.scope')" (tabChange)="setScope($event)" />

      @if (scope() === 'project') {
        <ui-project-picker />
      }

      <table class="ui-table" data-testid="settings-table">
        <thead>
          <tr>
            <th>{{ i18n.instant('common.key') }}</th>
            <th>{{ i18n.instant('settings.source') }}</th>
            <th>{{ i18n.instant('settings.value') }}</th>
            <th>{{ i18n.instant('settings.scope') }}</th>
          </tr>
        </thead>
        <tbody>
          @for (row of rows(); track row.key) {
            <tr data-testid="setting-row">
              <td>{{ row.key }}</td>
              <td data-testid="setting-source">{{ row.source }}</td>
              <td>
                <input [name]="row.key" [ngModel]="row.input" (ngModelChange)="setInput(row.key, $event)" data-testid="setting-input" />
              </td>
              <td>
                <button type="button" ui-button (click)="override(row)" [disabled]="busy()" data-testid="setting-override">
                  {{ i18n.instant('settings.override') }}
                </button>
                @if (row.source === scope()) {
                  <button type="button" ui-button (click)="inherit(row.key)" [disabled]="busy()" data-testid="setting-inherit">
                    {{ i18n.instant('settings.inherit') }}
                  </button>
                }
              </td>
            </tr>
          }
        </tbody>
      </table>
      @if (error()) {
        <p class="ui-error" role="alert" data-testid="settings-error">{{ error() }}</p>
      }
    </ui-page>
  `,
})
export class SettingsPage implements OnInit {
  private readonly api = inject(ApiClient);
  readonly i18n = inject(I18n);
  readonly ctx = inject(ProjectContext);

  readonly scope = signal<'system' | 'project'>('system');
  readonly busy = signal(false);

  get scopeTabs(): UiTabItem[] {
    return [
      { id: 'system', label: this.i18n.instant('settings.scope_system'), testid: 'scope-system' },
      { id: 'project', label: this.i18n.instant('settings.scope_project'), testid: 'scope-project' },
    ];
  }

  readonly rows = signal<Row[]>([]);
  readonly error = signal('');
  private defs: DefDto[] = [];

  async ngOnInit(): Promise<void> {
    this.error.set('');
    try {
      await this.ctx.load();
      this.defs = (await this.api.get<{ settings: DefDto[] }>('/api/v1/settings/registry')).settings;
      await this.refresh();
    } catch (err) {
      this.error.set((err as Error).message);
    }
  }

  /** Immutable row edit (FRM-006): never mutate objects held by a signal. */
  setInput(key: string, value: string): void {
    this.rows.update((list) => list.map((r) => (r.key === key ? { ...r, input: value } : r)));
  }

  setScope(v: string): void {
    this.scope.set(v as 'system' | 'project');
    void this.refresh();
  }

  private scopeId(): string {
    return this.scope() === 'system' ? '-' : (this.ctx.selectedId() ?? '');
  }

  async refresh(): Promise<void> {
    const sid = this.scopeId();
    if (this.scope() === 'project' && !sid) return;
    this.error.set('');
    try {
      const rows: Row[] = [];
      for (const d of this.defs) {
        const eff = await this.api.get<EffDto>(
          `/api/v1/settings/effective?key=${encodeURIComponent(d.key)}&scope=${this.scope()}&scope_id=${sid}`,
        );
        rows.push({ key: d.key, value: eff.value, source: eff.source, input: display(d.default, eff.value) });
      }
      this.rows.set(rows);
    } catch (err) {
      this.error.set((err as Error).message);
    }
  }

  async override(row: Row): Promise<void> {
    this.error.set('');
    this.busy.set(true);
    try {
      await this.api.put(`/api/v1/settings/${this.scope()}/${this.scopeId()}/${row.key}`, { value: parse(row.input) });
      await this.refresh();
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  async inherit(key: string): Promise<void> {
    this.error.set('');
    this.busy.set(true);
    try {
      await this.api.send('DELETE', `/api/v1/settings/${this.scope()}/${this.scopeId()}/${key}`);
      await this.refresh();
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}

interface Row {
  key: string;
  value: unknown;
  source: string;
  input: string;
}

function display(def: unknown, eff: unknown): string {
  const v = eff !== undefined && eff !== null ? eff : def;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** Booleans/numbers arrive as JSON text; anything else stays a string. */
function parse(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return s;
  }
}
