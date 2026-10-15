import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { UiButton } from '../ui/button';
import { ProjectContext } from '../project-context';
import { ProjectPickerCmp } from '../ui/project-picker';

interface RunDto {
  id: string;
  kind: string;
  target: string;
  status: string;
}
interface FindingDto {
  id: string;
  title: string;
  severity: string;
  confidence: number;
  status: string;
  file: string | null;
}
interface RepoDto {
  id: string;
  full_name: string;
}

/**
 * Reviews page (plan §10 panel, B-007). With both review modules off the API
 * answers 503 MODULE_DISABLED; per §11 the page then shows only activation
 * guidance, never an error wall. Enabling happens from Settings → Modules at
 * runtime, so revisiting this page (no hard reload) renders runs+findings.
 */
@Component({
  selector: 'page-reviews',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ProjectPickerCmp, UiButton],
  template: `
    <section data-testid="reviews">
      <h1>{{ i18n.instant('reviews.title') }}</h1>
      <ui-project-picker />

      @if (disabled()) {
        <p class="ui-hint" data-testid="reviews-hint">{{ i18n.instant('common.disabled_hint') }}</p>
      } @else {
        <form (ngSubmit)="runCode()" data-testid="review-run-form">
          <label>Repo
            <select name="repo" [(ngModel)]="repoId" data-testid="review-repo">
              @for (r of repos(); track r.id) {
                <option [value]="r.id">{{ r.full_name }}</option>
              }
            </select>
          </label>
          <label>{{ i18n.instant('reviews.pr') }}<input name="pr" type="number" [(ngModel)]="prNumber" required data-testid="review-pr" /></label>
          <button type="submit" ui-button variant="primary" data-testid="review-run">{{ i18n.instant('reviews.run') }}</button>
        </form>

        <h2>{{ i18n.instant('reviews.runs') }}</h2>
        <ul class="ui-list" data-testid="run-list">
          @for (r of runs(); track r.id) {
            <li data-testid="run-row">{{ r.kind }} · {{ r.target }} · {{ r.status }}</li>
          } @empty {
            <li data-testid="run-empty">{{ i18n.instant('common.empty') }}</li>
          }
        </ul>

        <h2>{{ i18n.instant('reviews.findings') }}</h2>
        <ul class="ui-list" data-testid="finding-list">
          @for (f of findings(); track f.id) {
            <li data-testid="finding-row">
              {{ f.title }} ({{ f.severity }} · {{ f.confidence }}) — {{ f.status }}
              <button type="button" ui-button (click)="decide(f.id, 'dismissed')" data-testid="finding-dismiss">
                {{ i18n.instant('reviews.dismiss') }}
              </button>
              <button type="button" ui-button (click)="decide(f.id, 'accepted')" data-testid="finding-accept">
                {{ i18n.instant('reviews.accept') }}
              </button>
              <button type="button" ui-button (click)="createIssue(f.id)" data-testid="finding-issue">
                {{ i18n.instant('reviews.create_issue') }}
              </button>
            </li>
          } @empty {
            <li data-testid="finding-empty">{{ i18n.instant('common.empty') }}</li>
          }
        </ul>
      }
    </section>
  `,
})
export class ReviewsPage implements OnInit {
  private readonly api = inject(ApiClient);
  readonly i18n = inject(I18n);
  readonly ctx = inject(ProjectContext);

  readonly runs = signal<RunDto[]>([]);
  readonly findings = signal<FindingDto[]>([]);
  readonly repos = signal<RepoDto[]>([]);
  readonly disabled = signal(false);
  repoId = '';
  prNumber = 1;

  async ngOnInit(): Promise<void> {
    await this.ctx.load();
    await this.load();
  }

  async load(): Promise<void> {
    const pid = this.ctx.selectedId();
    if (!pid) return;
    try {
      const [runs, findings] = await Promise.all([
        this.api.get<{ items: RunDto[] }>(`/api/v1/review/runs?project_id=${pid}`),
        this.api.get<{ items: FindingDto[] }>(`/api/v1/review/findings?project_id=${pid}`),
      ]);
      this.runs.set(runs.items);
      this.findings.set(findings.items);
      this.repos.set((await this.api.get<{ items: RepoDto[] }>('/api/v1/repositories')).items);
      if (!this.repoId && this.repos()[0]) this.repoId = this.repos()[0].id;
      this.disabled.set(false);
    } catch {
      // 503 / MODULE_DISABLED => guidance mode (§11 "فقط راهنمای فعال‌سازی")
      this.disabled.set(true);
    }
  }

  /** Offline code review of PR #n: hunks arrive in the request (D-026). */
  async runCode(): Promise<void> {
    const pid = this.ctx.selectedId();
    if (!pid || !this.repoId) return;
    await this.api.post('/api/v1/review/code-runs', {
      project_id: pid,
      repository_id: this.repoId,
      pr_number: this.prNumber,
      commit_sha: `panel-e2e-${this.prNumber}`,
      hunks: [{ file: 'src/a.ts', start: 1, lines: ['export const x = 1;'] }],
      snapshot: [{ path: 'src/a.ts', lines: ['export const x = 1;'] }],
    });
    await this.load();
  }

  async decide(id: string, status: 'dismissed' | 'accepted'): Promise<void> {
    await this.api.post(`/api/v1/review/findings/${id}/decision`, { status });
    await this.load();
  }

  async createIssue(id: string): Promise<void> {
    await this.api.post(`/api/v1/review/findings/${id}/create-work-item`);
    await this.load();
  }
}
