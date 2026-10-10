import { inject } from '@angular/core';
import { Router, type CanActivateFn, type Routes } from '@angular/router';
import { Session } from './session';
import { SetupPage } from './pages/setup';
import { LoginPage } from './pages/login';
import { ProjectsPage } from './pages/projects';
import { ApiKeysPage } from './pages/api-keys';

/** Redirects unauthenticated users to /login; refreshes session on first hit. */
const authed: CanActivateFn = async () => {
  const session = inject(Session);
  const router = inject(Router);
  if (!session.ready()) await session.refresh();
  return session.me() ? true : router.parseUrl('/login');
};

export const routes: Routes = [
  // /auth is the neutral landing: a brand-new install sets up; a returning
  // user signs in. Kept as a redirect so deep links still resolve.
  { path: 'auth', pathMatch: 'full', redirectTo: 'setup' },
  { path: 'setup', component: SetupPage },
  { path: 'login', component: LoginPage },
  { path: 'projects', component: ProjectsPage, canActivate: [authed] },
  { path: 'api-keys', component: ApiKeysPage, canActivate: [authed] },
  { path: '', pathMatch: 'full', redirectTo: 'projects' },
];
