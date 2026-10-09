import IORedis from 'ioredis';
import { ModuleRegistry, type Db } from '@forgepm/core';
import { sampleModule } from '../modules/sample/module';

/**
 * Module registration happens at startup regardless of enabled state
 * (plan §3b-1.1: registration means "exists", not "on").
 */
export function buildRegistry(): ModuleRegistry {
  const registry = new ModuleRegistry();
  registry.register(sampleModule);
  // github, code_review, refactor_review, mcp_client register here in later phases.
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
