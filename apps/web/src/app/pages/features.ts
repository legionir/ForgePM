import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { UiButton } from '../ui/button';
import { UiPage } from '../ui/page';
import { UiIcon } from '../ui/icon';
import { UiBadge } from '../ui/badge';
import { UiModal } from '../ui/modal';
import { UiProgress } from '../ui/charts';
import { UiControl, UiField } from '../ui/field';
import { CamelPipe } from '../ui/camel';
import { ProjectContext } from '../project-context';
import { UiToastService } from '../ui/toast';

interface FeatureDto {
  id: string;
  key: string;
  title: string;
  lifecycle_status: string;
  milestone_id: string | null;
  work_progress: number;
  release_readiness: number;
  acceptance_criteria: { text: string; done: boolean }[];
}
interface MilestoneDto {
  id: string;
  name: string;
  target_date: string | null;
  status: string;
  progress: number;
}

const LIFECYCLE = ['proposed', 'planned', 'in_progress', 'in_validation', 'released', 'deprecated'] as const;
const MILESTONE_STATUS = ['open', 'closed'] as const;

/**
 * Features + Milestones for the selected project (§6 panel, both metrics).
 * Create forms are modals opened from the card headers; lifecycle, milestone
 * and milestone status are changed in place; milestones group features.
 */
