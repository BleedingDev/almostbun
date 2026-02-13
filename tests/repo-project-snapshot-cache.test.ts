import { afterEach, describe, expect, it, vi } from 'vitest';
import pako from 'pako';
import { VirtualFS } from '../src/virtual-fs';
import { bootstrapGitHubProject } from '../src/repo/bootstrap';
import { parseGitHubRepoUrl } from '../src/repo/github';
import { simpleHash } from '../src/utils/hash';
import { buildVersionedCacheKey } from '../src/cache/cache-key';
import {
  __clearProjectSnapshotCacheForTests,
  readBootstrapProjectSnapshotCache,
  writeBootstrapProjectSnapshotCache,
} from '../src/repo/project-snapshot-cache';
import { __clearGitHubArchiveCacheForTests } from '../src/repo/github';
import { __clearTarballDownloadCacheForTests } from '../src/npm/tarball';
import { __clearFetchResponseCacheForTests } from '../src/npm/fetch';
import {
  clearPersistentBinaryCacheForTests,
  writePersistentBinaryCache,
} from '../src/cache/persistent-binary-cache';

describe('repo bootstrap project snapshot cache', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    __clearFetchResponseCacheForTests();
    __clearTarballDownloadCacheForTests();
    __clearGitHubArchiveCacheForTests();
    await __clearProjectSnapshotCacheForTests();
    await clearPersistentBinaryCacheForTests();
  });

  it('restores repeated bootstrap runs from snapshot cache', async () => {
    const firstVfs = new VirtualFS();
    const secondVfs = new VirtualFS();

    const repoArchive = pako.gzip(
      createMinimalTarball({
        'package/package.json': JSON.stringify({
          name: 'demo-app',
          version: '1.0.0',
          dependencies: {
            'tiny-pkg': '^1.0.0',
          },
        }),
        'package/src/index.ts': 'export const value = 42;',
      })
    );

    const tinyManifest = {
      name: 'tiny-pkg',
      'dist-tags': { latest: '1.2.0' },
      versions: {
        '1.2.0': {
          name: 'tiny-pkg',
          version: '1.2.0',
          dist: {
            tarball: 'https://registry.npmjs.org/tiny-pkg/-/tiny-pkg-1.2.0.tgz',
            shasum: 'abc123',
          },
          dependencies: {},
        },
      },
    };

    const tinyArchive = pako.gzip(
      createMinimalTarball({
        'package/package.json': '{"name":"tiny-pkg","version":"1.2.0"}',
        'package/index.js': 'module.exports = "tiny";',
      })
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr === 'https://codeload.github.com/acme/demo/tar.gz/HEAD') {
        return new Response(repoArchive, { status: 200 });
      }
      if (urlStr.includes('registry.npmjs.org/tiny-pkg') && !urlStr.includes('.tgz')) {
        return new Response(JSON.stringify(tinyManifest), { status: 200 });
      }
      if (urlStr.includes('tiny-pkg-1.2.0.tgz')) {
        return new Response(tinyArchive, { status: 200 });
      }
      return new Response('not-found', { status: 404 });
    });

    const first = await bootstrapGitHubProject(firstVfs, 'https://github.com/acme/demo');
    const firstNetworkCalls = fetchSpy.mock.calls.length;
    expect(firstNetworkCalls).toBeGreaterThanOrEqual(3);
    expect(first.installResult?.installed.get('tiny-pkg')?.version).toBe('1.2.0');
    expect(firstVfs.existsSync('/project/node_modules/tiny-pkg/index.js')).toBe(true);

    const second = await bootstrapGitHubProject(secondVfs, 'https://github.com/acme/demo');
    expect(fetchSpy.mock.calls.length).toBe(firstNetworkCalls);
    expect(second.installResult?.installed.get('tiny-pkg')?.version).toBe('1.2.0');
    expect(secondVfs.existsSync('/project/node_modules/tiny-pkg/index.js')).toBe(true);
  });

  it('supports bypass mode to disable snapshot read/write', async () => {
    const firstVfs = new VirtualFS();
    const secondVfs = new VirtualFS();

    const repoArchive = pako.gzip(
      createMinimalTarball({
        'package/package.json': JSON.stringify({
          name: 'demo-app',
          version: '1.0.0',
        }),
        'package/index.js': 'console.log("hello");',
      })
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr === 'https://codeload.github.com/acme/demo/tar.gz/HEAD') {
        return new Response(repoArchive, { status: 200 });
      }
      return new Response('not-found', { status: 404 });
    });

    await bootstrapGitHubProject(firstVfs, 'https://github.com/acme/demo', {
      skipInstall: true,
      projectSnapshotCacheMode: 'bypass',
    });

    await bootstrapGitHubProject(secondVfs, 'https://github.com/acme/demo', {
      skipInstall: true,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(secondVfs.existsSync('/project/package.json')).toBe(true);
  });

  it('hydrates symlink entries from snapshot cache', async () => {
    const repoUrl = 'https://github.com/acme/symlink-demo';
    const firstVfs = new VirtualFS();
    const secondVfs = new VirtualFS();

    const repoArchive = pako.gzip(
      createMinimalTarball({
        'package/package.json': JSON.stringify({
          name: 'symlink-demo',
          version: '1.0.0',
        }),
        'package/target.txt': 'hello',
      })
    );

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr === 'https://codeload.github.com/acme/symlink-demo/tar.gz/HEAD') {
        return new Response(repoArchive, { status: 200 });
      }
      return new Response('not-found', { status: 404 });
    });

    const first = await bootstrapGitHubProject(firstVfs, repoUrl, { skipInstall: true });
    firstVfs.symlinkSync('/project/target.txt', '/project/target-link.txt');

    const wrote = await writeBootstrapProjectSnapshotCache(
      firstVfs,
      repoUrl,
      { skipInstall: true },
      first
    );
    expect(wrote).toBe(true);

    const restored = await readBootstrapProjectSnapshotCache(secondVfs, repoUrl, { skipInstall: true });
    expect(restored).not.toBeNull();

    const linkStats = secondVfs.lstatSync('/project/target-link.txt');
    expect(linkStats.isSymbolicLink()).toBe(true);
    expect(secondVfs.readlinkSync('/project/target-link.txt')).toBe('/project/target.txt');
    expect(secondVfs.readFileSync('/project/target-link.txt', 'utf8')).toBe('hello');
  });

  it('restores files/symlinks even when snapshot directory entries are missing', async () => {
    const restore = installBrowserEnvironment();
    const repoUrl = 'https://github.com/acme/snapshot-parent-recovery';
    const parsedRepo = parseGitHubRepoUrl(repoUrl);
    const cacheKey = buildProjectSnapshotCacheKeyForTest(repoUrl, { skipInstall: true });
    try {
      const snapshotRecord = {
        version: 1,
        storedAt: Date.now(),
        result: {
          repo: parsedRepo,
          rootPath: '/project',
          projectPath: '/project',
          extractedFiles: ['/project/target.txt', '/project/target-link.txt'],
          transformedProjectFiles: 0,
        },
        snapshot: {
          files: [
            { path: '/', type: 'directory' as const },
            {
              path: '/project/target.txt',
              type: 'file' as const,
              content: Buffer.from('hello-parent').toString('base64'),
            },
            {
              path: '/project/target-link.txt',
              type: 'symlink' as const,
              target: '/project/target.txt',
            },
          ],
        },
      };

      const encoded = pako.gzip(
        new TextEncoder().encode(JSON.stringify(snapshotRecord))
      );
      await writePersistentBinaryCache(
        {
          namespace: 'project-snapshots',
          key: cacheKey,
          maxEntries: 16,
          maxBytes: 16 * 1024 * 1024,
          contentAddressed: true,
        },
        encoded
      );

      const restoredVfs = new VirtualFS();
      const restored = await readBootstrapProjectSnapshotCache(restoredVfs, repoUrl, {
        skipInstall: true,
      });

      expect(restored).not.toBeNull();
      expect(restored?.source).toBe('persistent');
      expect(restoredVfs.readFileSync('/project/target.txt', 'utf8')).toBe('hello-parent');
      expect(restoredVfs.lstatSync('/project/target-link.txt').isSymbolicLink()).toBe(true);
      expect(restoredVfs.readlinkSync('/project/target-link.txt')).toBe('/project/target.txt');
      expect(restoredVfs.readFileSync('/project/target-link.txt', 'utf8')).toBe('hello-parent');
    } finally {
      restore();
    }
  });

  it('supports refresh mode to bypass read and rewrite cache', async () => {
    let marker = 'v1';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr === 'https://codeload.github.com/acme/demo/tar.gz/HEAD') {
        return new Response(toArrayBuffer(createRepoArchive(marker)), { status: 200 });
      }
      return new Response('not-found', { status: 404 });
    });

    const firstVfs = new VirtualFS();
    await bootstrapGitHubProject(firstVfs, 'https://github.com/acme/demo', {
      skipInstall: true,
    });
    expect(firstVfs.readFileSync('/project/marker.txt', 'utf8')).toBe('v1');

    marker = 'v2';
    const refreshedVfs = new VirtualFS();
    await bootstrapGitHubProject(refreshedVfs, 'https://github.com/acme/demo', {
      skipInstall: true,
      projectSnapshotCacheMode: 'refresh',
    });
    expect(refreshedVfs.readFileSync('/project/marker.txt', 'utf8')).toBe('v2');

    marker = 'v3';
    const restoredVfs = new VirtualFS();
    await bootstrapGitHubProject(restoredVfs, 'https://github.com/acme/demo', {
      skipInstall: true,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(restoredVfs.readFileSync('/project/marker.txt', 'utf8')).toBe('v2');
  });

  it('expires stale snapshots based on ttl', async () => {
    let marker = 'ttl-1';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr === 'https://codeload.github.com/acme/demo/tar.gz/HEAD') {
        return new Response(toArrayBuffer(createRepoArchive(marker)), { status: 200 });
      }
      return new Response('not-found', { status: 404 });
    });

    const firstVfs = new VirtualFS();
    await bootstrapGitHubProject(firstVfs, 'https://github.com/acme/demo', {
      skipInstall: true,
      projectSnapshotCacheTtlMs: 1,
    });
    expect(firstVfs.readFileSync('/project/marker.txt', 'utf8')).toBe('ttl-1');

    await new Promise((resolve) => setTimeout(resolve, 5));

    marker = 'ttl-2';
    const secondVfs = new VirtualFS();
    await bootstrapGitHubProject(secondVfs, 'https://github.com/acme/demo', {
      skipInstall: true,
      projectSnapshotCacheTtlMs: 1,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(secondVfs.readFileSync('/project/marker.txt', 'utf8')).toBe('ttl-2');
  });
});

