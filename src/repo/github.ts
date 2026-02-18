/**
 * GitHub repository import helpers.
 *
 * These helpers download repository archives and extract them into VirtualFS,
 * enabling "paste URL -> run in browser" workflows without a local git binary.
 */

import * as path from '../shims/path';
import { VirtualFS } from '../virtual-fs';
import { extractTarball } from '../npm/tarball';
import { fetchWithRetry, type FetchResponseCacheOptions } from '../npm/fetch';
import {
  readPersistentBinaryCache,
  writePersistentBinaryCache,
} from '../cache/persistent-binary-cache';
import { buildVersionedCacheKey } from '../cache/cache-key';

interface ArchiveCacheEntry {
  archive: Uint8Array;
  size: number;
}

export type GitHubArchiveSource = 'memory' | 'persistent' | 'network' | 'api-fallback';

type ArchiveCacheLimits = {
  maxEntries: number;
  maxBytes: number;
};

const DEFAULT_ARCHIVE_CACHE_MAX_ENTRIES = 8;
const DEFAULT_ARCHIVE_CACHE_MAX_BYTES = 256 * 1024 * 1024;
const ARCHIVE_PERSISTENT_CACHE_NAMESPACE = 'github-archives';
const DEFAULT_GITHUB_FETCH_ATTEMPTS = 3;
const DEFAULT_GITHUB_FETCH_BASE_DELAY_MS = 500;
const DEFAULT_GITHUB_FETCH_MAX_DELAY_MS = 2000;
const DEFAULT_GITHUB_FETCH_TIMEOUT_MS = 10_000;
const archiveCache = new Map<string, ArchiveCacheEntry>();
let archiveCacheTotalBytes = 0;

export interface ParsedGitHubRepoUrl {
  owner: string;
  repo: string;
  ref: string;
  subdir?: string;
  sourceUrl: string;
  archiveUrl: string;
}

export interface ImportGitHubRepoOptions {
  /**
   * Destination directory in VFS.
   * Default: /project
   */
  destPath?: string;
  onProgress?: (message: string) => void;
}

export interface ImportGitHubRepoResult {
  repo: ParsedGitHubRepoUrl;
  rootPath: string;
  projectPath: string;
  extractedFiles: string[];
  archiveCacheSource?: GitHubArchiveSource;
  archiveBytes?: number;
}

