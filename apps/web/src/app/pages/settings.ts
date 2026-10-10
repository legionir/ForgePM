import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
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
  imports: [FormsModule, ProjectPickerCmp],
  template: `
    <section data-testid="settings">
      <h1>{{ i18n.instant('settings.title') }}</h1>

      <nav class="tabs" aria-label="Scope">
        <button type="button" [class.active]="scope() === 'system'" (click)="setScope('system')" data-testid="scope-system">
          {{ i18n.instant('settings.scope_system') }}
        </button>
        <button type="button" [class.active]="scope() === 'project'" (click)="setScope('project')" data-testid="scope-project">
          {{ i18n.instant('settings.scope_project') }}
        </button>
      </nav>

      @if (scope() === 'project') {
        <ui-project-picker />
      }

      <table class="grid" data-testid="settings-table">
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
                <input [name]="row.key" [(ngModel)]="row.input" data-testid="setting-input" />
              </td>
              <td>
                <button type="button" (click)="override(row)" data-testid="setting-override">
                  {{ i18n.instant('settings.override') }}
                </button>
                @if (row.source === scope()) {
                  <button type="button" (click)="inherit(row.key)" data-testid="setting-inherit">
                    {{ i18n.instant('settings.inherit') }}
                  </button>
                }
              </td>
            </tr>
          }
        </tbody>
      </table>
      @if (error()) {
        <p class="error" data-testid="settings-error">{{ error() }}</p>
      }
    </section>
  `,
})
export class SettingsPage implements OnInit {
  private readonly api = inject(ApiClient);
  readonly i18n = inject(I18n);
  readonly ctx = inject(ProjectContext);

  readonly scope = signal<'system' | 'project'>('system');
  readonly rows = signal<Row[]>([]);
  readonly error = signal('');
  private defs: DefDto[] = [];

  async ngOnInit(): Promise<void> {
    await this.ctx.load();
    this.defs = (await this.api.get<{ settings: DefDto[] }>('/api/v1/settings/registry')).settings;
    await this.refresh();
  }

  setScope(s: 'system' | 'project'): void {
    this.scope.set(s);
    void this.refresh();
  }

  private scopeId(): string {
    return this.scope() === 'system' ? '-' : (this.ctx.selectedId() ?? '');
  }

  async refresh(): Promise<void> {
    const sid = this.scopeId();
    if (this.scope() === 'project' && !sid) return;
    const rows: Row[] = [];
    for (const d of this.defs) {
      const eff = await this.api.get<EffDto>(
        `/api/v1/settings/effective?key=${encodeURIComponent(d.key)}&scope=${this.scope()}&scope_id=${sid}`,
      );
      rows.push({ key: d.key, value: eff.value, source: eff.source, input: display(d.default, eff.value) });
    }
    this.rows.set(rows);
  }

  async override(row: Row): Promise<void> {
    this.error.set('');
    try {
      await this.api.put(`/api/v1/settings/${this.scope()}/${this.scopeId()}/${row.key}`, { value: parse(row.input) });
      await this.refresh();
    } catch (err) {
      this.error.set((err as Error).message);
    }
  }

  async inherit(key: string): Promise<void> {
    await this.api.send('DELETE', `/api/v1/settings/${this.scope()}/${this.scopeId()}/${key}`);
    await this.refresh();
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
