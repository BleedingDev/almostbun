/**
 * Resilient fetch helpers for npm/registry/tarball downloads.
 */

import {
  readPersistentBinaryCache,
  writePersistentBinaryCache,
} from '../cache/persistent-binary-cache';
import { buildVersionedCacheKey } from '../cache/cache-key';

export interface FetchResponseCacheOptions {
  namespace?: string;
  scope?: string;
  key?: string;
  ttlMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  maxEntryBytes?: number;
  mode?: 'default' | 'refresh' | 'bypass';
  allowStaleOnError?: boolean;
  onCacheHit?: (meta: { stale: boolean; source: 'memory' | 'persistent' }) => void;
  onCacheStore?: (meta: { source: 'memory+persistent'; size: number }) => void;
}

export interface FetchWithRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (attempt: number, reason: string) => void;
  cache?: FetchResponseCacheOptions;
}

const DEFAULT_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 2000;

const DEFAULT_HTTP_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_HTTP_CACHE_MAX_ENTRIES = 256;
const DEFAULT_HTTP_CACHE_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_HTTP_CACHE_MAX_ENTRY_BYTES = 8 * 1024 * 1024;

interface FetchCacheLimits {
  ttlMs: number;
  maxEntries: number;
  maxBytes: number;
  maxEntryBytes: number;
}

interface CachedHttpResponsePayload {
  storedAt: number;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyBase64: string;
}

interface CachedHttpResponseEntry {
  payload: Uint8Array;
  size: number;
}

interface CachedResponseResult {
  response: Response;
  stale: boolean;
  source: 'memory' | 'persistent';
}

const httpResponseCache = new Map<string, CachedHttpResponseEntry>();
let httpResponseCacheTotalBytes = 0;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  return (error as { code?: string }).code;
}

function errorName(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  return (error as { name?: string }).name;
}

function errorCauseCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const cause = (error as { cause?: unknown }).cause;
  if (!cause || typeof cause !== 'object') {
    return undefined;
  }
  return (cause as { code?: string }).code;
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

function isBrowserRuntime(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function isHttpResponseCacheEnabled(): boolean {
  const env = getRuntimeEnvValue('ALMOSTBUN_ENABLE_HTTP_RESPONSE_CACHE');
  if (env != null) {
    return env !== '0' && env.toLowerCase() !== 'false';
  }
  return isBrowserRuntime();
}

function getCacheLimits(cache: FetchResponseCacheOptions): FetchCacheLimits {
  return {
    ttlMs: Math.max(0, Math.floor(cache.ttlMs ?? readEnvNumber('ALMOSTBUN_HTTP_CACHE_TTL_MS', DEFAULT_HTTP_CACHE_TTL_MS))),
    maxEntries: Math.max(0, Math.floor(cache.maxEntries ?? readEnvNumber('ALMOSTBUN_HTTP_CACHE_MAX_ENTRIES', DEFAULT_HTTP_CACHE_MAX_ENTRIES))),
    maxBytes: Math.max(0, Math.floor(cache.maxBytes ?? readEnvNumber('ALMOSTBUN_HTTP_CACHE_MAX_BYTES', DEFAULT_HTTP_CACHE_MAX_BYTES))),
    maxEntryBytes: Math.max(
      0,
      Math.floor(cache.maxEntryBytes ?? readEnvNumber('ALMOSTBUN_HTTP_CACHE_MAX_ENTRY_BYTES', DEFAULT_HTTP_CACHE_MAX_ENTRY_BYTES))
    ),
  };
}

function isRetryableNetworkError(error: unknown): boolean {
  if (!error) return false;

  const code = errorCode(error);
  const causeCode = errorCauseCode(error);
  const name = errorName(error);
  if (
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_SOCKET' ||
    code === 'UND_ERR_ABORTED' ||
    code === 'ECONNRESET' ||
    code === 'ECONNABORTED' ||
    code === 'ENOTFOUND' ||
    code === 'ETIMEDOUT' ||
    causeCode === 'UND_ERR_CONNECT_TIMEOUT' ||
    causeCode === 'UND_ERR_SOCKET' ||
    causeCode === 'UND_ERR_ABORTED' ||
    causeCode === 'ECONNRESET' ||
    causeCode === 'ECONNABORTED' ||
    causeCode === 'ENOTFOUND' ||
    causeCode === 'ETIMEDOUT'
  ) {
    return true;
  }

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

function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  if (baseDelayMs <= 0 && maxDelayMs <= 0) {
    return 0;
  }
  const exponential = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
  const jitterWindow = Math.max(1, Math.floor(baseDelayMs / 2));
  const jitter = Math.floor(Math.random() * jitterWindow);
  return exponential + jitter;
}

function resolveMethod(input: RequestInfo | URL, init?: RequestInit): string {
  const methodFromInit = init?.method;
  if (methodFromInit) {
    return methodFromInit.toUpperCase();
  }

  if (typeof Request !== 'undefined' && input instanceof Request) {
    return input.method.toUpperCase();
  }

  return 'GET';
}

function resolveRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  if (typeof Request !== 'undefined' && input instanceof Request) {
    return input.url;
  }

  return String(input);
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }

  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function computeCacheNamespace(cache: FetchResponseCacheOptions): string {
  const namespace = cache.namespace || 'http';
  return `http-responses:${namespace}`;
}

