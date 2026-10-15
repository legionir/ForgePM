import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { ProjectContext } from '../project-context';
import { ProjectPickerCmp } from '../ui/project-picker';

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
  imports: [FormsModule, ProjectPickerCmp],
  template: `
    <section data-testid="features">
      <h1>{{ i18n.instant('features.title') }}</h1>
      <ui-project-picker />
      @if (error()) {
        <p class="ui-error" data-testid="feature-error">{{ error() }}</p>
      }
      <ul class="ui-list" data-testid="feature-list">
        @for (f of features(); track f.id) {
          <li data-testid="feature-row">
            {{ f.key }} · {{ f.title }} — {{ f.lifecycle_status }}
            <span data-testid="feature-progress">{{ i18n.instant('features.work_progress') }}: {{ f.work_progress }}%</span>
            <span data-testid="feature-readiness">{{ i18n.instant('features.release_readiness') }}: {{ f.release_readiness }}%</span>
          </li>
        } @empty {
          <li data-testid="feature-empty">{{ i18n.instant('common.empty') }}</li>
        }
      </ul>
      <form (ngSubmit)="createFeature()" data-testid="feature-new">
        <label>{{ i18n.instant('common.key') }}<input name="fkey" [(ngModel)]="fkey" required data-testid="feature-key" /></label>
        <label>{{ i18n.instant('common.title') }}<input name="ftitle" [(ngModel)]="ftitle" required data-testid="feature-title" /></label>
        <label>
          {{ i18n.instant('features.ac') }}
          <input name="fac" [(ngModel)]="facText" data-testid="feature-ac" />
        </label>
        <button type="submit">{{ i18n.instant('features.new') }}</button>
      </form>

      <h1>{{ i18n.instant('milestones.title') }}</h1>
      <ul class="ui-list" data-testid="milestone-list">
        @for (m of milestones(); track m.id) {
          <li data-testid="milestone-row">{{ m.name }} — {{ m.status }} ({{ m.progress }}%)</li>
        } @empty {
          <li data-testid="milestone-empty">{{ i18n.instant('common.empty') }}</li>
        }
      </ul>
      <form (ngSubmit)="createMilestone()" data-testid="milestone-new">
        <label>{{ i18n.instant('common.name') }}<input name="mname" [(ngModel)]="mname" required data-testid="milestone-name" /></label>
        <button type="submit">{{ i18n.instant('milestones.new') }}</button>
      </form>
    </section>
  `,
})
export class FeaturesPage implements OnInit {
  private readonly api = inject(ApiClient);
  readonly i18n = inject(I18n);
  readonly ctx = inject(ProjectContext);

  readonly features = signal<FeatureDto[]>([]);
  readonly milestones = signal<MilestoneDto[]>([]);
  readonly error = signal('');
  fkey = 'FEAT';
  ftitle = 'First feature';
  facText = 'it works';
  mname = 'v1';

  async ngOnInit(): Promise<void> {
    await this.ctx.load();
    await this.load();
  }

  async load(): Promise<void> {
    const pid = this.ctx.selectedId();
    if (!pid) return;
    this.features.set((await this.api.get<{ items: FeatureDto[] }>(`/api/v1/projects/${pid}/features`)).items);
    this.milestones.set((await this.api.get<{ items: MilestoneDto[] }>(`/api/v1/projects/${pid}/milestones`)).items);
  }

  async createFeature(): Promise<void> {
    this.error.set('');
    try {
      await this.api.post(`/api/v1/projects/${this.ctx.selectedId()}/features`, {
        key: this.fkey,
        title: this.ftitle,
        acceptance_criteria: [{ text: this.facText, done: false }],
      });
      await this.load();
    } catch (err) {
      this.error.set((err as Error).message);
    }
  }

  async createMilestone(): Promise<void> {
    await this.api.post(`/api/v1/projects/${this.ctx.selectedId()}/milestones`, { name: this.mname });
    await this.load();
  }
}