function normalizePathLike(value: string): string {
  return value.replace(/\\/g, '/');
}

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
  if (raw == null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isArchiveCacheEnabled(): boolean {
  const envFlag = getRuntimeEnvValue('ALMOSTBUN_ENABLE_ARCHIVE_CACHE');
  if (envFlag != null) {
    return envFlag !== '0' && envFlag.toLowerCase() !== 'false';
  }
  return isBrowserRuntime();
}

function getArchiveCacheLimits(): ArchiveCacheLimits {
  if (!isArchiveCacheEnabled()) {
    return {
      maxEntries: 0,
      maxBytes: 0,
    };
  }

  return {
    maxEntries: Math.max(0, Math.floor(readEnvNumber('ALMOSTBUN_ARCHIVE_CACHE_MAX_ENTRIES', DEFAULT_ARCHIVE_CACHE_MAX_ENTRIES))),
    maxBytes: Math.max(0, Math.floor(readEnvNumber('ALMOSTBUN_ARCHIVE_CACHE_MAX_BYTES', DEFAULT_ARCHIVE_CACHE_MAX_BYTES))),
  };
}

function cloneArchiveBuffer(source: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(source.length);
  copy.set(source);
  return copy.buffer;
}

function isPersistentArchiveCacheEnabled(): boolean {
  const envFlag = getRuntimeEnvValue('ALMOSTBUN_ENABLE_PERSISTENT_ARCHIVE_CACHE');
  if (envFlag != null) {
    return envFlag !== '0' && envFlag.toLowerCase() !== 'false';
  }
  return isBrowserRuntime();
}

function cacheArchiveInMemory(
  cacheKey: string,
  archive: ArrayBuffer | Uint8Array,
  limits: ArchiveCacheLimits
): void {
  if (limits.maxEntries <= 0 || limits.maxBytes <= 0) {
    return;
  }

  const bytes = archive instanceof Uint8Array ? archive : new Uint8Array(archive);
  const size = bytes.byteLength;
  if (size === 0 || size > limits.maxBytes) {
    return;
  }

  const existing = archiveCache.get(cacheKey);
  if (existing) {
    archiveCacheTotalBytes = Math.max(0, archiveCacheTotalBytes - existing.size);
    archiveCache.delete(cacheKey);
  }

  const cached = new Uint8Array(size);
  cached.set(bytes);
  archiveCache.set(cacheKey, { archive: cached, size });
  archiveCacheTotalBytes += size;
  evictArchiveCacheIfNeeded(limits);
}

async function getCachedArchive(
  cacheKey: string
): Promise<{ archive: ArrayBuffer; source: Extract<GitHubArchiveSource, 'memory' | 'persistent'> } | null> {
  const entry = archiveCache.get(cacheKey);
  if (entry) {
    // LRU-ish behavior: move recently used key to the tail.
    archiveCache.delete(cacheKey);
    archiveCache.set(cacheKey, entry);
    return {
      archive: cloneArchiveBuffer(entry.archive),
      source: 'memory',
    };
  }

  const limits = getArchiveCacheLimits();
  if (
    limits.maxEntries <= 0 ||
    limits.maxBytes <= 0 ||
    !isPersistentArchiveCacheEnabled()
  ) {
    return null;
  }

  const persisted = await readPersistentBinaryCache({
    namespace: ARCHIVE_PERSISTENT_CACHE_NAMESPACE,
    key: cacheKey,
    maxEntries: limits.maxEntries,
    maxBytes: limits.maxBytes,
  });
  if (!persisted) {
    return null;
  }

  cacheArchiveInMemory(cacheKey, persisted, limits);
  return {
    archive: cloneArchiveBuffer(new Uint8Array(persisted)),
    source: 'persistent',
  };
}

function evictArchiveCacheIfNeeded(limits: ArchiveCacheLimits): void {
  while (
    archiveCache.size > limits.maxEntries ||
    archiveCacheTotalBytes > limits.maxBytes
  ) {
    const oldestKey = archiveCache.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    const oldestEntry = archiveCache.get(oldestKey);
    archiveCache.delete(oldestKey);
    if (oldestEntry) {
      archiveCacheTotalBytes = Math.max(0, archiveCacheTotalBytes - oldestEntry.size);
    }
  }
}

async function cacheArchive(cacheKey: string, archive: ArrayBuffer): Promise<void> {
  const limits = getArchiveCacheLimits();
  if (limits.maxEntries <= 0 || limits.maxBytes <= 0) {
    return;
  }

  const bytes = new Uint8Array(archive);
  if (bytes.byteLength === 0 || bytes.byteLength > limits.maxBytes) {
    return;
  }

  cacheArchiveInMemory(cacheKey, bytes, limits);

  if (!isPersistentArchiveCacheEnabled()) {
    return;
  }

  await writePersistentBinaryCache(
    {
      namespace: ARCHIVE_PERSISTENT_CACHE_NAMESPACE,
      key: cacheKey,
      maxEntries: limits.maxEntries,
      maxBytes: limits.maxBytes,
      contentAddressed: true,
    },
    bytes
  );
}

export function __clearGitHubArchiveCacheForTests(): void {
  archiveCache.clear();
  archiveCacheTotalBytes = 0;
}

function parseGitHubShorthand(input: string): ParsedGitHubRepoUrl | null {
  if (!input.startsWith('github:')) {
    return null;
  }

  const rest = input.slice('github:'.length).trim();
  if (!rest) {
    throw new Error(`Invalid GitHub shorthand: ${input}`);
  }

  const [repoPartRaw, hashRaw] = rest.split('#', 2);
  const repoPart = repoPartRaw.trim();
  const hash = hashRaw?.trim();
  const segments = repoPart.split('/').filter(Boolean);
  if (segments.length < 2) {
    throw new Error(`Invalid GitHub shorthand: ${input}`);
  }

  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, '');
  const ref = hash || 'HEAD';

  return {
    owner,
    repo,
    ref,
    sourceUrl: `https://github.com/${owner}/${repo}`,
    archiveUrl: `https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeURIComponent(ref)}`,
  };
}

