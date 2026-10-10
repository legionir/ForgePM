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

  async load(): Promise<void> {
    const res = await this.api.get<{ items: Project[] }>('/api/v1/projects');
    this.projects.set(res.items);
    if (!this.selectedId() && res.items[0]) this.select(res.items[0].id);
  }

  select(id: string): void {
    this.selectedId.set(id);
    localStorage.setItem('fpm_project', id);
  }
}
