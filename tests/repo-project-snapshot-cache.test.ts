import { afterEach, describe, expect, it, vi } from 'vitest';
import pako from 'pako';
import { VirtualFS } from '../src/virtual-fs';
import { bootstrapGitHubProject } from '../src/repo/bootstrap';
import { __clearProjectSnapshotCacheForTests } from '../src/repo/project-snapshot-cache';
import { __clearGitHubArchiveCacheForTests } from '../src/repo/github';
import { __clearTarballDownloadCacheForTests } from '../src/npm/tarball';
import { __clearFetchResponseCacheForTests } from '../src/npm/fetch';
import { clearPersistentBinaryCacheForTests } from '../src/cache/persistent-binary-cache';

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
