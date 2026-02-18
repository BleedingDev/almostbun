import { afterEach, describe, expect, it, vi } from 'vitest';
import pako from 'pako';
import { bootstrapAndRunGitHubProject } from '../src/repo/runner';
import { resetServerBridge } from '../src/server-bridge';
import { __clearProjectSnapshotCacheForTests } from '../src/repo/project-snapshot-cache';
import { __clearGitHubArchiveCacheForTests } from '../src/repo/github';
import { __clearTarballDownloadCacheForTests } from '../src/npm/tarball';
import { __clearFetchResponseCacheForTests } from '../src/npm/fetch';
import { clearPersistentBinaryCacheForTests } from '../src/cache/persistent-binary-cache';

describe('repo run observability', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    resetServerBridge();
    __clearFetchResponseCacheForTests();
    __clearTarballDownloadCacheForTests();
    __clearGitHubArchiveCacheForTests();
    await __clearProjectSnapshotCacheForTests();
    await clearPersistentBinaryCacheForTests();
  });

  it('reports cold vs warm cache sources across repeated runs', async () => {
    const originalArchiveCacheFlag = process.env.ALMOSTBUN_ENABLE_ARCHIVE_CACHE;
    process.env.ALMOSTBUN_ENABLE_ARCHIVE_CACHE = '1';

    const archive = pako.gzip(
      createMinimalTarball({
        'package/index.html': '<!doctype html><h1>cache-observability</h1>',
      })
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr === 'https://codeload.github.com/acme/demo/tar.gz/HEAD') {
        return new Response(archive, { status: 200 });
      }
      return new Response('not-found', { status: 404 });
    });

    try {
      const first = await bootstrapAndRunGitHubProject('https://github.com/acme/demo', {
        skipInstall: true,
        preflightMode: 'off',
        initServiceWorker: false,
        port: 4201,
      });
      first.running.stop();

      const second = await bootstrapAndRunGitHubProject('https://github.com/acme/demo', {
        skipInstall: true,
        preflightMode: 'off',
        initServiceWorker: false,
        port: 4202,
      });
      second.running.stop();

      expect(first.observability?.cache.snapshotReadSource).toBe('none');
      expect(first.observability?.cache.archiveSource).toBe('network');
      expect(['memory', 'persistent']).toContain(second.observability?.cache.snapshotReadSource);

      const archiveCalls = fetchSpy.mock.calls.filter(
        (call) => String(call[0]) === 'https://codeload.github.com/acme/demo/tar.gz/HEAD'
      );
      expect(archiveCalls).toHaveLength(1);
    } finally {
      if (originalArchiveCacheFlag == null) {
        delete process.env.ALMOSTBUN_ENABLE_ARCHIVE_CACHE;
      } else {
        process.env.ALMOSTBUN_ENABLE_ARCHIVE_CACHE = originalArchiveCacheFlag;
      }
    }
  });

  it('surfaces SLO budget breaches without failing the run', async () => {
    const archive = pako.gzip(
      createMinimalTarball({
        'package/index.html': '<!doctype html><h1>slo</h1>',
      })
    );

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr === 'https://codeload.github.com/acme/demo/tar.gz/HEAD') {
        await new Promise((resolve) => setTimeout(resolve, 8));
        return new Response(archive, { status: 200 });
      }
      return new Response('not-found', { status: 404 });
    });

    const logs: string[] = [];
    const started = await bootstrapAndRunGitHubProject('https://github.com/acme/demo', {
      skipInstall: true,
      preflightMode: 'off',
      initServiceWorker: false,
      port: 4203,
      performanceBudgetsMs: {
        bootstrapMs: 1,
        startMs: 1,
        totalMs: 1,
      },
      log: (message) => logs.push(message),
    });

    started.running.stop();

    expect(started.observability?.slo.passed).toBe(false);
    expect(
      started.observability?.slo.breaches.some((breach) => breach.metric === 'totalMs')
    ).toBe(true);
    expect(logs.some((line) => line.includes('[slo] budget exceeded'))).toBe(true);
  });
});

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

    const sizeOctal = `${contentBytes.length.toString(8).padStart(11, '0')} `;
    header.set(encoder.encode(sizeOctal), 124);
    header.set(encoder.encode('00000000000\0'), 136);
    header.set(encoder.encode('        '), 148);
    header[156] = 48;

    let checksum = 0;
    for (let i = 0; i < 512; i += 1) {
      checksum += header[i]!;
    }
    const checksumStr = `${checksum.toString(8).padStart(6, '0')}\0 `;
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
