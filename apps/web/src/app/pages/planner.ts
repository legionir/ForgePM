import { ChangeDetectionStrategy, Component, OnInit, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { JsonPipe } from '@angular/common';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { UiButton } from '../ui/button';
import { UiPage } from '../ui/page';
import { UiIcon } from '../ui/icon';
import { UiBadge } from '../ui/badge';
import { UiControl, UiField } from '../ui/field';
import { computed } from '@angular/core';
import { ProjectContext } from '../project-context';

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
  imports: [FormsModule, JsonPipe, UiButton, UiPage, UiIcon, UiBadge, UiControl, UiField],
  template: `
    <ui-page data-testid="planner" [title]="i18n.instant('planner.title')">
      <ol class="ui-stepper" [attr.aria-label]="i18n.instant('planner.steps')" data-testid="plan-steps">
        @for (s of stepKeys; track s; let i = $index) {
          <li [class.done]="i < stepIndex()" [class.current]="i === stepIndex()" [attr.aria-current]="i === stepIndex() ? 'step' : null">
            <span class="ui-stepper-dot">
              @if (i < stepIndex()) {
                <ui-icon name="check" [size]="12" [inline]="false" />
              } @else {
                {{ i + 1 }}
              }
            </span>
            <span class="ui-stepper-label">{{ stepLabel(s) }}</span>
          </li>
        }
      </ol>

      @if (!plan()) {
        <section class="ui-card">
          <header class="ui-card-head"><h2>{{ i18n.instant('planner.step.goal') }}</h2></header>
          <form class="ui-stack" (ngSubmit)="create()" data-testid="plan-new">
            <ui-field [label]="i18n.instant('planner.goal')" required [hint]="i18n.instant('planner.goal_hint')">
              <input uiControl name="goal" [(ngModel)]="goal" required data-testid="plan-goal" />
            </ui-field>
            <ui-field [label]="i18n.instant('planner.constraints')">
              <input uiControl name="cons" [(ngModel)]="constraints" />
            </ui-field>
            <div>
              <button type="submit" ui-button variant="primary" data-testid="plan-create">
                <ui-icon name="compass" [size]="14" /> {{ i18n.instant('planner.create') }}
              </button>
            </div>
          </form>
        </section>
      }
      @if (error()) {
        <p class="ui-error" role="alert" data-testid="plan-error">{{ error() }}</p>
      }

      @if (plan(); as p) {
        <section class="ui-card" data-testid="plan-view">
          <header class="ui-card-head">
            <h2>{{ p.goal }}</h2>
            <span>
              {{ i18n.instant('planner.status') }}:
              <ui-badge [variant]="statusVariant(p.status)"><span data-testid="plan-status">{{ p.status }}</span></ui-badge>
            </span>
          </header>
          <p class="ui-card-sub">{{ hint(p.status) }}</p>
          <div class="ui-row-actions">
            @if (p.status === 'generating' || p.status === 'generation_failed') {
              <button type="button" ui-button variant="primary" (click)="generate()" [loading]="busy()" data-testid="plan-generate">
                {{ i18n.instant('planner.generate') }}
              </button>
            }
            @if (p.status === 'ready') {
              <button type="button" ui-button variant="primary" (click)="approve()" [loading]="busy()" data-testid="plan-approve">{{ i18n.instant('planner.approve') }}</button>
            }
            @if (p.status === 'approved') {
              <button type="button" ui-button variant="primary" (click)="apply()" [loading]="busy()" data-testid="plan-apply">{{ i18n.instant('planner.apply') }}</button>
            }
            <button type="button" ui-button variant="ghost" (click)="reset()">{{ i18n.instant('planner.new_plan') }}</button>
          </div>
          @if (report()) {
            <pre class="ui-report" data-testid="plan-report">{{ report() | json }}</pre>
          }
        </section>
      }
    </ui-page>
  `,
})
export class PlannerPage implements OnInit {
  private readonly api = inject(ApiClient);
  readonly i18n = inject(I18n);
  readonly ctx = inject(ProjectContext);

  readonly plan = signal<PlanDto | null>(null);
  readonly report = signal<ApplyReport | null>(null);
  readonly error = signal('');
  readonly busy = signal(false);
  goal = '';
  constraints = '';

  readonly stepKeys = ['goal', 'generate', 'approve', 'apply'] as const;
  /** Position in goal → generate → approve → apply (done when past the end). */
  readonly stepIndex = computed(() => {
    const st = this.plan()?.status;
    if (!st) return 0;
    if (st === 'generating' || st === 'generation_failed') return 1;
    if (st === 'ready') return 2;
    if (st === 'approved') return 3;
    return 4;
  });

  statusVariant(status: string): 'default' | 'success' | 'warning' | 'error' | 'info' {
    if (status === 'applied') return 'success';
    if (status === 'generation_failed') return 'error';
    if (status === 'ready' || status === 'approved') return 'info';
    return 'default';
  }

  /** i18n hint bucket for the current status. */
  hintKey(status: string): string {
    return ['generating', 'generation_failed', 'ready', 'approved'].includes(status) ? status : 'applied';
  }

  stepLabel(step: string): string {
    return this.i18n.instant(`planner.step.${step}`);
  }

  hint(status: string): string {
    return this.i18n.instant(`planner.hint.${this.hintKey(status)}`);
  }

  reset(): void {
    this.plan.set(null);
    this.report.set(null);
    this.error.set('');
  }

  constructor() {
    effect(() => {
      if (this.ctx.selectedId()) this.plan.set(null);
    });
  }

  async ngOnInit(): Promise<void> {
    await this.ctx.ensureLoaded();
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
    this.error.set('');
    this.busy.set(true);
    try {
      const res = await this.api.post<{ status: string }>(`/api/v1/plans/${p.id}/generate`);
      this.plan.set({ ...p, status: res.status });
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  async approve(): Promise<void> {
    const p = this.plan();
    if (!p) return;
    this.error.set('');
    this.busy.set(true);
    try {
      await this.api.post(`/api/v1/plans/${p.id}/approve`);
      this.plan.set({ ...p, status: 'approved' });
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  async apply(): Promise<void> {
    const p = this.plan();
    if (!p) return;
    this.error.set('');
    this.busy.set(true);
    try {
      const rep = await this.api.post<ApplyReport>(`/api/v1/plans/${p.id}/apply`, {
        idempotency_key: `panel-${Date.now()}`,
      });
      this.report.set(rep);
      this.plan.set({ ...p, status: (rep as { status?: string }).status ?? 'applied' });
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
