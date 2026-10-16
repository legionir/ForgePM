import { Directive, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';

/**
 * aria-current companion for `routerLink` anchors (STT-006): mirrors
 * RouterLinkActive's subset matching so screen readers announce the current
 * page instead of only a visual class.
 */
@Directive({
  selector: 'a[routerLink]',
  host: { '[attr.aria-current]': `active() ? 'page' : null` },
})
export class UiNavCurrent implements OnInit, OnDestroy {
  private readonly router = inject(Router);
  private readonly link = inject(RouterLink);
  private sub?: Subscription;
  readonly active = signal(false);

  ngOnInit(): void {
    this.update();
    this.sub = this.router.events.subscribe((e) => {
      if (e instanceof NavigationEnd) this.update();
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  private update(): void {
    const tree = this.link.urlTree;
    if (tree) {
      this.active.set(
        this.router.isActive(tree, {
          paths: 'subset',
          queryParams: 'subset',
          fragment: 'ignored',
          matrixParams: 'ignored',
        }),
      );
    }
  }
}