@Component({
  selector: 'page-features',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, UiButton, UiPage, UiIcon, UiBadge, UiModal, UiProgress, UiControl, UiField, CamelPipe],
  template: `
    <ui-page data-testid="features" [title]="i18n.instant('features.title')">
      <section class="ui-card">
        <header class="ui-card-head">
          <div class="ui-card-title">
            <h2><ui-icon name="layers" [size]="18" [inline]="false" /> {{ i18n.instant('features.title') }}</h2>
            <ui-badge size="sm" data-testid="feature-count">{{ features().length }}</ui-badge>
          </div>
          <button type="button" ui-button variant="primary" size="sm" (click)="openFeature()" data-testid="feature-new-open">
            <ui-icon name="plus" [size]="14" /> {{ i18n.instant('features.new') }}
          </button>
        </header>
        <ul class="ui-rows" data-testid="feature-list">
          @for (f of features(); track f.id) {
            <li class="ui-row-progress ui-row-progress--lg" data-testid="feature-row">
              <div class="ui-row-main">
                <span class="ui-row-key">{{ f.key }}</span>
                <span class="ui-row-title">{{ f.title }}</span>
                <ui-badge size="sm" [status]="f.lifecycle_status" data-testid="feature-status" />
                @if (milestoneName(f.milestone_id); as mn) {
                  <ui-badge size="sm" icon="flag">{{ mn }}</ui-badge>
                }
              </div>
              <div class="ui-row-controls">
                <select
                  class="ui-select-sm"
                  [ngModel]="f.lifecycle_status"
                  (ngModelChange)="setLifecycle(f, $event)"
                  [attr.aria-label]="i18n.instant('features.status')"
                  data-testid="feature-status-select"
                >
                  @for (s of lifecycle; track s) {
                    <option [value]="s">{{ s | camel }}</option>
                  }
                </select>
                <select
                  class="ui-select-sm"
                  [ngModel]="f.milestone_id ?? ''"
                  (ngModelChange)="setMilestone(f, $event)"
                  [attr.aria-label]="i18n.instant('milestones.title')"
                  data-testid="feature-milestone-select"
                >
                  <option value="">{{ i18n.instant('features.no_milestone') | camel }}</option>
                  @for (m of milestones(); track m.id) {
                    <option [value]="m.id">{{ m.name | camel }}</option>
                  }
                </select>
              </div>
              <div class="ui-row-meter">
                <span class="ui-row-meter-label">{{ i18n.instant('features.work_progress') }}</span>
                <ui-progress [value]="f.work_progress" [label]="i18n.instant('features.work_progress')" />
                <span class="ui-row-pct" data-testid="feature-progress">{{ f.work_progress }}%</span>
              </div>
              <div class="ui-row-meter">
                <span class="ui-row-meter-label">{{ i18n.instant('features.release_readiness') }}</span>
                <ui-progress [value]="f.release_readiness" [label]="i18n.instant('features.release_readiness')" />
                <span class="ui-row-pct" data-testid="feature-readiness">{{ f.release_readiness }}%</span>
              </div>
            </li>
          } @empty {
            <li class="ui-card-empty" data-testid="feature-empty">
              <ui-icon name="layers" [size]="20" /> {{ i18n.instant('features.empty') }}
            </li>
          }
        </ul>
      </section>

      <section class="ui-card">
        <header class="ui-card-head">
          <div class="ui-card-title">
            <h2><ui-icon name="flag" [size]="18" [inline]="false" /> {{ i18n.instant('milestones.title') }}</h2>
            <ui-badge size="sm" data-testid="milestone-count">{{ milestones().length }}</ui-badge>
          </div>
          <button type="button" ui-button variant="primary" size="sm" (click)="openMilestone()" data-testid="milestone-new-open">
            <ui-icon name="plus" [size]="14" /> {{ i18n.instant('milestones.new') }}
          </button>
        </header>
        <ul class="ui-rows" data-testid="milestone-list">
          @for (m of milestones(); track m.id) {
            <li class="ui-row-progress" data-testid="milestone-row">
              <div class="ui-row-main">
                <ui-icon name="flag" [size]="14" />
                <span class="ui-row-title">{{ m.name }}</span>
                @if (m.target_date) {
                  <span class="ui-row-date">{{ m.target_date.slice(0, 10) }}</span>
                }
                <ui-badge size="sm" [status]="m.status" data-testid="milestone-status" />
                <ui-badge size="sm" icon="layers" data-testid="milestone-features">{{ featureCount(m.id) }}</ui-badge>
              </div>
              <div class="ui-row-controls">
                <select
                  class="ui-select-sm"
                  [ngModel]="m.status"
                  (ngModelChange)="setMilestoneStatus(m, $event)"
                  [attr.aria-label]="i18n.instant('features.status')"
                  data-testid="milestone-status-select"
                >
                  @for (s of milestoneStatus; track s) {
                    <option [value]="s">{{ s | camel }}</option>
                  }
                </select>
              </div>
              <div class="ui-row-meter">
                <ui-progress [value]="m.progress" [label]="m.name" />
                <span class="ui-row-pct">{{ m.progress }}%</span>
              </div>
            </li>
          } @empty {
            <li class="ui-card-empty" data-testid="milestone-empty">
              <ui-icon name="flag" [size]="20" /> {{ i18n.instant('milestones.empty') }}
            </li>
          }
        </ul>
      </section>

      <ui-modal [(open)]="featureOpen" [title]="i18n.instant('features.new')" icon="layers">
        <form class="ui-stack" (ngSubmit)="createFeature()" id="feature-form" data-testid="feature-new">
          <ui-field [label]="i18n.instant('common.key')" required>
            <input uiControl name="fkey" [(ngModel)]="fkey" required maxlength="12" placeholder="AUTH" data-testid="feature-key" />
          </ui-field>
          <ui-field [label]="i18n.instant('common.title')" required>
            <input uiControl name="ftitle" [(ngModel)]="ftitle" required data-testid="feature-title" />
          </ui-field>
          <ui-field [label]="i18n.instant('projects.description')">
            <textarea uiControl name="fdesc" [(ngModel)]="fdesc" rows="3" data-testid="feature-description"></textarea>
          </ui-field>
          <ui-field [label]="i18n.instant('milestones.title')">
            <select uiControl name="fmilestone" [(ngModel)]="fmilestone" data-testid="feature-milestone">
              <option value="">{{ i18n.instant('features.no_milestone') | camel }}</option>
              @for (m of milestones(); track m.id) {
                <option [value]="m.id">{{ m.name | camel }}</option>
              }
            </select>
          </ui-field>
          <div class="ui-criteria" data-testid="feature-criteria">
            <div class="ui-criteria-head">
              <ui-icon name="check-square" [size]="16" [inline]="false" />
              <ui-badge size="sm" data-testid="criteria-count">{{ nonEmptyCriteria().length }}</ui-badge>
              <button type="button" class="ui-icon-btn" (click)="addCriterion()" [attr.aria-label]="i18n.instant('features.ac_add')" data-testid="criterion-add">
                <ui-icon name="plus" [size]="14" [inline]="false" />
              </button>
            </div>
            @for (c of criteria(); track $index) {
              <div class="ui-criteria-row">
                <input
                  [value]="c"
                  (input)="setCriterion($index, $any($event.target).value)"
                  [attr.aria-label]="i18n.instant('features.ac')"
                  data-testid="feature-ac"
                />
                <button type="button" class="ui-icon-btn" (click)="removeCriterion($index)" [attr.aria-label]="i18n.instant('common.cancel')">
                  <ui-icon name="x" [size]="14" [inline]="false" />
                </button>
              </div>
            }
          </div>
        </form>
        <div uiModalFooter>
          <button type="button" ui-button variant="ghost" (click)="featureOpen.set(false)">{{ i18n.instant('common.cancel') }}</button>
          <button type="submit" form="feature-form" ui-button variant="primary" [loading]="busy()" data-testid="feature-create">
            <ui-icon name="plus" [size]="14" /> {{ i18n.instant('common.create') }}
          </button>
        </div>
      </ui-modal>

      <ui-modal [(open)]="milestoneOpen" [title]="i18n.instant('milestones.new')" icon="flag">
        <form class="ui-stack" (ngSubmit)="createMilestone()" id="milestone-form" data-testid="milestone-new">
          <ui-field [label]="i18n.instant('common.name')" required>
            <input uiControl name="mname" [(ngModel)]="mname" required data-testid="milestone-name" />
          </ui-field>
          <ui-field [label]="i18n.instant('projects.target_date')">
            <input uiControl type="date" name="mdate" [(ngModel)]="mdate" data-testid="milestone-date" />
          </ui-field>
        </form>
        <div uiModalFooter>
          <button type="button" ui-button variant="ghost" (click)="milestoneOpen.set(false)">{{ i18n.instant('common.cancel') }}</button>
          <button type="submit" form="milestone-form" ui-button variant="primary" [loading]="busy()" data-testid="milestone-create">
            <ui-icon name="plus" [size]="14" /> {{ i18n.instant('common.create') }}
          </button>
        </div>
      </ui-modal>
    </ui-page>
  `,
})
export class FeaturesPage {
  private readonly toast = inject(UiToastService);
  private readonly api = inject(ApiClient);
  readonly i18n = inject(I18n);
  readonly ctx = inject(ProjectContext);

