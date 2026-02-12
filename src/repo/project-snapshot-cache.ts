import pako from 'pako';
import { VirtualFS } from '../virtual-fs';
import type { VFSFileEntry, VFSSnapshot } from '../runtime-interface';
import { base64ToUint8 } from '../utils/binary-encoding';
import { simpleHash } from '../utils/hash';
import { buildVersionedCacheKey } from '../cache/cache-key';
import {
  readPersistentBinaryCache,
  writePersistentBinaryCache,
  clearPersistentBinaryCacheForTests,
} from '../cache/persistent-binary-cache';
import type { InstallResult } from '../npm';
import type { ResolvedPackage } from '../npm/resolver';
import { parseGitHubRepoUrl } from './github';
import type { ParsedGitHubRepoUrl } from './github';

export type ProjectSnapshotCacheMode = 'default' | 'refresh' | 'bypass';

export interface ProjectSnapshotCacheControl {
  enableProjectSnapshotCache?: boolean;
  projectSnapshotCacheMode?: ProjectSnapshotCacheMode;
  projectSnapshotCacheTtlMs?: number;
  projectSnapshotCacheMaxEntries?: number;
  projectSnapshotCacheMaxBytes?: number;
  projectSnapshotCacheMaxEntryBytes?: number;
}

export interface BootstrapSnapshotCacheableOptions extends ProjectSnapshotCacheControl {
  destPath?: string;
  skipInstall?: boolean;
  includeDev?: boolean;
  includeOptional?: boolean;
  includeWorkspaces?: boolean;
  preferPublishedWorkspacePackages?: boolean;
  transform?: boolean;
  transformProjectSources?: boolean;
}

export interface BootstrapSnapshotCacheableResult {
  repo: ParsedGitHubRepoUrl;
  rootPath: string;
  projectPath: string;
  extractedFiles: string[];
  installResult?: InstallResult;
  transformedProjectFiles?: number;
}

interface SerializedInstallResult {
  added: string[];
  installed: Array<[string, ResolvedPackage]>;
}

interface SerializedBootstrapResult {
  repo: ParsedGitHubRepoUrl;
  rootPath: string;
  projectPath: string;
  extractedFiles: string[];
  installResult?: SerializedInstallResult;
  transformedProjectFiles?: number;
}

interface SerializedProjectSnapshotCacheRecord {
  version: 1;
  storedAt: number;
  result: SerializedBootstrapResult;
  snapshot: VFSSnapshot;
}

interface ProjectSnapshotCacheLimits {
  ttlMs: number;
  maxEntries: number;
  maxBytes: number;
  maxEntryBytes: number;
}

interface MemoryProjectSnapshotCacheEntry {
  record: SerializedProjectSnapshotCacheRecord;
  size: number;
}

export interface ProjectSnapshotCacheReadResult {
  result: BootstrapSnapshotCacheableResult;
  source: 'memory' | 'persistent';
}

const PROJECT_SNAPSHOT_CACHE_NAMESPACE = 'project-snapshots';
const DEFAULT_PROJECT_SNAPSHOT_CACHE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MUTABLE_REF_SNAPSHOT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_PROJECT_SNAPSHOT_CACHE_MAX_ENTRIES = 12;
const DEFAULT_PROJECT_SNAPSHOT_CACHE_MAX_BYTES = 768 * 1024 * 1024;
const DEFAULT_PROJECT_SNAPSHOT_CACHE_MAX_ENTRY_BYTES = 256 * 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const projectSnapshotMemoryCache = new Map<string, MemoryProjectSnapshotCacheEntry>();
let projectSnapshotMemoryCacheTotalBytes = 0;

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

