import { Injectable, computed, inject, signal } from '@angular/core';
import { ApiClient } from './api';

export interface Project {
  id: string;
  key: string;
  name: string;
  status: 'active' | 'archived';
}

/**
 * The "quick project switcher" (plan §5.11 Projects page) is a single
 * app-wide signal so every domain page (work items, features, milestones,
 * planner, reviews) shares one selected project without prop drilling.
 */
@Injectable({ providedIn: 'root' })
export class ProjectContext {
  private readonly api = inject(ApiClient);

  readonly projects = signal<Project[]>([]);
  readonly selectedId = signal<string | null>(localStorage.getItem('fpm_project') ?? null);
  readonly selected = computed(() => this.projects().find((p) => p.id === this.selectedId()) ?? null);
  /** Load lifecycle for UI states (STT-003): picker shows skeleton/error. */
  readonly loading = signal(true);
  readonly error = signal('');

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const res = await this.api.get<{ items: Project[] }>('/api/v1/projects');
      this.projects.set(res.items);
      if (!this.selectedId() && res.items[0]) this.select(res.items[0].id);
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  select(id: string): void {
    this.selectedId.set(id);
    localStorage.setItem('fpm_project', id);
  }
}
