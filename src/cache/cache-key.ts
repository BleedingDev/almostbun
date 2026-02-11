/**
 * Versioned cache key helpers.
 *
 * These keys provide explicit invalidation boundaries across releases,
 * runtime targets, and operator-controlled cache epochs.
 */

const DEFAULT_CACHE_SCHEMA_VERSION = '2026-02-12';

function getRuntimeEnvValue(name: string): string | undefined {
  try {
    const runtimeProcess = (globalThis as typeof globalThis & {
      process?: { env?: Record<string, string | undefined> };
    }).process;
    return runtimeProcess?.env?.[name];
  } catch {
    return undefined;
  }
}

function normalizeToken(value: string): string {
  return value.trim().replace(/\s+/g, '_').replace(/\|/g, '_');
}

export function getCacheSchemaVersion(): string {
  const env = getRuntimeEnvValue('ALMOSTBUN_CACHE_SCHEMA_VERSION');
  return normalizeToken(env || DEFAULT_CACHE_SCHEMA_VERSION);
}

export function getCacheEpoch(): string {
  const env = getRuntimeEnvValue('ALMOSTBUN_CACHE_EPOCH');
  return normalizeToken(env || '0');
}

export function getCacheRuntimeToken(): string {
  const hasWindow = typeof window !== 'undefined';
  const hasDocument = typeof document !== 'undefined';
  return hasWindow && hasDocument ? 'browser' : 'node';
}

export interface BuildVersionedCacheKeyOptions {
  namespace: string;
  rawKey: string;
  scope?: string;
}

/**
 * Build a stable, versioned key prefix for persistent caches.
 */
export function buildVersionedCacheKey(options: BuildVersionedCacheKeyOptions): string {
  const namespace = normalizeToken(options.namespace || 'default');
  const scope = normalizeToken(options.scope || 'global');
  const rawKey = options.rawKey || '';
  return [
    'almostbun-cache',
    getCacheSchemaVersion(),
    getCacheEpoch(),
    getCacheRuntimeToken(),
    namespace,
    scope,
    rawKey,
  ].join('|');
}
