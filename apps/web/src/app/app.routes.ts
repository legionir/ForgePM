import { inject } from '@angular/core';
import { Router, type CanActivateFn, type Routes } from '@angular/router';
import { Session } from './session';
import { SetupPage } from './pages/setup';
import { LoginPage } from './pages/login';
import { ProjectsPage } from './pages/projects';
import { ApiKeysPage } from './pages/api-keys';
import { ProjectContext } from './project-context';

/** Redirects unauthenticated users to /login; refreshes session on first hit. */
const authed: CanActivateFn = async () => {
  const session = inject(Session);
  const router = inject(Router);
  if (!session.ready()) await session.refresh();
  return session.me() ? true : router.parseUrl('/login');
};

/**
 * Step-by-step gate: project-scoped pages need a created, selected project.
 * Without one the user is walked back to /projects (where the first project
 * is created) instead of landing on an inert, empty page.
 */
const hasProject: CanActivateFn = async () => {
  const session = inject(Session);
  const router = inject(Router);
  const ctx = inject(ProjectContext);
  if (!session.ready()) await session.refresh();
  if (!session.me()) return router.parseUrl('/login');
  await ctx.ensureLoaded();
  return ctx.hasProject() ? true : router.parseUrl('/projects');
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
  { path: 'dashboard', loadComponent: () => import('./pages/dashboard').then((m) => m.DashboardPage), canActivate: [hasProject] },
  { path: 'work-items', loadComponent: () => import('./pages/work-items').then((m) => m.WorkItemsPage), canActivate: [hasProject] },
  { path: 'work-items/:key', loadComponent: () => import('./pages/work-item-detail').then((m) => m.WorkItemDetailPage), canActivate: [hasProject] },
  { path: 'exec-tasks', loadComponent: () => import('./pages/exec-tasks').then((m) => m.ExecTasksPage), canActivate: [hasProject] },
  { path: 'exec-tasks/:code', loadComponent: () => import('./pages/exec-tasks').then((m) => m.ExecTasksPage), canActivate: [hasProject] },
  { path: 'exec-policy', loadComponent: () => import('./pages/exec-policy').then((m) => m.ExecPolicyPage), canActivate: [hasProject] },
  { path: 'features', loadComponent: () => import('./pages/features').then((m) => m.FeaturesPage), canActivate: [hasProject] },
  { path: 'planner', loadComponent: () => import('./pages/planner').then((m) => m.PlannerPage), canActivate: [hasProject] },
  { path: 'ai-providers', loadComponent: () => import('./pages/ai-providers').then((m) => m.AiProvidersPage), canActivate: [authed] },
  { path: 'approvals', loadComponent: () => import('./pages/approvals').then((m) => m.ApprovalsPage), canActivate: [authed] },
  { path: 'reviews', loadComponent: () => import('./pages/reviews').then((m) => m.ReviewsPage), canActivate: [hasProject] },
  { path: 'github', loadComponent: () => import('./pages/github').then((m) => m.GithubPage), canActivate: [hasProject] },
  { path: 'mcp', loadComponent: () => import('./pages/mcp').then((m) => m.McpPage), canActivate: [authed] },
  { path: 'settings', loadComponent: () => import('./pages/settings').then((m) => m.SettingsPage), canActivate: [authed] },
  { path: 'system', loadComponent: () => import('./pages/system').then((m) => m.SystemPage), canActivate: [authed] },
  { path: 'admin', loadComponent: () => import('./pages/admin').then((m) => m.AdminPage), canActivate: [authed] },
  { path: 'design-system', loadComponent: () => import('./pages/design-system').then((m) => m.DesignSystemPage), canActivate: [authed] },
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
];