function computeCacheKey(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  cache: FetchResponseCacheOptions
): string {
  if (cache.key) {
    return buildVersionedCacheKey({
      namespace: cache.namespace || 'http',
      scope: cache.scope || 'global',
      rawKey: cache.key,
    });
  }

  const method = resolveMethod(input, init);
  const url = resolveRequestUrl(input);
  const accept = (init?.headers && new Headers(init.headers).get('accept')) || '';

  return buildVersionedCacheKey({
    namespace: cache.namespace || 'http',
    scope: cache.scope || 'global',
    rawKey: `${method}|${url}|${accept}`,
  });
}

function evictHttpResponseCacheIfNeeded(limits: FetchCacheLimits): void {
  while (
    httpResponseCache.size > limits.maxEntries ||
    httpResponseCacheTotalBytes > limits.maxBytes
  ) {
    const oldestKey = httpResponseCache.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }

    const oldest = httpResponseCache.get(oldestKey);
    httpResponseCache.delete(oldestKey);
    if (oldest) {
      httpResponseCacheTotalBytes = Math.max(0, httpResponseCacheTotalBytes - oldest.size);
    }
  }
}

function cacheHttpResponseInMemory(
  cacheKey: string,
  payload: Uint8Array,
  limits: FetchCacheLimits
): void {
  if (limits.maxEntries <= 0 || limits.maxBytes <= 0 || payload.byteLength <= 0) {
    return;
  }

  const existing = httpResponseCache.get(cacheKey);
  if (existing) {
    httpResponseCacheTotalBytes = Math.max(0, httpResponseCacheTotalBytes - existing.size);
    httpResponseCache.delete(cacheKey);
  }

  const copied = new Uint8Array(payload.byteLength);
  copied.set(payload);
  httpResponseCache.set(cacheKey, {
    payload: copied,
    size: copied.byteLength,
  });
  httpResponseCacheTotalBytes += copied.byteLength;
  evictHttpResponseCacheIfNeeded(limits);
}

function deserializeCachedResponse(
  payloadBytes: Uint8Array,
  ttlMs: number,
  allowExpired: boolean
): { response: Response; stale: boolean } | null {
  try {
    const payload = JSON.parse(decoder.decode(payloadBytes)) as CachedHttpResponsePayload;
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    const storedAt = Number(payload.storedAt);
    if (!Number.isFinite(storedAt) || storedAt <= 0) {
      return null;
    }

    const ageMs = Date.now() - storedAt;
    const stale = ttlMs > 0 && ageMs > ttlMs;
    if (stale && !allowExpired) {
      return null;
    }

    const status = Number(payload.status);
    if (!Number.isFinite(status) || status < 100 || status > 599) {
      return null;
    }

    const bodyBytes = payload.bodyBase64 ? base64ToBytes(payload.bodyBase64) : new Uint8Array(0);
    const responseBody = bodyBytes.byteLength > 0 ? toArrayBuffer(bodyBytes) : null;
    const response = new Response(responseBody, {
      status,
      statusText: payload.statusText || '',
      headers: payload.headers || {},
    });

    return { response, stale };
  } catch {
    return null;
  }
}

async function readCachedHttpResponse(
  cacheKey: string,
  cache: FetchResponseCacheOptions,
  limits: FetchCacheLimits,
  allowExpired: boolean
): Promise<CachedResponseResult | null> {
  const inMemory = httpResponseCache.get(cacheKey);
  if (inMemory) {
    httpResponseCache.delete(cacheKey);
    httpResponseCache.set(cacheKey, inMemory);

    const parsed = deserializeCachedResponse(inMemory.payload, limits.ttlMs, allowExpired);
    if (parsed) {
      return {
        response: parsed.response,
        stale: parsed.stale,
        source: 'memory',
      };
    }
  }

  const persisted = await readPersistentBinaryCache({
    namespace: computeCacheNamespace(cache),
    key: cacheKey,
    maxEntries: limits.maxEntries,
    maxBytes: limits.maxBytes,
  });
  if (!persisted) {
    return null;
  }

  const persistedBytes = new Uint8Array(persisted);
  cacheHttpResponseInMemory(cacheKey, persistedBytes, limits);

  const parsed = deserializeCachedResponse(persistedBytes, limits.ttlMs, allowExpired);
  if (!parsed) {
    return null;
  }

  return {
    response: parsed.response,
    stale: parsed.stale,
    source: 'persistent',
  };
}

