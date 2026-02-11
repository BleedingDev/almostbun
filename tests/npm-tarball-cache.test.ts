import { afterEach, describe, expect, it, vi } from 'vitest';
import pako from 'pako';
import { VirtualFS } from '../src/virtual-fs';
import {
  __clearTarballDownloadCacheForTests,
  downloadAndExtract,
} from '../src/npm/tarball';

describe('npm tarball cache', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    __clearTarballDownloadCacheForTests();
  });

  it('reuses in-memory tarball cache for repeated downloads', async () => {
    const originalEnabled = process.env.ALMOSTBUN_ENABLE_TARBALL_CACHE;
    process.env.ALMOSTBUN_ENABLE_TARBALL_CACHE = '1';

    const firstVfs = new VirtualFS();
    const secondVfs = new VirtualFS();
    const tarball = pako.gzip(
      createMinimalTarball({
        'package/package.json': '{"name":"cached-pkg","version":"1.0.0"}',
      })
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url) === 'https://registry.npmjs.org/cached-pkg/-/cached-pkg-1.0.0.tgz') {
        return new Response(tarball, { status: 200 });
      }
      return new Response('not-found', { status: 404 });
    });

    try {
      await downloadAndExtract(
        'https://registry.npmjs.org/cached-pkg/-/cached-pkg-1.0.0.tgz',
        firstVfs,
        '/node_modules/cached-pkg'
      );
      await downloadAndExtract(
        'https://registry.npmjs.org/cached-pkg/-/cached-pkg-1.0.0.tgz',
        secondVfs,
        '/node_modules/cached-pkg'
      );
    } finally {
      if (originalEnabled === undefined) {
        delete process.env.ALMOSTBUN_ENABLE_TARBALL_CACHE;
      } else {
        process.env.ALMOSTBUN_ENABLE_TARBALL_CACHE = originalEnabled;
      }
    }

    expect(firstVfs.existsSync('/node_modules/cached-pkg/package.json')).toBe(true);
    expect(secondVfs.existsSync('/node_modules/cached-pkg/package.json')).toBe(true);

    const tarballCalls = fetchSpy.mock.calls.filter(
      (call) => String(call[0]) === 'https://registry.npmjs.org/cached-pkg/-/cached-pkg-1.0.0.tgz'
    );
    expect(tarballCalls).toHaveLength(1);
  });

  it('bypasses cache when disableDownloadCache is true', async () => {
    const originalEnabled = process.env.ALMOSTBUN_ENABLE_TARBALL_CACHE;
    process.env.ALMOSTBUN_ENABLE_TARBALL_CACHE = '1';

    const firstVfs = new VirtualFS();
    const secondVfs = new VirtualFS();
    const tarballV1 = pako.gzip(
      createMinimalTarball({
        'package/package.json': '{\"name\":\"no-cache-pkg\",\"version\":\"1.0.0\"}',
      })
    );
    const tarballV2 = pako.gzip(
      createMinimalTarball({
        'package/package.json': '{\"name\":\"no-cache-pkg\",\"version\":\"2.0.0\"}',
      })
    );

    let fetchCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url) === 'https://registry.npmjs.org/no-cache-pkg/-/no-cache-pkg-1.0.0.tgz') {
        fetchCount += 1;
        return new Response(fetchCount === 1 ? tarballV1 : tarballV2, { status: 200 });
      }
      return new Response('not-found', { status: 404 });
    });

    try {
      await downloadAndExtract(
        'https://registry.npmjs.org/no-cache-pkg/-/no-cache-pkg-1.0.0.tgz',
        firstVfs,
        '/node_modules/no-cache-pkg'
      );

      await downloadAndExtract(
        'https://registry.npmjs.org/no-cache-pkg/-/no-cache-pkg-1.0.0.tgz',
        secondVfs,
        '/node_modules/no-cache-pkg',
        { disableDownloadCache: true }
      );
    } finally {
      if (originalEnabled === undefined) {
        delete process.env.ALMOSTBUN_ENABLE_TARBALL_CACHE;
      } else {
        process.env.ALMOSTBUN_ENABLE_TARBALL_CACHE = originalEnabled;
      }
    }

    expect(fetchCount).toBe(2);
    expect(secondVfs.readFileSync('/node_modules/no-cache-pkg/package.json', 'utf8')).toContain('\"2.0.0\"');
  });

  it('reuses persistent tarball cache after memory reset in browser mode', async () => {
    const originalWindow = (globalThis as any).window;
    const originalDocument = (globalThis as any).document;
    const originalLocalStorage = (globalThis as any).localStorage;
    const originalEnabled = process.env.ALMOSTBUN_ENABLE_TARBALL_CACHE;
    const originalPersistentEnabled = process.env.ALMOSTBUN_ENABLE_PERSISTENT_TARBALL_CACHE;

    process.env.ALMOSTBUN_ENABLE_TARBALL_CACHE = '1';
    process.env.ALMOSTBUN_ENABLE_PERSISTENT_TARBALL_CACHE = '1';
    (globalThis as any).window = {};
    (globalThis as any).document = {};
    (globalThis as any).localStorage = createStorageMock();

    const firstVfs = new VirtualFS();
    const secondVfs = new VirtualFS();
    const tarball = pako.gzip(
      createMinimalTarball({
        'package/package.json': '{"name":"persistent-pkg","version":"1.0.0"}',
      })
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url) === 'https://registry.npmjs.org/persistent-pkg/-/persistent-pkg-1.0.0.tgz') {
        return new Response(tarball, { status: 200 });
      }
      return new Response('not-found', { status: 404 });
    });

    try {
      await downloadAndExtract(
        'https://registry.npmjs.org/persistent-pkg/-/persistent-pkg-1.0.0.tgz',
        firstVfs,
        '/node_modules/persistent-pkg'
      );

      __clearTarballDownloadCacheForTests();

      await downloadAndExtract(
        'https://registry.npmjs.org/persistent-pkg/-/persistent-pkg-1.0.0.tgz',
        secondVfs,
        '/node_modules/persistent-pkg'
      );
    } finally {
      if (originalWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = originalWindow;
      if (originalDocument === undefined) delete (globalThis as any).document;
      else (globalThis as any).document = originalDocument;
      if (originalLocalStorage === undefined) delete (globalThis as any).localStorage;
      else (globalThis as any).localStorage = originalLocalStorage;
      if (originalEnabled === undefined) {
        delete process.env.ALMOSTBUN_ENABLE_TARBALL_CACHE;
      } else {
        process.env.ALMOSTBUN_ENABLE_TARBALL_CACHE = originalEnabled;
      }
      if (originalPersistentEnabled === undefined) {
        delete process.env.ALMOSTBUN_ENABLE_PERSISTENT_TARBALL_CACHE;
      } else {
        process.env.ALMOSTBUN_ENABLE_PERSISTENT_TARBALL_CACHE = originalPersistentEnabled;
      }
    }

    expect(firstVfs.existsSync('/node_modules/persistent-pkg/package.json')).toBe(true);
    expect(secondVfs.existsSync('/node_modules/persistent-pkg/package.json')).toBe(true);

    const tarballCalls = fetchSpy.mock.calls.filter(
      (call) => String(call[0]) === 'https://registry.npmjs.org/persistent-pkg/-/persistent-pkg-1.0.0.tgz'
    );
    expect(tarballCalls).toHaveLength(1);
  });
});

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

