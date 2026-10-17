import IORedis from 'ioredis';
import { ModuleRegistry, type Db } from '@forgepm/core';
import { sampleModule } from '../modules/sample/module';
import { githubModule } from '../modules/github/module';
import { validateConfig as githubValidate } from '../modules/github/config';
import { codeReviewModule, refactorReviewModule } from '../modules/reviews/module';
import { execControlModule } from '../modules/exec/module';

/**
 * Module registration happens at startup regardless of enabled state
 * (plan §3b-1.1: registration means "exists", not "on").
 */
export function buildRegistry(): ModuleRegistry {
  const registry = new ModuleRegistry();
  registry.register(sampleModule);
  // github is always registered; validateConfig (runs on enable) checks for a
  // webhook secret. The core runs fully with no github config at all (§9).
  registry.register({ ...githubModule, validateConfig: githubValidate });
  // Phase 6 review modules: always registered, off by default, no config
  // required to enable (the AI provider is checked per run, not at enable).
  registry.register(codeReviewModule);
  registry.register(refactorReviewModule);
  // Execution control (PE-0): registered, OFF by default. `validateConfig` checks the
  // exec.* policy/harness settings on enable so the gate never reads a broken document.
  registry.register(execControlModule);
  // mcp_client registers in a later phase (4b, deferred).
  return registry;
}

export interface RedisProbe {
  available(): Promise<boolean>;
  close(): Promise<void>;
}

/** Minimal Redis probe for /health/ready (separate from the BullMQ connection). */
export function createHealthRedisProbe(url: string): RedisProbe {
  const client = new IORedis(url, { maxRetriesPerRequest: 1, retryStrategy: () => null, lazyConnect: true });
  return {
    async available() {
      try {
        if (client.status !== 'ready') await client.connect();
        return (await client.ping()) === 'PONG';
      } catch {
        return false;
      }
    },
    async close() {
      try {
        await client.quit();
      } catch {
        /* ignore */
      }
    },
  };
}

export type { Db };
