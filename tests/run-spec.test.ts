import { describe, expect, it } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import type { BootstrapAndRunResult } from '../src/repo/runner';
import {
  createRunSpec,
  encodeRunSpec,
  decodeRunSpec,
  replayRunSpec,
  extractDeterministicRunOptions,
} from '../src/repo/run-spec';

function createResult(repoUrl: string, lockContents: string): BootstrapAndRunResult {
  const vfs = new VirtualFS();
  vfs.mkdirSync('/project', { recursive: true });
  vfs.writeFileSync('/project/package-lock.json', lockContents);

  return {
    vfs,
    bootstrap: {
      repo: {
        owner: 'acme',
        repo: 'demo',
        ref: 'main',
        sourceUrl: repoUrl,
        archiveUrl: 'https://example.com/archive.tar.gz',
      },
      rootPath: '/project',
      projectPath: '/project',
      extractedFiles: [],
    },
    preflight: {
      issues: [],
      installOverrides: {},
      hasErrors: false,
    },
    detected: {
      kind: 'vite',
      projectPath: '/project',
      serverRoot: '/project',
      reason: 'test fixture',
    },
    running: {
      kind: 'vite',
      projectPath: '/project',
      serverRoot: '/project',
      port: 5173,
      url: 'http://localhost/__virtual__/5173/',
      stop: () => {},
    },
    trace: [],
  };
}

describe('run spec', () => {
  it('creates and round-trips encoded run spec', () => {
    const repoUrl = 'https://github.com/acme/demo';
    const result = createResult(repoUrl, '{"name":"demo","lockfileVersion":3}');
    const spec = createRunSpec({
      repoUrl,
      result,
      options: {
        includeWorkspaces: true,
        preflightMode: 'warn',
      },
    });

    expect(spec.version).toBe(1);
    expect(spec.repo.owner).toBe('acme');
    expect(spec.lockHashes.packageLock).toBeDefined();

    const token = encodeRunSpec(spec);
    const decoded = decodeRunSpec(token);
    expect(decoded).toEqual(spec);
  });

  it('extracts deterministic options with stable defaults', () => {
    const deterministic = extractDeterministicRunOptions();
    expect(deterministic.includeDev).toBe(false);
    expect(deterministic.includeWorkspaces).toBe(true);
    expect(deterministic.preferLockfile).toBe(true);
    expect(deterministic.preflightMode).toBe('warn');
  });

  it('replays spec and validates lock reproducibility', async () => {
    const repoUrl = 'https://github.com/acme/demo';
    const initial = createResult(repoUrl, '{"name":"demo","lockfileVersion":3}');
    const spec = createRunSpec({ repoUrl, result: initial });

    let capturedOptions: unknown;
    const replayed = createResult(repoUrl, '{"name":"demo","lockfileVersion":3}');

    const replay = await replayRunSpec(spec, {
      preflightMode: 'strict',
      runner: async (_url, options) => {
        capturedOptions = options;
        return replayed;
      },
    });

    expect(replay.reproducible).toBe(true);
    expect(replay.lockMismatches).toHaveLength(0);
    expect((capturedOptions as { preflightMode?: string }).preflightMode).toBe('strict');
  });

  it('marks replay as non-reproducible on lock mismatch', async () => {
    const repoUrl = 'https://github.com/acme/demo';
    const initial = createResult(repoUrl, '{"name":"demo","lockfileVersion":3}');
    const spec = createRunSpec({ repoUrl, result: initial });

    const replayed = createResult(repoUrl, '{"name":"demo","lockfileVersion":2}');

    const replay = await replayRunSpec(spec, {
      runner: async () => replayed,
    });

    expect(replay.reproducible).toBe(false);
    expect(replay.lockMismatches.some((mismatch) => mismatch.file === 'packageLock')).toBe(true);
  });
});
