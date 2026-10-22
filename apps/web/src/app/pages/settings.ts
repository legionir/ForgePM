import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { UiPage } from '../ui/page';
import { UiTabItem, UiTabs } from '../ui/tabs';
import { UiDataTable, UiTableColumn, UiTableRowAction } from '../ui/data-table';
import { ProjectContext } from '../project-context';
import { UiToastService } from '../ui/toast';

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
  imports: [FormsModule, UiPage, UiTabs, UiDataTable],
  template: `
    <ui-page data-testid="settings" [title]="i18n.instant('settings.title')">

      <ui-tabs [items]="scopeTabs" [active]="scope()" [ariaLabel]="i18n.instant('settings.scope')" (tabChange)="setScope($event)" />

      @if (scope() === 'project' && ctx.selected(); as p) {
        <p class="ui-page-sub">{{ p.key }} · {{ p.name }}</p>
      }

      <ui-data-table
        testid="settings-table"
        emptyTestid="settings-empty"
        [columns]="columns"
        [rows]="rows()"
        [trackKey]="keyOf"
        [loading]="loading()"
        [emptyMessage]="i18n.instant('common.empty')"
        [pageSize]="25"
        [rowTestid]="rowTestid"
        [actions]="rowActions"
        [editValue]="editValue"
        [editChange]="editChange"
      />
    </ui-page>
  `,
})
export class SettingsPage implements OnInit {
  private readonly toast = inject(UiToastService);
  private readonly api = inject(ApiClient);
  readonly i18n = inject(I18n);
  readonly ctx = inject(ProjectContext);

  readonly scope = signal<'system' | 'project'>('system');
  readonly busy = signal(false);

  get scopeTabs(): UiTabItem[] {
    const tabs: UiTabItem[] = [{ id: 'system', label: this.i18n.instant('settings.scope_system'), testid: 'scope-system' }];
    // Project overrides only make sense once a project is selected.
    if (this.ctx.hasProject()) tabs.push({ id: 'project', label: this.i18n.instant('settings.scope_project'), testid: 'scope-project' });
    return tabs;
  }

  readonly rows = signal<Row[]>([]);
  readonly loading = signal(true);
  private defs: DefDto[] = [];

  readonly keyOf = (r: Row): string => r.key;
  readonly rowTestid = (): string => 'setting-row';
  readonly editValue = (r: Row, _key: string): string => r.input;
  readonly editChange = (r: Row, _key: string, value: string): void => this.setInput(r.key, value);

  get columns(): UiTableColumn<Row>[] {
    return [
      { key: 'key', label: this.i18n.instant('common.key'), sortable: true },
      { key: 'source', label: this.i18n.instant('settings.source'), sortable: true, testid: 'setting-source' },
      { key: 'input', label: this.i18n.instant('settings.value'), editable: true, editTestid: 'setting-input' },
    ];
  }

  get rowActions(): UiTableRowAction<Row>[] {
    return [
      {
        label: this.i18n.instant('settings.override'),
        testid: 'setting-override',
        run: (r) => void this.override(r),
      },
      {
        label: this.i18n.instant('settings.inherit'),
        testid: 'setting-inherit',
        when: (r) => r.source === this.scope(),
        run: (r) => void this.inherit(r.key),
      },
    ];
  }

  async ngOnInit(): Promise<void> {
    try {
      await this.ctx.ensureLoaded();
      this.defs = (await this.api.get<{ settings: DefDto[] }>('/api/v1/settings/registry')).settings;
      await this.refresh();
    } catch (err) {
      this.toast.error((err as Error).message);
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
    this.loading.set(true);
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
      this.toast.error((err as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  async override(row: Row): Promise<void> {
    this.busy.set(true);
    try {
      await this.api.put(`/api/v1/settings/${this.scope()}/${this.scopeId()}/${row.key}`, { value: parse(row.input) });
      await this.refresh();
    } catch (err) {
      this.toast.error((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  async inherit(key: string): Promise<void> {
    this.busy.set(true);
    try {
      await this.api.send('DELETE', `/api/v1/settings/${this.scope()}/${this.scopeId()}/${key}`);
      await this.refresh();
    } catch (err) {
      this.toast.error((err as Error).message);
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