function isCacheableResponse(response: Response): boolean {
  if (!response.ok) {
    return false;
  }

  const cacheControl = response.headers.get('cache-control') || '';
  if (/no-store/i.test(cacheControl)) {
    return false;
  }

  return true;
}

async function cacheHttpResponse(
  cacheKey: string,
  response: Response,
  cache: FetchResponseCacheOptions,
  limits: FetchCacheLimits
): Promise<void> {
  if (
    limits.maxEntries <= 0 ||
    limits.maxBytes <= 0 ||
    limits.maxEntryBytes <= 0 ||
    !isCacheableResponse(response)
  ) {
    return;
  }

  const cloned = response.clone();
  const body = new Uint8Array(await cloned.arrayBuffer());
  if (body.byteLength > limits.maxEntryBytes) {
    return;
  }

  const serializedHeaders: Record<string, string> = {};
  cloned.headers.forEach((value, key) => {
    serializedHeaders[key] = value;
  });

  const serializedPayload: CachedHttpResponsePayload = {
    storedAt: Date.now(),
    status: cloned.status,
    statusText: cloned.statusText,
    headers: serializedHeaders,
    bodyBase64: bytesToBase64(body),
  };

  const payloadBytes = encoder.encode(JSON.stringify(serializedPayload));
  if (payloadBytes.byteLength > limits.maxEntryBytes || payloadBytes.byteLength > limits.maxBytes) {
    return;
  }

  cacheHttpResponseInMemory(cacheKey, payloadBytes, limits);

  await writePersistentBinaryCache(
    {
      namespace: computeCacheNamespace(cache),
      key: cacheKey,
      maxEntries: limits.maxEntries,
      maxBytes: limits.maxBytes,
      contentAddressed: true,
    },
    payloadBytes
  );

  cache.onCacheStore?.({ source: 'memory+persistent', size: payloadBytes.byteLength });
}

function shouldUseResponseCache(method: string, cache: FetchResponseCacheOptions): boolean {
  if (!isHttpResponseCacheEnabled()) {
    return false;
  }

  if (cache.mode === 'bypass') {
    return false;
  }

  if (method !== 'GET') {
    return false;
  }

  return true;
}

/**
 * Fetch with retry for transient transport and gateway issues.
 */
export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: FetchWithRetryOptions = {}
): Promise<Response> {
  const attempts = Math.max(1, options.attempts || DEFAULT_ATTEMPTS);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);

  const method = resolveMethod(input, init);
  const cacheOptions = options.cache;
  const hasCacheConfig = Boolean(cacheOptions);
  const canUseCache = hasCacheConfig && shouldUseResponseCache(method, cacheOptions!);
  const cacheLimits = hasCacheConfig
    ? getCacheLimits(cacheOptions!)
    : {
      ttlMs: 0,
      maxEntries: 0,
      maxBytes: 0,
      maxEntryBytes: 0,
    };
  const cacheKey = canUseCache ? computeCacheKey(input, init, cacheOptions!) : '';

  if (canUseCache && cacheOptions?.mode !== 'refresh') {
    const cached = await readCachedHttpResponse(cacheKey, cacheOptions!, cacheLimits, false);
    if (cached) {
      cacheOptions?.onCacheHit?.({ stale: cached.stale, source: cached.source });
      return cached.response;
    }
  }

  let staleFallback: CachedResponseResult | null = null;
  const allowStaleOnError = cacheOptions?.allowStaleOnError ?? true;
  if (canUseCache && allowStaleOnError) {
    staleFallback = await readCachedHttpResponse(cacheKey, cacheOptions!, cacheLimits, true);
    if (staleFallback && !staleFallback.stale) {
      staleFallback = null;
    }
  }

  let lastError: unknown;
  let lastResponse: Response | undefined;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(input, init);
      if (!response.ok && isRetryableStatus(response.status) && attempt < attempts) {
        lastResponse = response;
        options.onRetry?.(attempt, `HTTP ${response.status}`);
        await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs));
        continue;
      }

      if (canUseCache) {
        await cacheHttpResponse(cacheKey, response, cacheOptions!, cacheLimits);
      }

      return response;
    } catch (error) {
      lastError = error;
      // Respect caller-initiated cancellations and abort-like failures immediately.
      if (init?.signal?.aborted || errorName(error) === 'AbortError') {
        break;
      }
      if (!isRetryableNetworkError(error) || attempt >= attempts) {
        break;
      }
      options.onRetry?.(attempt, String((error as { message?: unknown }).message || error));
      await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs));
    }
  }

  if (staleFallback) {
    cacheOptions?.onCacheHit?.({ stale: true, source: staleFallback.source });
    return staleFallback.response;
  }

  if (lastResponse) {
    return lastResponse;
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Fetch failed after ${attempts} attempts`);
}

export function __clearFetchResponseCacheForTests(): void {
  httpResponseCache.clear();
  httpResponseCacheTotalBytes = 0;
}
