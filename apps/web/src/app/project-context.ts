import { Injectable, computed, inject, signal } from '@angular/core';
import { ApiClient } from './api';
import { UiToastService } from './ui/toast';

export interface Project {
  id: string;
  key: string;
  name: string;
  status: 'active' | 'archived';
  description?: string | null;
  priority?: 'none' | 'low' | 'medium' | 'high' | 'urgent';
  start_date?: string | null;
  target_date?: string | null;
}

/**
 * The "quick project switcher" (plan §5.11 Projects page) is a single
 * app-wide signal so every domain page (work items, features, milestones,
 * planner, reviews) shares one selected project without prop drilling.
 *
 * It also drives the step-by-step navigation: project-scoped sections are
 * only offered (and routable) while `hasProject()` is true.
 */
@Injectable({ providedIn: 'root' })
export class ProjectContext {
  private readonly api = inject(ApiClient);
  private readonly toast = inject(UiToastService);

  readonly projects = signal<Project[]>([]);
  readonly selectedId = signal<string | null>(localStorage.getItem('fpm_project') ?? null);
  readonly selected = computed(() => this.projects().find((p) => p.id === this.selectedId()) ?? null);
  /** True once a real, existing project is selected (gates scoped nav/routes). */
  readonly hasProject = computed(() => this.selected() !== null);
  /** Load lifecycle for UI states (STT-003): picker shows skeleton/error. */
  readonly loading = signal(true);
  /** Set after the first load settles (success or failure). */
  readonly loaded = signal(false);
  readonly error = signal('');

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const res = await this.api.get<{ items: Project[] }>('/api/v1/projects');
      this.projects.set(res.items);
      const current = res.items.find((p) => p.id === this.selectedId());
      if (!current || current.status === 'archived') {
        const next = res.items.find((p) => p.status === 'active');
        if (next) this.select(next.id);
        else this.clear();
      }
    } catch (err) {
      this.error.set((err as Error).message);
      this.toast.error((err as Error).message);
    } finally {
      this.loading.set(false);
      this.loaded.set(true);
    }
  }

  /** Loads once; later callers reuse the cached list. */
  async ensureLoaded(): Promise<void> {
    if (!this.loaded()) await this.load();
  }

  select(id: string): void {
    this.selectedId.set(id);
    localStorage.setItem('fpm_project', id);
  }

  clear(): void {
    this.selectedId.set(null);
    localStorage.removeItem('fpm_project');
  }
}