function isBrowserRuntime(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function getBrowserCorsProxyCandidates(): string[] {
  if (!isBrowserRuntime()) {
    return [];
  }

  const candidates: string[] = [];
  try {
    if (typeof location !== 'undefined' && location.origin) {
      candidates.push(`${location.origin}/__proxy__?url=`);
    }
  } catch {
    // Ignore location access errors
  }

  try {
    const localOverride = localStorage.getItem('__corsProxyUrl');
    if (localOverride) {
      candidates.push(localOverride);
    }
  } catch {
    // Ignore storage access errors
  }

  // Default public proxies for "no-backend" browser workflows.
  candidates.push('https://cors.isomorphic-git.org/');
  candidates.push('https://corsproxy.io/?');

  return [...new Set(candidates)];
}

function buildProxyUrl(proxyBase: string, targetUrl: string): string {
  if (proxyBase.includes('{url}')) {
    return proxyBase.replace('{url}', encodeURIComponent(targetUrl));
  }
  return `${proxyBase}${encodeURIComponent(targetUrl)}`;
}

function formatRetryReason(reason: string): string {
  const normalized = reason.trim();
  if (!normalized) {
    return 'transient network issue';
  }
  return normalized.replace(/failed to fetch/gi, 'network request blocked');
}

type GitHubFetchRetrySettings = {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  requestTimeoutMs: number;
};

type FetchGitHubResourceOptions = {
  cache?: FetchResponseCacheOptions;
  onRetry?: (attempt: number, reason: string) => void;
  settings: GitHubFetchRetrySettings;
};

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isRetryableNetworkError(error: unknown): boolean {
  if (!error) return false;
  const message = String((error as { message?: unknown }).message || error).toLowerCase();
  return (
    message.includes('networkerror') ||
    message.includes('timed out') ||
    message.includes('connect timeout') ||
    message.includes('connection terminated') ||
    message.includes('terminated') ||
    message.includes('aborted') ||
    message.includes('socket hang up') ||
    message.includes('connection closed') ||
    message.includes('fetch failed') ||
    message.includes('failed to fetch')
  );
}

function computeBackoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  if (baseDelayMs <= 0 && maxDelayMs <= 0) {
    return 0;
  }
  const exponential = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
  const jitterWindow = Math.max(1, Math.floor(baseDelayMs / 2));
  const jitter = Math.floor(Math.random() * jitterWindow);
  return exponential + jitter;
}

