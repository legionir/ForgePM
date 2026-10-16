import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

export interface UiCrumb {
  label: string;
  link?: string;
}

/**
 * Breadcrumbs (plan §3 `ui/breadcrumbs`, §4 detail pages): Projects / Work
 * Items / KEY. Last crumb is the current page (aria-current) and renders as
 * plain text; intermediate crumbs are links.
 */
@Component({
  selector: 'ui-breadcrumbs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <nav class="ui-crumbs" aria-label="Breadcrumb">
      <ol>
        @for (c of items(); track $index; let last = $last) {
          <li>
            @if (c.link && !last) {
              <a [routerLink]="c.link">{{ c.label }}</a>
            } @else {
              <span [attr.aria-current]="last ? 'page' : null">{{ c.label }}</span>
            }
          </li>
        }
      </ol>
    </nav>
  `,
})
export class UiBreadcrumbs {
  readonly items = input<UiCrumb[]>([]);
}