function readEnvNumber(name: string, fallback: number): number {
  const raw = getRuntimeEnvValue(name);
  if (raw == null) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isProjectSnapshotCacheEnabled(options: ProjectSnapshotCacheControl): boolean {
  if (options.enableProjectSnapshotCache != null) {
    return options.enableProjectSnapshotCache;
  }

  const env = getRuntimeEnvValue('ALMOSTBUN_ENABLE_PROJECT_SNAPSHOT_CACHE');
  if (env != null) {
    return env !== '0' && env.toLowerCase() !== 'false';
  }

  return true;
}

function resolveProjectSnapshotCacheMode(
  options: ProjectSnapshotCacheControl
): ProjectSnapshotCacheMode {
  const mode = (options.projectSnapshotCacheMode || getRuntimeEnvValue('ALMOSTBUN_PROJECT_SNAPSHOT_CACHE_MODE') || 'default')
    .toLowerCase()
    .trim();

  if (mode === 'refresh') {
    return 'refresh';
  }
  if (mode === 'bypass') {
    return 'bypass';
  }
  return 'default';
}

function isPinnedCommitRef(ref: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(ref.trim());
}

function parseRepoIdentity(repoUrl: string): {
  sourceUrl: string;
  ref: string;
  subdir: string;
  mutableRef: boolean;
} {
  try {
    const parsed = parseGitHubRepoUrl(repoUrl);
    return {
      sourceUrl: parsed.sourceUrl,
      ref: parsed.ref,
      subdir: parsed.subdir || '',
      mutableRef: !isPinnedCommitRef(parsed.ref),
    };
  } catch {
    return {
      sourceUrl: repoUrl.trim(),
      ref: 'HEAD',
      subdir: '',
      mutableRef: true,
    };
  }
}

function resolveProjectSnapshotCacheLimits(
  repoUrl: string,
  options: ProjectSnapshotCacheControl
): ProjectSnapshotCacheLimits {
  const ttlOverride = options.projectSnapshotCacheTtlMs;
  const ttlEnv = getRuntimeEnvValue('ALMOSTBUN_PROJECT_SNAPSHOT_CACHE_TTL_MS');
  const repoIdentity = parseRepoIdentity(repoUrl);
  const defaultTtlMs = repoIdentity.mutableRef
    ? DEFAULT_MUTABLE_REF_SNAPSHOT_CACHE_TTL_MS
    : DEFAULT_PROJECT_SNAPSHOT_CACHE_TTL_MS;
  const resolvedTtlMs = ttlOverride ??
    (ttlEnv != null ? readEnvNumber('ALMOSTBUN_PROJECT_SNAPSHOT_CACHE_TTL_MS', defaultTtlMs) : defaultTtlMs);

  return {
    ttlMs: Math.max(0, Math.floor(resolvedTtlMs)),
    maxEntries: Math.max(
      0,
      Math.floor(
        options.projectSnapshotCacheMaxEntries ??
          readEnvNumber('ALMOSTBUN_PROJECT_SNAPSHOT_CACHE_MAX_ENTRIES', DEFAULT_PROJECT_SNAPSHOT_CACHE_MAX_ENTRIES)
      )
    ),
    maxBytes: Math.max(
      0,
      Math.floor(
        options.projectSnapshotCacheMaxBytes ??
          readEnvNumber('ALMOSTBUN_PROJECT_SNAPSHOT_CACHE_MAX_BYTES', DEFAULT_PROJECT_SNAPSHOT_CACHE_MAX_BYTES)
      )
    ),
    maxEntryBytes: Math.max(
      0,
      Math.floor(
        options.projectSnapshotCacheMaxEntryBytes ??
          readEnvNumber('ALMOSTBUN_PROJECT_SNAPSHOT_CACHE_MAX_ENTRY_BYTES', DEFAULT_PROJECT_SNAPSHOT_CACHE_MAX_ENTRY_BYTES)
      )
    ),
  };
}

function buildCacheFingerprint(repoUrl: string, options: BootstrapSnapshotCacheableOptions): string {
  const repoIdentity = parseRepoIdentity(repoUrl);
  const destPath = options.destPath || '/project';

  const fingerprint = {
    sourceUrl: repoIdentity.sourceUrl,
    ref: repoIdentity.ref,
    subdir: repoIdentity.subdir,
    destPath,
    skipInstall: options.skipInstall === true,
    includeDev: options.includeDev === true,
    includeOptional: options.includeOptional === true,
    includeWorkspaces: options.includeWorkspaces !== false,
    preferPublishedWorkspacePackages: options.preferPublishedWorkspacePackages === true,
    transform: options.transform !== false,
    transformProjectSources: options.transformProjectSources !== false,
  };

  return JSON.stringify(fingerprint);
}

function buildProjectSnapshotCacheKey(
  repoUrl: string,
  options: BootstrapSnapshotCacheableOptions
): string {
  const fingerprint = buildCacheFingerprint(repoUrl, options);
  const repoHash = simpleHash(repoUrl.trim().toLowerCase());
  const optionsHash = simpleHash(fingerprint);
  return buildVersionedCacheKey({
    namespace: 'project-snapshot',
    scope: 'bootstrap',
    rawKey: `${repoHash}|${optionsHash}`,
  });
}

function isRecordFresh(record: SerializedProjectSnapshotCacheRecord, ttlMs: number): boolean {
  if (ttlMs <= 0) {
    return true;
  }
  const ageMs = Date.now() - record.storedAt;
  return ageMs <= ttlMs;
}

function serializeInstallResult(installResult: InstallResult | undefined): SerializedInstallResult | undefined {
  if (!installResult) {
    return undefined;
  }

  return {
    added: [...installResult.added],
    installed: [...installResult.installed.entries()],
  };
}

function deserializeInstallResult(payload: SerializedInstallResult | undefined): InstallResult | undefined {
  if (!payload) {
    return undefined;
  }

  return {
    added: [...payload.added],
    installed: new Map(payload.installed),
  };
}

function serializeRecord(
  vfs: VirtualFS,
  result: BootstrapSnapshotCacheableResult
): SerializedProjectSnapshotCacheRecord {
  return {
    version: 1,
    storedAt: Date.now(),
    result: {
      repo: result.repo,
      rootPath: result.rootPath,
      projectPath: result.projectPath,
      extractedFiles: [...result.extractedFiles],
      installResult: serializeInstallResult(result.installResult),
      transformedProjectFiles: result.transformedProjectFiles,
    },
    snapshot: vfs.toSnapshot(),
  };
}

function deserializeResult(
  record: SerializedProjectSnapshotCacheRecord
): BootstrapSnapshotCacheableResult {
  return {
    repo: record.result.repo,
    rootPath: record.result.rootPath,
    projectPath: record.result.projectPath,
    extractedFiles: [...record.result.extractedFiles],
    installResult: deserializeInstallResult(record.result.installResult),
    transformedProjectFiles: record.result.transformedProjectFiles,
  };
}

function sortSnapshotEntries(snapshot: VFSSnapshot): VFSFileEntry[] {
  return snapshot.files
    .map((entry, index) => ({ entry, depth: entry.path.split('/').length, index }))
    .sort((a, b) => a.depth - b.depth || a.index - b.index)
    .map((x) => x.entry);
}

function hydrateVfsFromSnapshot(vfs: VirtualFS, snapshot: VFSSnapshot): void {
  const sortedEntries = sortSnapshotEntries(snapshot);

  for (const entry of sortedEntries) {
    if (entry.path === '/') {
      continue;
    }

    if (entry.type === 'directory') {
      try {
        vfs.mkdirSync(entry.path, { recursive: true });
      } catch {
        // ignore
      }
      continue;
    }

    const parentPath = entry.path.slice(0, entry.path.lastIndexOf('/')) || '/';
    if (parentPath !== '/' && !vfs.existsSync(parentPath)) {
      vfs.mkdirSync(parentPath, { recursive: true });
    }

    const payload = entry.content ? base64ToUint8(entry.content) : new Uint8Array(0);
    vfs.writeFileSync(entry.path, payload);
  }
}

function encodeRecord(record: SerializedProjectSnapshotCacheRecord): Uint8Array {
  const json = JSON.stringify(record);
  return pako.gzip(encoder.encode(json));
}

function decodeRecord(payload: ArrayBuffer | Uint8Array): SerializedProjectSnapshotCacheRecord | null {
  try {
    const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    const jsonBytes = pako.ungzip(bytes);
    const parsed = JSON.parse(decoder.decode(jsonBytes)) as SerializedProjectSnapshotCacheRecord;
    if (!parsed || parsed.version !== 1 || !parsed.snapshot || !Array.isArray(parsed.snapshot.files)) {
      return null;
    }
    if (!parsed.result || typeof parsed.result.projectPath !== 'string' || typeof parsed.result.rootPath !== 'string') {
      return null;
    }
    if (
      !parsed.result.repo ||
      typeof parsed.result.repo.owner !== 'string' ||
      typeof parsed.result.repo.repo !== 'string' ||
      typeof parsed.result.repo.ref !== 'string'
    ) {
      return null;
    }
    parsed.result.extractedFiles = Array.isArray(parsed.result.extractedFiles)
      ? parsed.result.extractedFiles.filter((value) => typeof value === 'string')
      : [];
    return parsed;
  } catch {
    return null;
  }
}

function evictMemoryCacheIfNeeded(limits: ProjectSnapshotCacheLimits): void {
  while (
    projectSnapshotMemoryCache.size > limits.maxEntries ||
    projectSnapshotMemoryCacheTotalBytes > limits.maxBytes
  ) {
    const oldestKey = projectSnapshotMemoryCache.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    const oldest = projectSnapshotMemoryCache.get(oldestKey);
    projectSnapshotMemoryCache.delete(oldestKey);
    if (oldest) {
      projectSnapshotMemoryCacheTotalBytes = Math.max(0, projectSnapshotMemoryCacheTotalBytes - oldest.size);
    }
  }
}

function putMemoryCache(
  cacheKey: string,
  record: SerializedProjectSnapshotCacheRecord,
  entrySize: number,
  limits: ProjectSnapshotCacheLimits
): void {
  if (limits.maxEntries <= 0 || limits.maxBytes <= 0) {
    return;
  }

  const existing = projectSnapshotMemoryCache.get(cacheKey);
  if (existing) {
    projectSnapshotMemoryCacheTotalBytes = Math.max(0, projectSnapshotMemoryCacheTotalBytes - existing.size);
    projectSnapshotMemoryCache.delete(cacheKey);
  }

  projectSnapshotMemoryCache.set(cacheKey, {
    record,
    size: entrySize,
  });
  projectSnapshotMemoryCacheTotalBytes += entrySize;

  evictMemoryCacheIfNeeded(limits);
}

function getMemoryCache(
  cacheKey: string,
  ttlMs: number
): SerializedProjectSnapshotCacheRecord | null {
  const entry = projectSnapshotMemoryCache.get(cacheKey);
  if (!entry) {
    return null;
  }

  if (!isRecordFresh(entry.record, ttlMs)) {
    projectSnapshotMemoryCache.delete(cacheKey);
    projectSnapshotMemoryCacheTotalBytes = Math.max(0, projectSnapshotMemoryCacheTotalBytes - entry.size);
    return null;
  }

  projectSnapshotMemoryCache.delete(cacheKey);
  projectSnapshotMemoryCache.set(cacheKey, entry);
  return entry.record;
}

export async function readBootstrapProjectSnapshotCache(
  vfs: VirtualFS,
  repoUrl: string,
  options: BootstrapSnapshotCacheableOptions
): Promise<ProjectSnapshotCacheReadResult | null> {
  if (!isProjectSnapshotCacheEnabled(options)) {
    return null;
  }

  const mode = resolveProjectSnapshotCacheMode(options);
  if (mode === 'bypass' || mode === 'refresh') {
    return null;
  }

  const limits = resolveProjectSnapshotCacheLimits(repoUrl, options);
  if (limits.maxEntries <= 0 || limits.maxBytes <= 0 || limits.maxEntryBytes <= 0) {
    return null;
  }

  const cacheKey = buildProjectSnapshotCacheKey(repoUrl, options);
  const fromMemory = getMemoryCache(cacheKey, limits.ttlMs);
  if (fromMemory) {
    hydrateVfsFromSnapshot(vfs, fromMemory.snapshot);
    return {
      source: 'memory',
      result: deserializeResult(fromMemory),
    };
  }

  const persisted = await readPersistentBinaryCache({
    namespace: PROJECT_SNAPSHOT_CACHE_NAMESPACE,
    key: cacheKey,
    maxEntries: limits.maxEntries,
    maxBytes: limits.maxBytes,
  });

  if (!persisted) {
    return null;
  }

  const decoded = decodeRecord(persisted);
  if (!decoded || !isRecordFresh(decoded, limits.ttlMs)) {
    return null;
  }

  if (persisted.byteLength <= limits.maxEntryBytes) {
    putMemoryCache(cacheKey, decoded, persisted.byteLength, limits);
  }

  hydrateVfsFromSnapshot(vfs, decoded.snapshot);
  return {
    source: 'persistent',
    result: deserializeResult(decoded),
  };
}

export async function writeBootstrapProjectSnapshotCache(
  vfs: VirtualFS,
  repoUrl: string,
  options: BootstrapSnapshotCacheableOptions,
  result: BootstrapSnapshotCacheableResult
): Promise<boolean> {
  if (!isProjectSnapshotCacheEnabled(options)) {
    return false;
  }

  const mode = resolveProjectSnapshotCacheMode(options);
  if (mode === 'bypass') {
    return false;
  }

  const limits = resolveProjectSnapshotCacheLimits(repoUrl, options);
  if (limits.maxEntries <= 0 || limits.maxBytes <= 0 || limits.maxEntryBytes <= 0) {
    return false;
  }

  const cacheKey = buildProjectSnapshotCacheKey(repoUrl, options);
  const record = serializeRecord(vfs, result);
  const encoded = encodeRecord(record);

  if (encoded.byteLength <= 0 || encoded.byteLength > limits.maxEntryBytes || encoded.byteLength > limits.maxBytes) {
    return false;
  }

  putMemoryCache(cacheKey, record, encoded.byteLength, limits);

  await writePersistentBinaryCache(
    {
      namespace: PROJECT_SNAPSHOT_CACHE_NAMESPACE,
      key: cacheKey,
      maxEntries: limits.maxEntries,
      maxBytes: limits.maxBytes,
      contentAddressed: true,
    },
    encoded
  );

  return true;
}

export async function __clearProjectSnapshotCacheForTests(): Promise<void> {
  projectSnapshotMemoryCache.clear();
  projectSnapshotMemoryCacheTotalBytes = 0;
  await clearPersistentBinaryCacheForTests(PROJECT_SNAPSHOT_CACHE_NAMESPACE);
}
