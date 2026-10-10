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

// Domain pages lazy-load (§11: lazy routes keep the initial bundle under the
// 500 KB gzip budget); the shell pages (setup/login/projects) stay eager.
export const routes: Routes = [
  // /auth is the neutral landing: a brand-new install sets up; a returning
  // user signs in. Kept as a redirect so deep links still resolve.
  { path: 'auth', pathMatch: 'full', redirectTo: 'setup' },
  { path: 'setup', component: SetupPage },
  { path: 'login', component: LoginPage },
  { path: 'projects', component: ProjectsPage, canActivate: [authed] },
  { path: 'api-keys', component: ApiKeysPage, canActivate: [authed] },
  { path: 'work-items', loadComponent: () => import('./pages/work-items').then((m) => m.WorkItemsPage), canActivate: [authed] },
  { path: 'work-items/:key', loadComponent: () => import('./pages/work-item-detail').then((m) => m.WorkItemDetailPage), canActivate: [authed] },
  { path: 'features', loadComponent: () => import('./pages/features').then((m) => m.FeaturesPage), canActivate: [authed] },
  { path: 'planner', loadComponent: () => import('./pages/planner').then((m) => m.PlannerPage), canActivate: [authed] },
  { path: 'ai-providers', loadComponent: () => import('./pages/ai-providers').then((m) => m.AiProvidersPage), canActivate: [authed] },
  { path: 'approvals', loadComponent: () => import('./pages/approvals').then((m) => m.ApprovalsPage), canActivate: [authed] },
  { path: 'reviews', loadComponent: () => import('./pages/reviews').then((m) => m.ReviewsPage), canActivate: [authed] },
  { path: 'github', loadComponent: () => import('./pages/github').then((m) => m.GithubPage), canActivate: [authed] },
  { path: 'mcp', loadComponent: () => import('./pages/mcp').then((m) => m.McpPage), canActivate: [authed] },
  { path: 'settings', loadComponent: () => import('./pages/settings').then((m) => m.SettingsPage), canActivate: [authed] },
  { path: 'system', loadComponent: () => import('./pages/system').then((m) => m.SystemPage), canActivate: [authed] },
  { path: 'admin', loadComponent: () => import('./pages/admin').then((m) => m.AdminPage), canActivate: [authed] },
  { path: '', pathMatch: 'full', redirectTo: 'projects' },
];
