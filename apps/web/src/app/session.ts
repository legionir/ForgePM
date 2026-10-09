import { Injectable, inject, signal } from '@angular/core';
import { ApiClient, type MeResponse } from './api';

/** Session state for the whole shell: who am I (null => anonymous). */
@Injectable({ providedIn: 'root' })
export class Session {
  private readonly api = inject(ApiClient);
  readonly me = signal<MeResponse | null>(null);
  readonly ready = signal(false);

  async refresh(): Promise<void> {
    try {
      this.me.set(await this.api.get<MeResponse>('/api/v1/auth/me'));
    } catch {
      this.me.set(null);
    } finally {
      this.ready.set(true);
    }
  }

  async setup(payload: unknown): Promise<void> {
    await this.api.post('/api/v1/auth/setup', payload);
    await this.refresh();
  }

  async login(email: string, password: string): Promise<void> {
    await this.api.post('/api/v1/auth/login', { email, password });
    await this.refresh();
  }

  async logout(): Promise<void> {
    await this.api.post('/api/v1/auth/logout');
    this.me.set(null);
  }
}