function getGitHubFetchRetrySettings(): GitHubFetchRetrySettings {
  const attempts = Math.max(1, Math.floor(readEnvNumber('ALMOSTBUN_GITHUB_FETCH_ATTEMPTS', DEFAULT_GITHUB_FETCH_ATTEMPTS)));
  const baseDelayMs = Math.max(0, Math.floor(readEnvNumber('ALMOSTBUN_GITHUB_FETCH_BASE_DELAY_MS', DEFAULT_GITHUB_FETCH_BASE_DELAY_MS)));
  const maxDelayMs = Math.max(baseDelayMs, Math.floor(readEnvNumber('ALMOSTBUN_GITHUB_FETCH_MAX_DELAY_MS', DEFAULT_GITHUB_FETCH_MAX_DELAY_MS)));
  const requestTimeoutMs = Math.max(0, Math.floor(readEnvNumber('ALMOSTBUN_GITHUB_FETCH_TIMEOUT_MS', DEFAULT_GITHUB_FETCH_TIMEOUT_MS)));
  return {
    attempts,
    baseDelayMs,
    maxDelayMs,
    requestTimeoutMs,
  };
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function fetchGitHubResource(
  url: string,
  options: FetchGitHubResourceOptions
): Promise<Response> {
  const { settings } = options;
  let lastError: unknown;
  let lastResponse: Response | undefined;

  for (let attempt = 1; attempt <= settings.attempts; attempt += 1) {
    const hasAbortController = typeof AbortController !== 'undefined';
    const controller = hasAbortController ? new AbortController() : undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    if (controller && settings.requestTimeoutMs > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, settings.requestTimeoutMs);
    }

    try {
      const response = await fetchWithRetry(
        url,
        controller ? { signal: controller.signal } : undefined,
        {
          attempts: 1,
          cache: options.cache,
        }
      );

      if (!response.ok && isRetryableHttpStatus(response.status) && attempt < settings.attempts) {
        lastResponse = response;
        options.onRetry?.(attempt, `HTTP ${response.status}`);
        await sleep(computeBackoffDelay(attempt, settings.baseDelayMs, settings.maxDelayMs));
        continue;
      }

      return response;
    } catch (error) {
      lastError = error;
      const retryable = timedOut || isRetryableNetworkError(error);
      if (!retryable || attempt >= settings.attempts) {
        break;
      }
      const reason = timedOut
        ? `request timed out after ${settings.requestTimeoutMs}ms`
        : String((error as { message?: unknown }).message || error);
      options.onRetry?.(attempt, reason);
      await sleep(computeBackoffDelay(attempt, settings.baseDelayMs, settings.maxDelayMs));
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  if (lastResponse) {
    return lastResponse;
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to fetch ${url}`);
}

interface GitHubTreeResponse {
  tree?: Array<{
    path?: string;
    type?: string;
  }>;
  truncated?: boolean;
}

interface GitHubContentsResponse {
  content?: string;
  encoding?: string;
  download_url?: string;
}

function decodeBase64ToBytes(content: string): Uint8Array {
  const normalized = content.replace(/\s+/g, '');
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function fetchRawFileWithFallback(
  rawUrl: string,
  relativePath: string,
  options: ImportGitHubRepoOptions,
  retrySettings: GitHubFetchRetrySettings
): Promise<Response> {
  let response: Response | null = null;
  let directError: unknown;

  try {
    response = await fetchGitHubResource(rawUrl, {
      settings: retrySettings,
      onRetry: (attempt, reason) => {
        options.onProgress?.(
          `Retrying raw file download (${relativePath}) [${attempt}] due to ${formatRetryReason(reason)}`
        );
      },
      cache: {
        namespace: 'github-raw',
        scope: 'raw.githubusercontent.com',
        key: rawUrl,
        ttlMs: 15 * 60 * 1000,
      },
    });
    if (response.ok) {
      return response;
    }
  } catch (error) {
    directError = error;
  }

  if (isBrowserRuntime()) {
    const proxyCandidates = getBrowserCorsProxyCandidates();
    for (const proxyBase of proxyCandidates) {
      const proxiedUrl = buildProxyUrl(proxyBase, rawUrl);
      options.onProgress?.(`Retrying file via CORS proxy (${relativePath}): ${proxyBase}`);
      try {
        const proxiedResponse = await fetchGitHubResource(proxiedUrl, {
          settings: retrySettings,
          cache: {
            namespace: 'github-raw-proxy',
            scope: proxyBase,
            key: rawUrl,
            ttlMs: 15 * 60 * 1000,
          },
        });
        if (proxiedResponse.ok) {
          return proxiedResponse;
        }
        response = proxiedResponse;
      } catch (error) {
        directError ??= error;
      }
    }
  }

  if (response) {
    return response;
  }

  throw directError instanceof Error
    ? directError
    : new Error(`Failed to fetch ${rawUrl}`);
}

async function fetchFileViaContentsApi(
  repo: ParsedGitHubRepoUrl,
  encodedPath: string,
  relativePath: string,
  options: ImportGitHubRepoOptions,
  retrySettings: GitHubFetchRetrySettings
): Promise<Uint8Array | null> {
  const contentsUrl =
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${encodedPath}?ref=${encodeURIComponent(repo.ref)}`;

  let contentsResponse: Response;
  try {
    contentsResponse = await fetchGitHubResource(contentsUrl, {
      settings: retrySettings,
      cache: {
        namespace: 'github-contents',
        scope: `${repo.owner}/${repo.repo}`,
        key: `${repo.ref}:${relativePath}`,
        ttlMs: 15 * 60 * 1000,
      },
    });
  } catch {
    return null;
  }

  if (!contentsResponse.ok) {
    return null;
  }

  let payload: GitHubContentsResponse;
  try {
    payload = await contentsResponse.json() as GitHubContentsResponse;
  } catch {
    return null;
  }

  if (payload.encoding === 'base64' && typeof payload.content === 'string') {
    return decodeBase64ToBytes(payload.content);
  }

  if (payload.download_url) {
    try {
      const fallbackRawResponse = await fetchRawFileWithFallback(
        payload.download_url,
        relativePath,
        options,
        retrySettings
      );
      if (fallbackRawResponse.ok) {
        return new Uint8Array(await fallbackRawResponse.arrayBuffer());
      }
    } catch {
      // ignore and return null below
    }
  }

  return null;
}

async function importGitHubRepoViaApi(
  vfs: VirtualFS,
  repo: ParsedGitHubRepoUrl,
  destPath: string,
  options: ImportGitHubRepoOptions,
  retrySettings: GitHubFetchRetrySettings
): Promise<string[]> {
  const treeUrl =
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/git/trees/${encodeURIComponent(repo.ref)}?recursive=1`;
  options.onProgress?.('Archive download unavailable, using GitHub API fallback...');
  const treeResponse = await fetchGitHubResource(treeUrl, {
    settings: retrySettings,
    cache: {
      namespace: 'github-tree',
      scope: `${repo.owner}/${repo.repo}`,
      key: repo.ref,
      ttlMs: 10 * 60 * 1000,
    },
  });
  if (!treeResponse.ok) {
    throw new Error(`GitHub API tree fetch failed: ${treeResponse.status}`);
  }

  const treeJson = await treeResponse.json() as GitHubTreeResponse;
  const allBlobs = (treeJson.tree || []).filter(
    (entry): entry is { path: string; type: string } =>
      Boolean(entry.path && entry.type === 'blob')
  );

  const subdirPrefix = repo.subdir
    ? normalizePathLike(repo.subdir).replace(/^\/+|\/+$/g, '')
    : null;

  const selectedBlobs = subdirPrefix
    ? allBlobs.filter((entry) => entry.path === subdirPrefix || entry.path.startsWith(`${subdirPrefix}/`))
    : allBlobs;

  if (selectedBlobs.length === 0) {
    throw new Error(`GitHub API fallback found no files for ${repo.owner}/${repo.repo}@${repo.ref}`);
  }

  if (treeJson.truncated) {
    options.onProgress?.('Warning: GitHub tree response is truncated; large repository may be incomplete.');
  }

  const extractedFiles: string[] = [];
  const encodedRef = repo.ref
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
  for (let i = 0; i < selectedBlobs.length; i++) {
    const entry = selectedBlobs[i];
    const relativePath = normalizePathLike(entry.path).replace(/^\/+/, '');
    if (!relativePath || relativePath.includes('..')) {
      continue;
    }

    const encodedPath = relativePath
      .split('/')
      .map(segment => encodeURIComponent(segment))
      .join('/');
    const rawUrl = `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${encodedRef}/${encodedPath}`;

    const filePath = path.join(destPath, relativePath);
    const dirPath = path.dirname(filePath);
    vfs.mkdirSync(dirPath, { recursive: true });

    let rawBytes: Uint8Array | null = null;
    let rawFailure: unknown;
    let rawStatus: number | null = null;

    try {
      const rawResponse = await fetchRawFileWithFallback(rawUrl, relativePath, options, retrySettings);
      rawStatus = rawResponse.status;
      if (rawResponse.ok) {
        rawBytes = new Uint8Array(await rawResponse.arrayBuffer());
      }
    } catch (error) {
      rawFailure = error;
    }

    if (!rawBytes) {
      const apiBytes = await fetchFileViaContentsApi(repo, encodedPath, relativePath, options, retrySettings);
      if (apiBytes) {
        rawBytes = apiBytes;
      }
    }

    if (!rawBytes) {
      const detail = rawFailure instanceof Error
        ? rawFailure.message
        : (rawStatus ? `HTTP ${rawStatus}` : 'unknown fetch error');
      throw new Error(`GitHub raw file fetch failed (${relativePath}): ${detail}`);
    }

    vfs.writeFileSync(filePath, rawBytes);
    extractedFiles.push(filePath);

    if (i % 25 === 0 || i === selectedBlobs.length - 1) {
      options.onProgress?.(`Imported ${i + 1}/${selectedBlobs.length} files from GitHub API`);
    }
  }

  return extractedFiles;
}

/**
 * Parse a GitHub URL into owner/repo/ref/subdir data.
 *
 * Supported examples:
 * - https://github.com/owner/repo
 * - https://github.com/owner/repo.git
 * - https://github.com/owner/repo/tree/main
 * - https://github.com/owner/repo/tree/main/examples/demo
 * - git+https://github.com/owner/repo.git#main
 * - github:owner/repo#main
 */
export function parseGitHubRepoUrl(input: string): ParsedGitHubRepoUrl {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('GitHub URL is empty');
  }

  const shorthand = parseGitHubShorthand(trimmed);
  if (shorthand) {
    return shorthand;
  }

  const normalizedInput = trimmed.startsWith('git+')
    ? trimmed.slice('git+'.length)
    : trimmed;

  let url: URL;
  try {
    url = new URL(normalizedInput);
  } catch {
    throw new Error(`Invalid GitHub URL: ${input}`);
  }

  const host = url.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') {
    throw new Error(`Unsupported host: ${url.hostname}. Only github.com is supported`);
  }

  const pathSegments = normalizePathLike(url.pathname)
    .split('/')
    .filter(Boolean);
  if (pathSegments.length < 2) {
    throw new Error(`Invalid GitHub repository URL: ${input}`);
  }

  const owner = pathSegments[0];
  const repo = pathSegments[1].replace(/\.git$/i, '');

  let ref = url.hash ? decodeURIComponent(url.hash.slice(1)) : 'HEAD';
  let subdir: string | undefined;

  if (pathSegments[2] === 'tree' && pathSegments[3]) {
    ref = decodeURIComponent(pathSegments[3]);
    if (pathSegments.length > 4) {
      subdir = pathSegments.slice(4).map(decodeURIComponent).join('/');
    }
  }

  return {
    owner,
    repo,
    ref,
    subdir,
    sourceUrl: `https://github.com/${owner}/${repo}`,
    archiveUrl: `https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeURIComponent(ref)}`,
  };
}

/**
 * Import a GitHub repository archive into VirtualFS.
 *
 * Uses GitHub's codeload tarball endpoint and extracts into `destPath`.
 * The top-level archive folder is stripped, so files land directly under destPath.
 */
export async function importGitHubRepo(
  vfs: VirtualFS,
  repoUrl: string,
  options: ImportGitHubRepoOptions = {}
): Promise<ImportGitHubRepoResult> {
  const retrySettings = getGitHubFetchRetrySettings();
  const repo = parseGitHubRepoUrl(repoUrl);
  const destPath = options.destPath || '/project';
  const projectPath = repo.subdir ? path.join(destPath, repo.subdir) : destPath;
  const archiveCacheKey = buildVersionedCacheKey({
    namespace: 'github-archives',
    scope: `${repo.owner}/${repo.repo}`,
    rawKey: repo.archiveUrl,
  });

  const fetchArchive = async (archiveUrl: string): Promise<Response> => {
    return fetchGitHubResource(archiveUrl, {
      settings: retrySettings,
      onRetry: (attempt, reason) => {
        options.onProgress?.(
          `Retrying GitHub archive download (${attempt}) due to ${formatRetryReason(reason)}`
        );
      },
    });
  };

  options.onProgress?.(`Downloading ${repo.owner}/${repo.repo}@${repo.ref}...`);

  let response: Response | null = null;
  let directError: unknown;
  const cachedArchive = await getCachedArchive(archiveCacheKey);
  let archiveBuffer = cachedArchive?.archive;
  let archiveSource: GitHubArchiveSource | undefined = cachedArchive?.source;

  if (archiveBuffer) {
    options.onProgress?.(`Using cached archive for ${repo.owner}/${repo.repo}@${repo.ref}`);
  } else {
    try {
      response = await fetchArchive(repo.archiveUrl);
    } catch (error) {
      directError = error;
    }
  }

  if (!archiveBuffer && (!response || !response.ok) && isBrowserRuntime()) {
    const proxyCandidates = getBrowserCorsProxyCandidates();
    for (const proxyBase of proxyCandidates) {
      const proxiedUrl = buildProxyUrl(proxyBase, repo.archiveUrl);
      options.onProgress?.(`Retrying via CORS proxy: ${proxyBase}`);
      try {
        response = await fetchArchive(proxiedUrl);
      } catch {
        continue;
      }
      if (response.ok) {
        break;
      }
    }
  }

  let extractedFiles: string[] = [];

  if (!archiveBuffer && response?.ok) {
    archiveBuffer = await response.arrayBuffer();
    archiveSource = 'network';
    await cacheArchive(archiveCacheKey, archiveBuffer);
  }

  if (archiveBuffer) {
    options.onProgress?.('Extracting archive...');
    extractedFiles = extractTarball(archiveBuffer, vfs, destPath, {
      stripComponents: 1,
      onProgress: options.onProgress,
    });
  } else {
    const archiveFailureDetail = response
      ? `HTTP ${response.status}`
      : (directError instanceof Error ? directError.message : 'unknown');

    try {
      archiveSource = 'api-fallback';
      extractedFiles = await importGitHubRepoViaApi(vfs, repo, destPath, options, retrySettings);
    } catch (apiError) {
      throw new Error(
        `Failed to download GitHub archive (${archiveFailureDetail}); GitHub API fallback failed: ${String((apiError as Error)?.message || apiError)}`
      );
    }
  }

  if (repo.subdir && !vfs.existsSync(projectPath)) {
    throw new Error(
      `Subdirectory "${repo.subdir}" not found in ${repo.owner}/${repo.repo}@${repo.ref}`
    );
  }

  options.onProgress?.(`Imported ${extractedFiles.length} files to ${destPath}`);

  return {
    repo,
    rootPath: destPath,
    projectPath,
    extractedFiles,
    archiveCacheSource: archiveSource,
    archiveBytes: archiveBuffer?.byteLength,
  };
}
