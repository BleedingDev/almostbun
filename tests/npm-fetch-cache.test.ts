import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __clearFetchResponseCacheForTests,
  fetchWithRetry,
} from '../src/npm/fetch';
import { clearPersistentBinaryCacheForTests } from '../src/cache/persistent-binary-cache';

describe('npm fetch response cache', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    __clearFetchResponseCacheForTests();
    await clearPersistentBinaryCacheForTests();
  });

  it('reuses cached GET responses across repeated calls', async () => {
    const restore = installBrowserEnvironment();
    const originalCacheFlag = process.env.ALMOSTBUN_ENABLE_HTTP_RESPONSE_CACHE;
    process.env.ALMOSTBUN_ENABLE_HTTP_RESPONSE_CACHE = '1';

    let fetchCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ n: fetchCalls }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    try {
      const first = await fetchWithRetry('https://registry.npmjs.org/example', undefined, {
        cache: {
          namespace: 'test-http-cache',
          key: 'example-manifest',
          ttlMs: 60_000,
        },
      });
      const second = await fetchWithRetry('https://registry.npmjs.org/example', undefined, {
        cache: {
          namespace: 'test-http-cache',
          key: 'example-manifest',
          ttlMs: 60_000,
        },
      });

      expect(fetchCalls).toBe(1);
      expect(await first.json()).toEqual({ n: 1 });
      expect(await second.json()).toEqual({ n: 1 });
    } finally {
      if (originalCacheFlag === undefined) {
        delete process.env.ALMOSTBUN_ENABLE_HTTP_RESPONSE_CACHE;
      } else {
        process.env.ALMOSTBUN_ENABLE_HTTP_RESPONSE_CACHE = originalCacheFlag;
      }
      restore();
    }
  });

  it('supports bypass mode to force network refresh', async () => {
    const restore = installBrowserEnvironment();
    const originalCacheFlag = process.env.ALMOSTBUN_ENABLE_HTTP_RESPONSE_CACHE;
    process.env.ALMOSTBUN_ENABLE_HTTP_RESPONSE_CACHE = '1';

    let fetchCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      fetchCalls += 1;
      return new Response(`value-${fetchCalls}`, { status: 200 });
    });

    try {
      const first = await fetchWithRetry('https://registry.npmjs.org/example', undefined, {
        cache: {
          namespace: 'test-http-cache-bypass',
          key: 'example-manifest',
          ttlMs: 60_000,
        },
      });
      const second = await fetchWithRetry('https://registry.npmjs.org/example', undefined, {
        cache: {
          namespace: 'test-http-cache-bypass',
          key: 'example-manifest',
          ttlMs: 60_000,
          mode: 'bypass',
        },
      });

      expect(fetchCalls).toBe(2);
      expect(await first.text()).toBe('value-1');
      expect(await second.text()).toBe('value-2');
    } finally {
      if (originalCacheFlag === undefined) {
        delete process.env.ALMOSTBUN_ENABLE_HTTP_RESPONSE_CACHE;
      } else {
        process.env.ALMOSTBUN_ENABLE_HTTP_RESPONSE_CACHE = originalCacheFlag;
      }
      restore();
    }
  });

  it('returns stale cache entry when network fails and allowStaleOnError is enabled', async () => {
    const restore = installBrowserEnvironment();
    const originalCacheFlag = process.env.ALMOSTBUN_ENABLE_HTTP_RESPONSE_CACHE;
    process.env.ALMOSTBUN_ENABLE_HTTP_RESPONSE_CACHE = '1';

    let fetchCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return new Response('stale-value', { status: 200 });
      }
      throw new TypeError('Failed to fetch');
    });

    try {
      const first = await fetchWithRetry('https://registry.npmjs.org/example', undefined, {
        attempts: 1,
        cache: {
          namespace: 'test-http-cache-stale',
          key: 'example-manifest',
          ttlMs: 1,
        },
      });
      expect(await first.text()).toBe('stale-value');

      await new Promise((resolve) => setTimeout(resolve, 8));

      const second = await fetchWithRetry('https://registry.npmjs.org/example', undefined, {
        attempts: 1,
        cache: {
          namespace: 'test-http-cache-stale',
          key: 'example-manifest',
          ttlMs: 1,
          allowStaleOnError: true,
        },
      });

      expect(fetchCalls).toBe(2);
      expect(await second.text()).toBe('stale-value');
    } finally {
      if (originalCacheFlag === undefined) {
        delete process.env.ALMOSTBUN_ENABLE_HTTP_RESPONSE_CACHE;
      } else {
        process.env.ALMOSTBUN_ENABLE_HTTP_RESPONSE_CACHE = originalCacheFlag;
      }
      restore();
    }
  });
});

function installBrowserEnvironment(): () => void {
  const previousWindow = (globalThis as any).window;
  const previousDocument = (globalThis as any).document;
  const previousLocalStorage = (globalThis as any).localStorage;

  (globalThis as any).window = {};
  (globalThis as any).document = {};
  (globalThis as any).localStorage = createStorageMock();

  return () => {
    if (previousWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = previousWindow;

    if (previousDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = previousDocument;

    if (previousLocalStorage === undefined) delete (globalThis as any).localStorage;
    else (globalThis as any).localStorage = previousLocalStorage;
  };
}

function createStorageMock() {
  const storage = new Map<string, string>();
  return {
    get length() {
      return storage.size;
    },
    key(index: number): string | null {
      return [...storage.keys()][index] ?? null;
    },
    getItem(key: string): string | null {
      return storage.has(key) ? storage.get(key)! : null;
    },
    setItem(key: string, value: string): void {
      storage.set(key, String(value));
    },
    removeItem(key: string): void {
      storage.delete(key);
    },
  };
}
