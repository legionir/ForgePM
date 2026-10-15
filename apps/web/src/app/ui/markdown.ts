import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { parseMarkdown } from './logic';

export { parseMarkdown };
export type { MdSegment } from './logic';



/** Markdown renderer — one paragraph per line pair, typed segments only. */
@Component({
  selector: 'ui-markdown',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (p of paragraphs(); track $index) {
      <p class="ui-md-p">
        @for (s of p; track $index) {
          @switch (s.t) {
            @case ('bold') {
              <strong>{{ s.v }}</strong>
            }
            @case ('italic') {
              <em>{{ s.v }}</em>
            }
            @case ('code') {
              <code>{{ s.v }}</code>
            }
            @case ('link') {
              <a [href]="s.href" target="_blank" rel="noopener noreferrer">{{ s.v }}</a>
            }
            @default {
              {{ s.v }}
            }
          }
        }
      </p>
    } @empty {
      <p class="ui-md-p">{{ fallback() }}</p>
    }
  `,
  host: { class: 'ui-markdown' },
})
export class UiMarkdown {
  readonly text = input('');
  readonly fallback = input('');

  readonly paragraphs = () => parseMarkdown(this.text());
}
