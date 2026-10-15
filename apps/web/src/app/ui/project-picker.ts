import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { I18n } from '../i18n';
import { ProjectContext } from '../project-context';

/** Standard project switcher for domain pages (plan §5.11 quick switcher). */
@Component({
  selector: 'ui-project-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <label class="ui-picker" data-testid="project-picker">
      <span>{{ i18n.instant('nav.projects') }}</span>
      <select
        [value]="ctx.selectedId() ?? ''"
        (change)="pick($event)"
        aria-label="Project"
        data-testid="project-select"
      >
        @for (p of ctx.projects(); track p.id) {
          <option [value]="p.id">{{ p.key }} · {{ p.name }}</option>
        }
      </select>
    </label>
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