  readonly lifecycle = LIFECYCLE;
  readonly milestoneStatus = MILESTONE_STATUS;

  readonly features = signal<FeatureDto[]>([]);
  readonly milestones = signal<MilestoneDto[]>([]);
  readonly busy = signal(false);
  readonly featureOpen = signal(false);
  readonly milestoneOpen = signal(false);
  readonly criteria = signal<string[]>(['']);
  readonly nonEmptyCriteria = computed(() => this.criteria().filter((c) => c.trim()));
  fkey = '';
  ftitle = '';
  fdesc = '';
  fmilestone = '';
  mname = '';
  mdate = '';

  constructor() {
    // Follow the sidebar project switcher.
    effect(() => {
      if (this.ctx.selectedId()) void this.load();
    });
  }

  milestoneName(id: string | null): string {
    return id ? (this.milestones().find((m) => m.id === id)?.name ?? '') : '';
  }

  featureCount(milestoneId: string): number {
    return this.features().filter((f) => f.milestone_id === milestoneId).length;
  }

  async load(): Promise<void> {
    const pid = this.ctx.selectedId();
    if (!pid) return;
    try {
      this.features.set((await this.api.get<{ items: FeatureDto[] }>(`/api/v1/projects/${pid}/features`)).items);
      this.milestones.set((await this.api.get<{ items: MilestoneDto[] }>(`/api/v1/projects/${pid}/milestones`)).items);
    } catch (err) {
      this.toast.error((err as Error).message);
    }
  }

  openFeature(): void {
    this.fkey = this.ftitle = this.fdesc = this.fmilestone = '';
    this.criteria.set(['']);
    this.featureOpen.set(true);
  }

  openMilestone(): void {
    this.mname = this.mdate = '';
    this.milestoneOpen.set(true);
  }

  addCriterion(): void {
    this.criteria.update((l) => [...l, '']);
  }

  setCriterion(i: number, value: string): void {
    this.criteria.update((l) => l.map((c, idx) => (idx === i ? value : c)));
  }

  removeCriterion(i: number): void {
    this.criteria.update((l) => (l.length > 1 ? l.filter((_, idx) => idx !== i) : ['']));
  }

  async createFeature(): Promise<void> {
    this.busy.set(true);
    try {
      await this.api.post(`/api/v1/projects/${this.ctx.selectedId()}/features`, {
        key: this.fkey,
        title: this.ftitle,
        ...(this.fdesc ? { description: this.fdesc } : {}),
        ...(this.fmilestone ? { milestone_id: this.fmilestone } : {}),
        acceptance_criteria: this.nonEmptyCriteria().map((text) => ({ text, done: false })),
      });
      this.featureOpen.set(false);
      await this.load();
    } catch (err) {
      this.toast.error((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  async createMilestone(): Promise<void> {
    this.busy.set(true);
    try {
      await this.api.post(`/api/v1/projects/${this.ctx.selectedId()}/milestones`, {
        name: this.mname,
        ...(this.mdate ? { target_date: this.mdate } : {}),
      });
      this.milestoneOpen.set(false);
      await this.load();
    } catch (err) {
      this.toast.error((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  async setLifecycle(f: FeatureDto, value: string): Promise<void> {
    if (value === f.lifecycle_status) return;
    await this.patch(`/api/v1/features/${f.id}`, { lifecycle_status: value });
  }

  async setMilestone(f: FeatureDto, value: string): Promise<void> {
    if (value === (f.milestone_id ?? '')) return;
    await this.patch(`/api/v1/features/${f.id}`, { milestone_id: value || null });
  }

  async setMilestoneStatus(m: MilestoneDto, value: string): Promise<void> {
    if (value === m.status) return;
    await this.patch(`/api/v1/milestones/${m.id}`, { status: value });
  }

  private async patch(url: string, body: Record<string, unknown>): Promise<void> {
    try {
      await this.api.patch(url, body);
      await this.load();
    } catch (err) {
      this.toast.error((err as Error).message);
      await this.load();
    }
  }
}
