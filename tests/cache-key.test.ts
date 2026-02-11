import { describe, expect, it } from 'vitest';
import {
  buildVersionedCacheKey,
  getCacheEpoch,
  getCacheRuntimeToken,
  getCacheSchemaVersion,
} from '../src/cache/cache-key';

describe('cache key helpers', () => {
  it('builds stable versioned cache keys', () => {
    const key = buildVersionedCacheKey({
      namespace: 'npm-manifest',
      scope: 'registry.npmjs.org',
      rawKey: 'react',
    });

    expect(key).toContain('almostbun-cache');
    expect(key).toContain('npm-manifest');
    expect(key).toContain('registry.npmjs.org');
    expect(key.endsWith('|react')).toBe(true);
  });

  it('provides non-empty schema/epoch/runtime tokens', () => {
    expect(getCacheSchemaVersion().length).toBeGreaterThan(0);
    expect(getCacheEpoch().length).toBeGreaterThan(0);
    expect(getCacheRuntimeToken().length).toBeGreaterThan(0);
  });
});
