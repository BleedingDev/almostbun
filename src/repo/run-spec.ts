import { hashBytes } from '../utils/hash';
import type { VirtualFS } from '../virtual-fs';
import {
  bootstrapAndRunGitHubProject,
  type BootstrapAndRunOptions,
  type BootstrapAndRunResult,
  type RunnableProjectKind,
} from './runner';

export interface RunSpecDeterministicOptions {
  includeDev: boolean;
  includeOptional: boolean;
  includeWorkspaces: boolean;
  preferLockfile: boolean;
  preferPublishedWorkspacePackages: boolean;
  transformProjectSources: boolean;
  preflightMode: 'off' | 'warn' | 'strict';
  serverReadyTimeoutMs?: number;
  disableViteHmrInjection: boolean;
}

export interface RunSpec {
  version: 1;
  generatedAt: string;
  repo: {
    sourceUrl: string;
    owner: string;
    repo: string;
    ref: string;
    subdir?: string;
  };
  projectPath: string;
  detectedKind: RunnableProjectKind;
  options: RunSpecDeterministicOptions;
  lockHashes: {
    packageLock?: string;
    bunLock?: string;
    bunLockb?: string;
  };
}

export interface CreateRunSpecOptions {
  repoUrl: string;
  result: BootstrapAndRunResult;
  options?: BootstrapAndRunOptions;
}

export interface ReplayRunSpecResult {
  result: BootstrapAndRunResult;
  reproducible: boolean;
  lockMismatches: Array<{
    file: keyof RunSpec['lockHashes'];
    expected: string;
    actual?: string;
  }>;
}

export interface ReplayRunSpecOptions extends Partial<BootstrapAndRunOptions> {
  runner?: (
    repoUrl: string,
    options?: BootstrapAndRunOptions
  ) => Promise<BootstrapAndRunResult>;
}

function encodeBase64Url(value: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value, 'utf8').toString('base64url');
  }
  const encoded = btoa(unescape(encodeURIComponent(value)));
  return encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value, 'base64url').toString('utf8');
  }
  const normalized = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  return decodeURIComponent(escape(atob(normalized)));
}

function hashVfsFile(vfs: VirtualFS, filePath: string): string | undefined {
  if (!vfs.existsSync(filePath)) {
    return undefined;
  }
  try {
    const content = vfs.readFileSync(filePath);
    return hashBytes(content);
  } catch {
    return undefined;
  }
}

export function getRunSpecLockHashes(vfs: VirtualFS, projectPath: string): RunSpec['lockHashes'] {
  const normalizedPath = projectPath.replace(/\/+$/, '');
  const packageLockPath = `${normalizedPath}/package-lock.json`;
  const bunLockPath = `${normalizedPath}/bun.lock`;
  const bunLockbPath = `${normalizedPath}/bun.lockb`;

  return {
    packageLock: hashVfsFile(vfs, packageLockPath),
    bunLock: hashVfsFile(vfs, bunLockPath),
    bunLockb: hashVfsFile(vfs, bunLockbPath),
  };
}

export function extractDeterministicRunOptions(
  options?: Partial<BootstrapAndRunOptions>
): RunSpecDeterministicOptions {
  return {
    includeDev: !!options?.includeDev,
    includeOptional: !!options?.includeOptional,
    includeWorkspaces: options?.includeWorkspaces !== false,
    preferLockfile: options?.preferLockfile !== false,
    preferPublishedWorkspacePackages: !!options?.preferPublishedWorkspacePackages,
    transformProjectSources: options?.transformProjectSources !== false,
    preflightMode: options?.preflightMode ?? 'warn',
    serverReadyTimeoutMs: options?.serverReadyTimeoutMs,
    disableViteHmrInjection: !!options?.disableViteHmrInjection,
  };
}

export function createRunSpec(input: CreateRunSpecOptions): RunSpec {
  const { repoUrl, result, options } = input;
  const repo = result.bootstrap.repo;

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    repo: {
      sourceUrl: repoUrl,
      owner: repo.owner,
      repo: repo.repo,
      ref: repo.ref,
      subdir: repo.subdir,
    },
    projectPath: result.bootstrap.projectPath,
    detectedKind: result.detected.kind,
    options: extractDeterministicRunOptions(options),
    lockHashes: getRunSpecLockHashes(result.vfs, result.bootstrap.projectPath),
  };
}

export function encodeRunSpec(spec: RunSpec): string {
  return encodeBase64Url(JSON.stringify(spec));
}

export function decodeRunSpec(token: string): RunSpec {
  const parsed = JSON.parse(decodeBase64Url(token)) as RunSpec;
  if (parsed.version !== 1) {
    throw new Error(`Unsupported RunSpec version: ${String((parsed as { version?: unknown }).version)}`);
  }
  return parsed;
}

export function resolveReplayOptions(
  spec: RunSpec,
  overrides: Partial<BootstrapAndRunOptions> = {}
): BootstrapAndRunOptions {
  const deterministic = spec.options;

  return {
    includeDev: overrides.includeDev ?? deterministic.includeDev,
    includeOptional: overrides.includeOptional ?? deterministic.includeOptional,
    includeWorkspaces: overrides.includeWorkspaces ?? deterministic.includeWorkspaces,
    preferLockfile: overrides.preferLockfile ?? deterministic.preferLockfile,
    preferPublishedWorkspacePackages:
      overrides.preferPublishedWorkspacePackages ?? deterministic.preferPublishedWorkspacePackages,
    transformProjectSources:
      overrides.transformProjectSources ?? deterministic.transformProjectSources,
    preflightMode: overrides.preflightMode ?? deterministic.preflightMode,
    serverReadyTimeoutMs: overrides.serverReadyTimeoutMs ?? deterministic.serverReadyTimeoutMs,
    disableViteHmrInjection:
      overrides.disableViteHmrInjection ?? deterministic.disableViteHmrInjection,
    // Non-deterministic options are opt-in at replay time.
    log: overrides.log,
    onProgress: overrides.onProgress,
    onTraceEvent: overrides.onTraceEvent,
    env: overrides.env,
    port: overrides.port,
    bridge: overrides.bridge,
    initServiceWorker: overrides.initServiceWorker,
  };
}

export async function replayRunSpec(
  specOrToken: RunSpec | string,
  options: ReplayRunSpecOptions = {}
): Promise<ReplayRunSpecResult> {
  const spec = typeof specOrToken === 'string' ? decodeRunSpec(specOrToken) : specOrToken;
  const runner = options.runner || bootstrapAndRunGitHubProject;

  const replayOptions = resolveReplayOptions(spec, options);
  const result = await runner(spec.repo.sourceUrl, replayOptions);
  const actualLocks = getRunSpecLockHashes(result.vfs, result.bootstrap.projectPath);

  const lockMismatches: ReplayRunSpecResult['lockMismatches'] = [];
  for (const key of Object.keys(spec.lockHashes) as Array<keyof RunSpec['lockHashes']>) {
    const expected = spec.lockHashes[key];
    if (!expected) continue;
    const actual = actualLocks[key];
    if (expected !== actual) {
      lockMismatches.push({
        file: key,
        expected,
        actual,
      });
    }
  }

  return {
    result,
    reproducible: lockMismatches.length === 0,
    lockMismatches,
  };
}
