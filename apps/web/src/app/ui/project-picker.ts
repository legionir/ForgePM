import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { I18n } from '../i18n';
import { ProjectContext } from '../project-context';
import { UiLoading } from './loading';
import { UiEmptyState } from './empty-state';

/**
 * Standard project switcher for domain pages (plan §5.11 quick switcher).
 * Full state coverage (CMP-006, STT-003): skeleton while the project list
 * loads, error line with retry, empty state when no project exists.
 */
@Component({
  selector: 'ui-project-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiLoading, UiEmptyState],
  template: `
    <div class="ui-picker" data-testid="project-picker">
      @if (ctx.loading()) {
        <ui-loading kind="lines" [label]="i18n.instant('common.loading')" />
      } @else if (ctx.error()) {
        <button data-testid="project-picker-error" type="button" class="ui-btn ui-btn--secondary ui-btn--sm" (click)="ctx.load()">
          {{ i18n.instant('common.retry') }}
        </button>
      } @else if (ctx.projects().length === 0) {
        <ui-empty-state [message]="i18n.instant('projects.empty')" />
      } @else {
        <label class="ui-picker-label">
          <span>{{ i18n.instant('nav.projects') }}</span>
          <select
            [value]="ctx.selectedId() ?? ''"
            (change)="pick($event)"
            [attr.aria-label]="i18n.instant('nav.projects')"
            data-testid="project-select"
          >
            @for (p of ctx.projects(); track p.id) {
              <option [value]="p.id">{{ p.key }} · {{ p.name }}</option>
            }
          </select>
        </label>
      }
    </div>
  `,
})
export class ProjectPickerCmp {
  readonly i18n = inject(I18n);
  readonly ctx = inject(ProjectContext);
  readonly ready = computed(() => this.ctx.projects().length > 0);

  pick(ev: Event): void {
    const id = (ev.target as HTMLSelectElement).value;
    if (id) this.ctx.select(id);
  }
}
