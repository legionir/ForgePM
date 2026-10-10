import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiClient } from '../api';
import { I18n } from '../i18n';

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
  imports: [FormsModule],
  template: `
    <section data-testid="mcp">
      <h1>{{ i18n.instant('mcp.title') }}</h1>
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
      <table class="grid" data-testid="mcp-calls">
        <thead>
          <tr>
            <th>{{ i18n.instant('mcp.tool') }}</th>
            <th>{{ i18n.instant('mcp.outcome') }}</th>
            <th>{{ i18n.instant('mcp.duration') }}</th>
          </tr>
        </thead>
        <tbody>
          @for (c of calls(); track c.id) {
            <tr data-testid="mcp-call-row">
              <td>{{ c.tool }}</td>
              <td>{{ c.outcome }}{{ c.error_code ? ' · ' + c.error_code : '' }}</td>
              <td>{{ c.duration_ms ?? '—' }}</td>
            </tr>
          } @empty {
            <tr>
              <td colspan="3" data-testid="mcp-empty">{{ i18n.instant('common.empty') }}</td>
            </tr>
          }
        </tbody>
      </table>
    </section>
  `,
})
export class McpPage implements OnInit {
  private readonly api = inject(ApiClient);
  readonly i18n = inject(I18n);

  readonly calls = signal<CallDto[]>([]);
  outcome = '';

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    const q = this.outcome ? `?outcome=${this.outcome}` : '';
    const res = await this.api.get<{ items: CallDto[] }>(`/api/v1/mcp/calls${q}`);
    this.calls.set(res.items);
  }
}
