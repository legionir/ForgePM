import { AppError } from '@forgepm/shared';
import type { Db } from '../db/unitOfWork';
import { getEffective, upsertSetting } from '../settings';

export type ModuleName = string;

/** A module can validate its own config before being enabled (plan §3b-1.4). */
export interface ModuleDefinition {
  name: ModuleName;
  /** Optional validation run on enable. Throw to reject enabling. */
  validateConfig?: (db: Db) => Promise<void>;
}

interface CachedFlag {
  enabled: boolean;
  cachedAt: number;
}

const TTL_MS = 5000; // cache ≤ 5s, invalidated on change (plan §3b-1.2)

/**
 * Module registry (plan §3b-1, §4.4): registration means "exists", not "on".
 * Enablement is read at runtime from settings `modules.<name>.enabled`.
 */
export class ModuleRegistry {
  private defs = new Map<ModuleName, ModuleDefinition>();
  private cache = new Map<string, CachedFlag>();

  register(def: ModuleDefinition): void {
    this.defs.set(def.name, def);
  }

  isRegistered(name: ModuleName): boolean {
    return this.defs.has(name);
  }

  list(): ModuleDefinition[] {
    return [...this.defs.values()];
  }

  private cacheKey(name: ModuleName, orgId: string | null, projectId: string | null): string {
    return `${name}|${orgId ?? '-'}|${projectId ?? '-'}`;
  }

  /** Effective enabled state for a module at system/org/project scope. */
  async isEnabled(db: Db, name: ModuleName, orgId: string | null = null, projectId: string | null = null): Promise<boolean> {
    const key = this.cacheKey(name, orgId, projectId);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.cachedAt < TTL_MS) return hit.enabled;

    const eff = await getEffective(db, `modules.${name}.enabled`, orgId, projectId);
    const enabled = eff?.value === true;
    this.cache.set(key, { enabled, cachedAt: Date.now() });
    return enabled;
  }

  /** Drop cached flags so a settings change takes effect without restart. */
  invalidate(name?: ModuleName): void {
    if (!name) this.cache.clear();
    else for (const k of [...this.cache.keys()]) if (k.startsWith(`${name}|`)) this.cache.delete(k);
  }

  /** Enable = validate then flip the system-level setting (plan §3b-1.4). */
  async enable(db: Db, name: ModuleName, orgId: string | null = null): Promise<void> {
    const def = this.defs.get(name);
    if (!def) throw new AppError('NOT_FOUND', `module '${name}' is not registered`);
    if (def.validateConfig) await def.validateConfig(db);
    await upsertSetting(db, orgId ? 'organization' : 'system', orgId, `modules.${name}.enabled`, true);
    this.invalidate(name);
  }

  async disable(db: Db, name: ModuleName, orgId: string | null = null): Promise<void> {
    await upsertSetting(db, orgId ? 'organization' : 'system', orgId, `modules.${name}.enabled`, false);
    this.invalidate(name);
  }
}

/**
 * requireModule: guard at every entry point (route / job / MCP tool).
 * Disabled module on REST/Webhook => 503 MODULE_DISABLED (plan §3b-1.3).
 */
export function makeRequireModule(registry: ModuleRegistry, db: Db) {
  return async function requireModule(
    name: ModuleName,
    ctx: { organizationId: string | null; projectId: string | null },
  ): Promise<void> {
    const enabled = await registry.isEnabled(db, name, ctx.organizationId, ctx.projectId);
    if (!enabled) throw new AppError('MODULE_DISABLED', `module '${name}' is disabled`);
  };
}

/**
 * Plain settings read of `modules.<name>.enabled` without a registry instance
 * (the worker uses this; the api uses the cached ModuleRegistry).
 */
export async function isModuleEnabled(db: Db, name: ModuleName, orgId: string | null = null, projectId: string | null = null): Promise<boolean> {
  const eff = await getEffective(db, `modules.${name}.enabled`, orgId, projectId);
  return eff?.value === true;
}
