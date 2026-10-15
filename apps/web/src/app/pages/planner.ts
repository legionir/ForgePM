import { ChangeDetectionStrategy, Component, OnInit, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { JsonPipe } from '@angular/common';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { ProjectContext } from '../project-context';
import { ProjectPickerCmp } from '../ui/project-picker';

interface PlanDto {
  id: string;
  goal: string;
  status: string;
  current_revision_id: string | null;
}
interface ApplyReport {
  milestones?: number;
  features?: number;
  work_items?: number;
  relations?: number;
  status?: string;
  skipped?: { item: string; reason: string }[];
}

/**
 * Planner page (plan §7 panel, §11): create from goal, run generation against
 * the configured provider (fake in E2E), approve, apply (separate human
 * actions with separate idempotency keys), read the apply report.
 */
@Component({
  selector: 'page-planner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, JsonPipe, ProjectPickerCmp],
  template: `
    <section data-testid="planner">
      <h1>{{ i18n.instant('planner.title') }}</h1>
      <ui-project-picker />

      <form (ngSubmit)="create()" data-testid="plan-new">
        <label>{{ i18n.instant('planner.goal') }}
          <input name="goal" [(ngModel)]="goal" required data-testid="plan-goal" />
        </label>
        <label>{{ i18n.instant('planner.constraints') }}
          <input name="cons" [(ngModel)]="constraints" />
        </label>
        <button type="submit" data-testid="plan-create">{{ i18n.instant('planner.create') }}</button>
      </form>
      @if (error()) {
        <p class="ui-error" data-testid="plan-error">{{ error() }}</p>
      }

      @if (plan(); as p) {
        <div data-testid="plan-view">
          <h2>{{ p.goal }}</h2>
          <p>
            {{ i18n.instant('planner.status') }}:
            <strong data-testid="plan-status">{{ p.status }}</strong>
          </p>
          @if (p.status === 'generating' || p.status === 'generation_failed') {
            <button type="button" (click)="generate()" data-testid="plan-generate">
              {{ i18n.instant('planner.generate') }}
            </button>
          }
          @if (p.status === 'ready') {
            <button type="button" (click)="approve()" data-testid="plan-approve">{{ i18n.instant('planner.approve') }}</button>
          }
          @if (p.status === 'approved') {
            <button type="button" (click)="apply()" data-testid="plan-apply">{{ i18n.instant('planner.apply') }}</button>
          }
          @if (report()) {
            <pre class="ui-report" data-testid="plan-report">{{ report() | json }}</pre>
          }
        </div>
      }
    </section>
  `,
})
export class PlannerPage implements OnInit {
  private readonly api = inject(ApiClient);
  readonly i18n = inject(I18n);
  readonly ctx = inject(ProjectContext);

  readonly plan = signal<PlanDto | null>(null);
  readonly report = signal<ApplyReport | null>(null);
  readonly error = signal('');
  goal = 'Ship the login flow';
  constraints = '';

  constructor() {
    effect(() => {
      if (this.ctx.selectedId()) this.plan.set(null);
    });
  }

  async ngOnInit(): Promise<void> {
    await this.ctx.load();
  }

  async create(): Promise<void> {
    this.error.set('');
    try {
      this.plan.set(
        await this.api.post<PlanDto>(`/api/v1/projects/${this.ctx.selectedId()}/plans`, {
          goal: this.goal,
          ...(this.constraints ? { constraints: this.constraints } : {}),
        }),
      );
    } catch (err) {
      this.error.set((err as Error).message);
    }
  }

  async generate(): Promise<void> {
    const p = this.plan();
    if (!p) return;
    const res = await this.api.post<{ status: string }>(`/api/v1/plans/${p.id}/generate`);
    this.plan.set({ ...p, status: res.status });
  }

  async approve(): Promise<void> {
    const p = this.plan();
    if (!p) return;
    await this.api.post(`/api/v1/plans/${p.id}/approve`);
    this.plan.set({ ...p, status: 'approved' });
  }

  async apply(): Promise<void> {
    const p = this.plan();
    if (!p) return;
    const rep = await this.api.post<ApplyReport>(`/api/v1/plans/${p.id}/apply`, {
      idempotency_key: `panel-${Date.now()}`,
    });
    this.report.set(rep);
    this.plan.set({ ...p, status: (rep as { status?: string }).status ?? 'applied' });
  }
}
