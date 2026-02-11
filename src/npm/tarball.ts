/**
 * Tarball Extractor
 * Downloads and extracts npm package tarballs into the virtual file system
 */

import pako from 'pako';
import { VirtualFS } from '../virtual-fs';
import * as path from '../shims/path';
import { fetchWithRetry } from './fetch';
import {
  readPersistentBinaryCache,
  writePersistentBinaryCache,
} from '../cache/persistent-binary-cache';
import { buildVersionedCacheKey } from '../cache/cache-key';

export interface ExtractOptions {
  stripComponents?: number; // Number of leading path components to strip (default: 1 for npm's "package/" prefix)
  filter?: (path: string) => boolean;
  onProgress?: (message: string) => void;
  cacheKey?: string;
  disableDownloadCache?: boolean;
}

interface TarEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink' | 'unknown';
  size: number;
  mode: number;
  content?: Uint8Array;
  linkTarget?: string;
}

type TarballCacheLimits = {
  maxEntries: number;
  maxBytes: number;
};

interface TarballCacheEntry {
  tarball: Uint8Array;
  size: number;
}

const DEFAULT_TARBALL_CACHE_MAX_ENTRIES = 96;
const DEFAULT_TARBALL_CACHE_MAX_BYTES = 512 * 1024 * 1024;
const TARBALL_PERSISTENT_CACHE_NAMESPACE = 'npm-tarballs';
const tarballCache = new Map<string, TarballCacheEntry>();
let tarballCacheTotalBytes = 0;

