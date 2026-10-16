import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { UiPage } from '../ui/page';
import { UiDataTable, UiTableColumn } from '../ui/data-table';

interface CallDto {
  id: string;
  tool: string;
  outcome: string;
  error_code: string | null;
  duration_ms: number | null;
  created_at: string;
}

/**
 * MCP page (plan §8.11 panel): tool-call log with filters + the
 * mcp.rate_limit_per_minute setting surface (Settings holds the generic
 * editor; this page exposes the MCP-specific shortcut).
 */
@Component({
  selector: 'page-mcp',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, UiPage, UiDataTable],
  template: `
    <ui-page data-testid="mcp" [title]="i18n.instant('mcp.title')">
      <h2>{{ i18n.instant('mcp.calls') }}</h2>
      <label>
        {{ i18n.instant('mcp.outcome') }}
        <select name="oc" [(ngModel)]="outcome" (ngModelChange)="load()" data-testid="mcp-filter">
          <option value="">*</option>
          <option value="ok">ok</option>
          <option value="error">error</option>
          <option value="pending_approval">pending_approval</option>
        </select>
      </label>
      <ui-data-table
        testid="mcp-calls"
        emptyTestid="mcp-empty"
        [columns]="callColumns"
        [rows]="calls()"
        [trackKey]="keyOf"
        [loading]="loading()"
        [error]="error()"
        [emptyMessage]="i18n.instant('common.empty')"
        [rowTestid]="mcpRowTestid"
        [pageSize]="25"
      />
    </ui-page>
  `,
})
export class McpPage implements OnInit {
  private readonly api = inject(ApiClient);
  readonly i18n = inject(I18n);

  readonly calls = signal<CallDto[]>([]);
  readonly error = signal('');
  readonly loading = signal(true);
  outcome = '';

  readonly keyOf = (c: CallDto): string => c.id;
  readonly mcpRowTestid = (): string => 'mcp-call-row';

  get callColumns(): UiTableColumn<CallDto>[] {
    return [
      { key: 'tool', label: this.i18n.instant('mcp.tool'), sortable: true },
      { key: 'outcome', label: this.i18n.instant('mcp.outcome'), sortable: true, value: (c) => (c.error_code ? c.outcome + ' · ' + c.error_code : c.outcome) },
      { key: 'duration_ms', label: this.i18n.instant('mcp.duration'), sortable: true, value: (c) => c.duration_ms ?? '—', align: 'end' },
    ];
  }

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    this.error.set('');
    this.loading.set(true);
    try {
      await this.loadInner();
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  private async loadInner(): Promise<void> {
    const q = this.outcome ? `?outcome=${this.outcome}` : '';
    const res = await this.api.get<{ items: CallDto[] }>(`/api/v1/mcp/calls${q}`);
    this.calls.set(res.items);
  }
}