function createRepoArchive(marker: string): Uint8Array {
  return pako.gzip(
    createMinimalTarball({
      'package/package.json': JSON.stringify({
        name: 'demo-app',
        version: '1.0.0',
      }),
      'package/marker.txt': marker,
    })
  );
}

function buildProjectSnapshotCacheKeyForTest(
  repoUrl: string,
  options: { skipInstall?: boolean }
): string {
  const parsed = parseGitHubRepoUrl(repoUrl);
  const fingerprint = {
    sourceUrl: parsed.sourceUrl,
    ref: parsed.ref,
    subdir: parsed.subdir || '',
    destPath: '/project',
    skipInstall: options.skipInstall === true,
    includeDev: false,
    includeOptional: false,
    includeWorkspaces: true,
    preferPublishedWorkspacePackages: false,
    transform: true,
    transformProjectSources: true,
  };

  const repoHash = simpleHash(repoUrl.trim().toLowerCase());
  const optionsHash = simpleHash(JSON.stringify(fingerprint));
  return buildVersionedCacheKey({
    namespace: 'project-snapshot',
    scope: 'bootstrap',
    rawKey: `${repoHash}|${optionsHash}`,
  });
}

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

function toArrayBuffer(input: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(input.byteLength);
  copy.set(input);
  return copy.buffer;
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