function isBrowserRuntime(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
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

function isTarballCacheEnabled(): boolean {
  const envFlag = getRuntimeEnvValue('ALMOSTBUN_ENABLE_TARBALL_CACHE');
  if (envFlag != null) {
    return envFlag !== '0' && envFlag.toLowerCase() !== 'false';
  }
  return isBrowserRuntime();
}

function isPersistentTarballCacheEnabled(): boolean {
  const envFlag = getRuntimeEnvValue('ALMOSTBUN_ENABLE_PERSISTENT_TARBALL_CACHE');
  if (envFlag != null) {
    return envFlag !== '0' && envFlag.toLowerCase() !== 'false';
  }
  return isBrowserRuntime();
}

function getTarballCacheLimits(): TarballCacheLimits {
  if (!isTarballCacheEnabled()) {
    return {
      maxEntries: 0,
      maxBytes: 0,
    };
  }

  return {
    maxEntries: Math.max(
      0,
      Math.floor(readEnvNumber('ALMOSTBUN_TARBALL_CACHE_MAX_ENTRIES', DEFAULT_TARBALL_CACHE_MAX_ENTRIES))
    ),
    maxBytes: Math.max(
      0,
      Math.floor(readEnvNumber('ALMOSTBUN_TARBALL_CACHE_MAX_BYTES', DEFAULT_TARBALL_CACHE_MAX_BYTES))
    ),
  };
}

function cloneBuffer(source: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy.buffer;
}

function evictTarballCacheIfNeeded(limits: TarballCacheLimits): void {
  while (tarballCache.size > limits.maxEntries || tarballCacheTotalBytes > limits.maxBytes) {
    const oldestKey = tarballCache.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    const oldest = tarballCache.get(oldestKey);
    tarballCache.delete(oldestKey);
    if (oldest) {
      tarballCacheTotalBytes = Math.max(0, tarballCacheTotalBytes - oldest.size);
    }
  }
}

function cacheTarballInMemory(
  cacheKey: string,
  tarball: ArrayBuffer | Uint8Array,
  limits: TarballCacheLimits
): void {
  if (limits.maxEntries <= 0 || limits.maxBytes <= 0) {
    return;
  }

  const bytes = tarball instanceof Uint8Array ? tarball : new Uint8Array(tarball);
  const size = bytes.byteLength;
  if (size <= 0 || size > limits.maxBytes) {
    return;
  }

  const existing = tarballCache.get(cacheKey);
  if (existing) {
    tarballCacheTotalBytes = Math.max(0, tarballCacheTotalBytes - existing.size);
    tarballCache.delete(cacheKey);
  }

  const copied = new Uint8Array(size);
  copied.set(bytes);
  tarballCache.set(cacheKey, { tarball: copied, size });
  tarballCacheTotalBytes += size;
  evictTarballCacheIfNeeded(limits);
}

async function getCachedTarball(cacheKey: string, limits: TarballCacheLimits): Promise<ArrayBuffer | null> {
  if (limits.maxEntries <= 0 || limits.maxBytes <= 0) {
    return null;
  }

  const inMemory = tarballCache.get(cacheKey);
  if (inMemory) {
    tarballCache.delete(cacheKey);
    tarballCache.set(cacheKey, inMemory);
    return cloneBuffer(inMemory.tarball);
  }

  if (!isPersistentTarballCacheEnabled()) {
    return null;
  }

  const persisted = await readPersistentBinaryCache({
    namespace: TARBALL_PERSISTENT_CACHE_NAMESPACE,
    key: cacheKey,
    maxEntries: limits.maxEntries,
    maxBytes: limits.maxBytes,
  });
  if (!persisted) {
    return null;
  }

  cacheTarballInMemory(cacheKey, persisted, limits);
  return cloneBuffer(new Uint8Array(persisted));
}

async function cacheTarball(
  cacheKey: string,
  tarball: ArrayBuffer,
  limits: TarballCacheLimits
): Promise<void> {
  if (limits.maxEntries <= 0 || limits.maxBytes <= 0) {
    return;
  }

  const bytes = new Uint8Array(tarball);
  if (bytes.byteLength <= 0 || bytes.byteLength > limits.maxBytes) {
    return;
  }

  cacheTarballInMemory(cacheKey, bytes, limits);
  if (!isPersistentTarballCacheEnabled()) {
    return;
  }

  await writePersistentBinaryCache(
    {
      namespace: TARBALL_PERSISTENT_CACHE_NAMESPACE,
      key: cacheKey,
      maxEntries: limits.maxEntries,
      maxBytes: limits.maxBytes,
    },
    bytes
  );
}

export function __clearTarballDownloadCacheForTests(): void {
  tarballCache.clear();
  tarballCacheTotalBytes = 0;
}

/**
 * Parse a tar archive from raw bytes
 */
function* parseTar(data: Uint8Array): Generator<TarEntry> {
  const decoder = new TextDecoder();
  let offset = 0;

  while (offset < data.length - 512) {
    // Read 512-byte header
    const header = data.slice(offset, offset + 512);
    offset += 512;

    // Check for end of archive (two zero blocks)
    if (header.every((b) => b === 0)) {
      break;
    }

    // Parse header fields
    const name = parseString(header, 0, 100);
    const mode = parseOctal(header, 100, 8);
    const size = parseOctal(header, 124, 12);
    const typeFlag = String.fromCharCode(header[156]);
    const linkName = parseString(header, 157, 100);
    const prefix = parseString(header, 345, 155);

    // Skip empty entries
    if (!name) {
      continue;
    }

    // Combine prefix and name for long paths
    const fullName = prefix ? `${prefix}/${name}` : name;

    // Determine entry type
    let type: TarEntry['type'];
    switch (typeFlag) {
      case '0':
      case '\0':
      case '':
        type = 'file';
        break;
      case '5':
        type = 'directory';
        break;
      case '1':
      case '2':
        type = 'symlink';
        break;
      default:
        type = 'unknown';
    }

    // Read file content
    let content: Uint8Array | undefined;
    if (type === 'file' && size > 0) {
      content = data.slice(offset, offset + size);
      // Move past content, rounded up to 512-byte boundary
      offset += Math.ceil(size / 512) * 512;
    }

    yield {
      name: fullName,
      type,
      size,
      mode,
      content,
      linkTarget: type === 'symlink' ? linkName : undefined,
    };
  }
}

/**
 * Parse a null-terminated string from tar header
 */
function parseString(data: Uint8Array, offset: number, length: number): string {
  const bytes = data.slice(offset, offset + length);
  const nullIndex = bytes.indexOf(0);
  const actualBytes = nullIndex >= 0 ? bytes.slice(0, nullIndex) : bytes;
  return new TextDecoder().decode(actualBytes);
}

/**
 * Parse an octal number from tar header
 */
function parseOctal(data: Uint8Array, offset: number, length: number): number {
  const str = parseString(data, offset, length).trim();
  return parseInt(str, 8) || 0;
}

/**
 * Decompress gzipped data
 */
export function decompress(data: ArrayBuffer | Uint8Array): Uint8Array {
  const input = data instanceof Uint8Array ? data : new Uint8Array(data);
  return pako.inflate(input);
}

/**
 * Extract a tarball to the virtual file system
 */
export function extractTarball(
  tarballData: ArrayBuffer | Uint8Array,
  vfs: VirtualFS,
  destPath: string,
  options: ExtractOptions = {}
): string[] {
  const { stripComponents = 1, filter, onProgress } = options;

  // Decompress gzip
  onProgress?.('Decompressing...');
  const tarData = decompress(tarballData);

  // Parse and extract tar entries
  const extractedFiles: string[] = [];

  for (const entry of parseTar(tarData)) {
    // Skip non-file/directory entries for now
    if (entry.type !== 'file' && entry.type !== 'directory') {
      continue;
    }

    // Strip leading path components (npm packages have "package/" prefix)
    let entryPath = entry.name;
    if (stripComponents > 0) {
      const parts = entryPath.split('/').filter(Boolean);
      if (parts.length <= stripComponents) {
        continue;
      }
      entryPath = parts.slice(stripComponents).join('/');
    }

    // Apply filter if provided
    if (filter && !filter(entryPath)) {
      continue;
    }

    // Build destination path
    const fullPath = path.join(destPath, entryPath);

    if (entry.type === 'directory') {
      vfs.mkdirSync(fullPath, { recursive: true });
    } else if (entry.type === 'file' && entry.content) {
      // Ensure parent directory exists
      const parentDir = path.dirname(fullPath);
      vfs.mkdirSync(parentDir, { recursive: true });

      // Write file
      vfs.writeFileSync(fullPath, entry.content);
      extractedFiles.push(fullPath);
    }
  }

  onProgress?.(`Extracted ${extractedFiles.length} files`);

  return extractedFiles;
}

/**
 * Download and extract a tarball from URL
 */
export async function downloadAndExtract(
  url: string,
  vfs: VirtualFS,
  destPath: string,
  options: ExtractOptions = {}
): Promise<string[]> {
  const { onProgress, cacheKey = url, disableDownloadCache = false } = options;
  const versionedCacheKey = buildVersionedCacheKey({
    namespace: 'npm-tarballs',
    scope: 'download',
    rawKey: cacheKey,
  });
  const cacheLimits = disableDownloadCache
    ? { maxEntries: 0, maxBytes: 0 }
    : getTarballCacheLimits();

  let data = await getCachedTarball(versionedCacheKey, cacheLimits);
  if (data) {
    onProgress?.(`Using cached tarball for ${url}`);
  } else {
    onProgress?.(`Downloading ${url}...`);

    const response = await fetchWithRetry(
      url,
      undefined,
      {
        onRetry: (attempt, reason) => {
          onProgress?.(`Retrying download (${attempt}) for ${url}: ${reason}`);
        },
      }
    );
    if (!response.ok) {
      throw new Error(`Failed to download tarball: ${response.status}`);
    }

    data = await response.arrayBuffer();
    await cacheTarball(versionedCacheKey, data, cacheLimits);
  }

  return extractTarball(data, vfs, destPath, options);
}

export default {
  decompress,
  extractTarball,
  downloadAndExtract,
};
