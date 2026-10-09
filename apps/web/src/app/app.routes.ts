import { inject } from '@angular/core';
import { Router, type CanActivateFn, type Routes } from '@angular/router';
import { Session } from './session';
import { AuthPage } from './pages/auth';
import { ProjectsPage } from './pages/projects';
import { ApiKeysPage } from './pages/api-keys';

/** Redirects unauthenticated users to /auth; refreshes session on first hit. */
const authed: CanActivateFn = async () => {
  const session = inject(Session);
  const router = inject(Router);
  if (!session.ready()) await session.refresh();
  return session.me() ? true : router.parseUrl('/auth');
};

export const routes: Routes = [
  { path: 'auth', component: AuthPage },
  { path: 'projects', component: ProjectsPage, canActivate: [authed] },
  { path: 'api-keys', component: ApiKeysPage, canActivate: [authed] },
  { path: '', pathMatch: 'full', redirectTo: 'projects' },
];
