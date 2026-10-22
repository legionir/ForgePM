import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { UiButton } from '../ui/button';
import { UiPage } from '../ui/page';
import { UiIcon } from '../ui/icon';
import { UiBadge } from '../ui/badge';
import { UiProgress } from '../ui/charts';
import { UiControl, UiField } from '../ui/field';
import { ProjectContext } from '../project-context';
import { UiToastService } from '../ui/toast';

interface FeatureDto {
  id: string;
  key: string;
  title: string;
  lifecycle_status: string;
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

/** Features + Milestones for the selected project (§6 panel, both metrics). */
@Component({
  selector: 'page-features',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, UiButton, UiPage, UiIcon, UiBadge, UiProgress, UiControl, UiField],
  template: `
    <ui-page data-testid="features" [title]="i18n.instant('features.title')">

      <div class="ui-grid ui-grid--split">
        <section class="ui-card">
          <header class="ui-card-head">
            <h2>{{ i18n.instant('features.title') }}</h2>
            <span class="ui-card-sub">{{ features().length }}</span>
          </header>
          <ul class="ui-rows" data-testid="feature-list">
            @for (f of features(); track f.id) {
              <li class="ui-row-progress ui-row-progress--lg" data-testid="feature-row">
                <div class="ui-row-main">
                  <span class="ui-row-key">{{ f.key }}</span>
                  <span class="ui-row-title">{{ f.title }}</span>
                  <ui-badge size="sm">{{ f.lifecycle_status.replace('_', ' ') }}</ui-badge>
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
          <header class="ui-card-head"><h2>{{ i18n.instant('features.new') }}</h2></header>
          <form class="ui-stack" (ngSubmit)="createFeature()" data-testid="feature-new">
            <ui-field [label]="i18n.instant('common.key')" required>
              <input uiControl name="fkey" [(ngModel)]="fkey" required maxlength="12" placeholder="AUTH" data-testid="feature-key" />
            </ui-field>
            <ui-field [label]="i18n.instant('common.title')" required>
              <input uiControl name="ftitle" [(ngModel)]="ftitle" required data-testid="feature-title" />
            </ui-field>
            <ui-field [label]="i18n.instant('features.ac')">
              <input uiControl name="fac" [(ngModel)]="facText" data-testid="feature-ac" />
            </ui-field>
            <button type="submit" ui-button variant="primary">
              <ui-icon name="plus" [size]="14" /> {{ i18n.instant('features.new') }}
            </button>
          </form>
        </section>
      </div>


      <div class="ui-grid ui-grid--split">
        <section class="ui-card">
          <header class="ui-card-head">
            <h2>{{ i18n.instant('milestones.title') }}</h2>
            <span class="ui-card-sub">{{ milestones().length }}</span>
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
                  <ui-badge size="sm">{{ m.status }}</ui-badge>
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

        <section class="ui-card">
          <header class="ui-card-head"><h2>{{ i18n.instant('milestones.new') }}</h2></header>
          <form class="ui-stack" (ngSubmit)="createMilestone()" data-testid="milestone-new">
            <ui-field [label]="i18n.instant('common.name')" required>
              <input uiControl name="mname" [(ngModel)]="mname" required data-testid="milestone-name" />
            </ui-field>
            <button type="submit" ui-button variant="primary" [loading]="busy()">
              <ui-icon name="plus" [size]="14" /> {{ i18n.instant('milestones.new') }}
            </button>
          </form>
        </section>
      </div>
    </ui-page>
  `,
})
export class FeaturesPage {
  private readonly toast = inject(UiToastService);
  private readonly api = inject(ApiClient);
  readonly i18n = inject(I18n);
  readonly ctx = inject(ProjectContext);

  readonly features = signal<FeatureDto[]>([]);
  readonly milestones = signal<MilestoneDto[]>([]);
  readonly busy = signal(false);
  fkey = '';
  ftitle = '';
  facText = '';
  mname = '';

  constructor() {
    // Follow the sidebar project switcher.
    effect(() => {
      if (this.ctx.selectedId()) void this.load();
    });
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

  async createFeature(): Promise<void> {
    try {
      await this.api.post(`/api/v1/projects/${this.ctx.selectedId()}/features`, {
        key: this.fkey,
        title: this.ftitle,
        acceptance_criteria: this.facText ? [{ text: this.facText, done: false }] : [],
      });
      this.fkey = this.ftitle = this.facText = '';
      await this.load();
    } catch (err) {
      this.toast.error((err as Error).message);
    }
  }

  async createMilestone(): Promise<void> {
    this.busy.set(true);
    try {
      await this.api.post(`/api/v1/projects/${this.ctx.selectedId()}/milestones`, { name: this.mname });
      this.mname = '';
      await this.load();
    } catch (err) {
      this.toast.error((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