function createMinimalTarball(files: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];

  for (const [filename, content] of Object.entries(files)) {
    const contentBytes = encoder.encode(content);
    const header = new Uint8Array(512);

    const nameBytes = encoder.encode(filename);
    header.set(nameBytes.slice(0, 100), 0);
    header.set(encoder.encode('0000644\0'), 100);
    header.set(encoder.encode('0000000\0'), 108);
    header.set(encoder.encode('0000000\0'), 116);

    const sizeOctal = contentBytes.length.toString(8).padStart(11, '0') + ' ';
    header.set(encoder.encode(sizeOctal), 124);
    header.set(encoder.encode('00000000000\0'), 136);
    header.set(encoder.encode('        '), 148);
    header[156] = 48;

    let checksum = 0;
    for (let i = 0; i < 512; i++) {
      checksum += header[i];
    }
    const checksumStr = checksum.toString(8).padStart(6, '0') + '\0 ';
    header.set(encoder.encode(checksumStr), 148);

    chunks.push(header);

    const paddedSize = Math.ceil(contentBytes.length / 512) * 512;
    const paddedContent = new Uint8Array(paddedSize);
    paddedContent.set(contentBytes);
    chunks.push(paddedContent);
  }

  chunks.push(new Uint8Array(1024));

  const totalSize = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}
