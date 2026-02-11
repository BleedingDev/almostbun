/**
 * Persistent binary cache for browser runtimes.
 *
 * Primary backend: OPFS (navigator.storage.getDirectory()).
 * Fallback backend: localStorage (base64 payloads).
 *
 * All cache operations are best-effort and must never break runtime flows.
 */

import { simpleHash } from '../utils/hash';

interface PersistentCacheEntry {
  key: string;
  id: string;
  size: number;
  accessedAt: number;
}

interface PersistentCacheIndex {
  version: 1;
  entries: PersistentCacheEntry[];
}

export interface PersistentBinaryCacheOptions {
  namespace: string;
  key: string;
  maxEntries: number;
  maxBytes: number;
}

const OPFS_ROOT_DIR = 'almostbun-cache-v1';
const OPFS_INDEX_FILE = 'index.json';
const LOCAL_INDEX_PREFIX = '__almostbun_cache_index_v1__';
const LOCAL_ENTRY_PREFIX = '__almostbun_cache_entry_v1__';
const namespaceWriteLocks = new Map<string, Promise<void>>();

type FileHandleLike = {
  getFile: () => Promise<{ arrayBuffer: () => Promise<ArrayBuffer>; text: () => Promise<string> }>;
  createWritable: () => Promise<{
    write: (data: string | BufferSource) => Promise<void>;
    close: () => Promise<void>;
    truncate?: (size: number) => Promise<void>;
  }>;
};

type DirectoryHandleLike = {
  getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<DirectoryHandleLike>;
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<FileHandleLike>;
  removeEntry: (name: string, options?: { recursive?: boolean }) => Promise<void>;
};

type StorageLike = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  key: (index: number) => string | null;
  length: number;
};

function isBrowserRuntime(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function safeKeyFragment(input: string): string {
  const safe = input
    .replace(/[^a-z0-9._-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  const hash = simpleHash(input).replace(/[^a-z0-9_-]+/gi, '_');
  return safe ? `${safe}-${hash}` : hash;
}

function namespaceId(namespace: string): string {
  return safeKeyFragment(namespace);
}

function entryIdForKey(key: string): string {
  return safeKeyFragment(`${key}|${key.length}`);
}

function dataFileName(id: string): string {
  return `${id}.bin`;
}

function cloneArrayBuffer(input: ArrayBuffer | Uint8Array): ArrayBuffer {
  const source = input instanceof Uint8Array ? input : new Uint8Array(input);
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy.buffer;
}

async function withNamespaceWriteLock<T>(
  namespace: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = namespaceWriteLocks.get(namespace) ?? Promise.resolve();
  let releaseCurrent: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const queueTail = previous.then(() => current);
  namespaceWriteLocks.set(namespace, queueTail);

  await previous;
  try {
    return await operation();
  } finally {
    releaseCurrent?.();
    if (namespaceWriteLocks.get(namespace) === queueTail) {
      namespaceWriteLocks.delete(namespace);
    }
  }
}

function defaultIndex(): PersistentCacheIndex {
  return { version: 1, entries: [] };
}

function parseIndex(raw: string | null): PersistentCacheIndex {
  if (!raw) {
    return defaultIndex();
  }

  try {
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      entries?: unknown;
    };

    if (!Array.isArray(parsed.entries)) {
      return defaultIndex();
    }

    const deduped = new Map<string, PersistentCacheEntry>();
    for (const candidate of parsed.entries) {
      if (!candidate || typeof candidate !== 'object') {
        continue;
      }

      const maybe = candidate as {
        key?: unknown;
        id?: unknown;
        size?: unknown;
        accessedAt?: unknown;
      };

      if (typeof maybe.key !== 'string' || typeof maybe.id !== 'string') {
        continue;
      }

      const size = Number(maybe.size);
      const accessedAt = Number(maybe.accessedAt);
      if (!Number.isFinite(size) || size <= 0) {
        continue;
      }

      deduped.set(maybe.key, {
        key: maybe.key,
        id: maybe.id,
        size,
        accessedAt: Number.isFinite(accessedAt) ? accessedAt : 0,
      });
    }

    return {
      version: 1,
      entries: [...deduped.values()],
    };
  } catch {
    return defaultIndex();
  }
}

function enforceLimits(
  entries: PersistentCacheEntry[],
  maxEntries: number,
  maxBytes: number
): { kept: PersistentCacheEntry[]; evicted: PersistentCacheEntry[] } {
  if (maxEntries <= 0 || maxBytes <= 0) {
    return {
      kept: [],
      evicted: [...entries],
    };
  }

  const sorted = [...entries].sort((a, b) => a.accessedAt - b.accessedAt);
  let totalBytes = sorted.reduce((acc, entry) => acc + entry.size, 0);
  const evicted: PersistentCacheEntry[] = [];

  while (sorted.length > maxEntries || totalBytes > maxBytes) {
    const oldest = sorted.shift();
    if (!oldest) {
      break;
    }
    evicted.push(oldest);
    totalBytes = Math.max(0, totalBytes - oldest.size);
  }

  return {
    kept: sorted,
    evicted,
  };
}

function getLocalStorageLike(): StorageLike | null {
  try {
    const candidate = (globalThis as typeof globalThis & {
      localStorage?: Partial<StorageLike>;
    }).localStorage;
    if (!candidate) return null;
    if (
      typeof candidate.getItem !== 'function' ||
      typeof candidate.setItem !== 'function' ||
      typeof candidate.removeItem !== 'function' ||
      typeof candidate.key !== 'function' ||
      typeof candidate.length !== 'number'
    ) {
      return null;
    }
    return candidate as StorageLike;
  } catch {
    return null;
  }
}

function localIndexKey(namespace: string): string {
  return `${LOCAL_INDEX_PREFIX}${namespaceId(namespace)}`;
}

function localEntryKey(namespace: string, id: string): string {
  return `${LOCAL_ENTRY_PREFIX}${namespaceId(namespace)}__${id}`;
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

function readLocalIndex(storage: StorageLike, namespace: string): PersistentCacheIndex {
  return parseIndex(storage.getItem(localIndexKey(namespace)));
}

function writeLocalIndex(storage: StorageLike, namespace: string, index: PersistentCacheIndex): void {
  storage.setItem(localIndexKey(namespace), JSON.stringify(index));
}

function removeLocalEntry(storage: StorageLike, namespace: string, entry: PersistentCacheEntry): void {
  try {
    storage.removeItem(localEntryKey(namespace, entry.id));
  } catch {
    // Ignore storage removal failures.
  }
}

function readFromLocalStorage(options: PersistentBinaryCacheOptions): ArrayBuffer | null {
  const storage = getLocalStorageLike();
  if (!storage) {
    return null;
  }

  const index = readLocalIndex(storage, options.namespace);
  const entry = index.entries.find((candidate) => candidate.key === options.key);
  if (!entry) {
    return null;
  }

  const encoded = storage.getItem(localEntryKey(options.namespace, entry.id));
  if (!encoded) {
    index.entries = index.entries.filter((candidate) => candidate.key !== options.key);
    try {
      writeLocalIndex(storage, options.namespace, index);
    } catch {
      // Ignore index repair failures.
    }
    return null;
  }

  try {
    const bytes = base64ToBytes(encoded);
    entry.accessedAt = Date.now();
    writeLocalIndex(storage, options.namespace, index);
    return cloneArrayBuffer(bytes);
  } catch {
    removeLocalEntry(storage, options.namespace, entry);
    index.entries = index.entries.filter((candidate) => candidate.key !== options.key);
    try {
      writeLocalIndex(storage, options.namespace, index);
    } catch {
      // Ignore index repair failures.
    }
    return null;
  }
}

function storeLocalPayload(
  storage: StorageLike,
  storageKey: string,
  payload: string,
  namespace: string,
  index: PersistentCacheIndex
): boolean {
  try {
    storage.setItem(storageKey, payload);
    return true;
  } catch {
    const evictionOrder = [...index.entries].sort((a, b) => a.accessedAt - b.accessedAt);
    for (const evicted of evictionOrder) {
      removeLocalEntry(storage, namespace, evicted);
      index.entries = index.entries.filter((entry) => entry.key !== evicted.key);
      try {
        storage.setItem(storageKey, payload);
        return true;
      } catch {
        // Continue evicting.
      }
    }
  }

  return false;
}

function writeToLocalStorage(options: PersistentBinaryCacheOptions, bytes: Uint8Array): boolean {
  const storage = getLocalStorageLike();
  if (!storage) {
    return false;
  }

  const id = entryIdForKey(options.key);
  const payload = bytesToBase64(bytes);
  const index = readLocalIndex(storage, options.namespace);
  if (!storeLocalPayload(storage, localEntryKey(options.namespace, id), payload, options.namespace, index)) {
    return false;
  }

  index.entries = index.entries.filter((entry) => entry.key !== options.key);
  index.entries.push({
    key: options.key,
    id,
    size: bytes.byteLength,
    accessedAt: Date.now(),
  });

  const { kept, evicted } = enforceLimits(index.entries, options.maxEntries, options.maxBytes);
  index.entries = kept;
  for (const evictedEntry of evicted) {
    removeLocalEntry(storage, options.namespace, evictedEntry);
  }

  try {
    writeLocalIndex(storage, options.namespace, index);
    return true;
  } catch {
    return false;
  }
}

async function getNavigatorStorageRoot(): Promise<DirectoryHandleLike | null> {
  const navigatorLike = (globalThis as typeof globalThis & {
    navigator?: {
      storage?: {
        getDirectory?: () => Promise<DirectoryHandleLike>;
      };
    };
  }).navigator;

  const getDirectory = navigatorLike?.storage?.getDirectory;
  if (typeof getDirectory !== 'function') {
    return null;
  }

  try {
    return await getDirectory.call(navigatorLike.storage);
  } catch {
    return null;
  }
}

async function getOpfsNamespaceDirectory(
  namespace: string,
  create: boolean
): Promise<DirectoryHandleLike | null> {
  const root = await getNavigatorStorageRoot();
  if (!root) {
    return null;
  }

  try {
    const cacheRoot = await root.getDirectoryHandle(OPFS_ROOT_DIR, { create });
    return await cacheRoot.getDirectoryHandle(namespaceId(namespace), { create });
  } catch {
    return null;
  }
}

async function readOpfsIndex(directory: DirectoryHandleLike): Promise<PersistentCacheIndex> {
  try {
    const handle = await directory.getFileHandle(OPFS_INDEX_FILE);
    const file = await handle.getFile();
    const raw = await file.text();
    return parseIndex(raw);
  } catch {
    return defaultIndex();
  }
}

async function writeOpfsIndex(directory: DirectoryHandleLike, index: PersistentCacheIndex): Promise<void> {
  const handle = await directory.getFileHandle(OPFS_INDEX_FILE, { create: true });
  const writable = await handle.createWritable();
  if (typeof writable.truncate === 'function') {
    await writable.truncate(0);
  }
  await writable.write(JSON.stringify(index));
  await writable.close();
}

async function removeOpfsEntry(directory: DirectoryHandleLike, entry: PersistentCacheEntry): Promise<void> {
  try {
    await directory.removeEntry(dataFileName(entry.id));
  } catch {
    // Ignore missing files and unsupported remove operations.
  }
}

async function readFromOpfs(options: PersistentBinaryCacheOptions): Promise<ArrayBuffer | null> {
  const directory = await getOpfsNamespaceDirectory(options.namespace, false);
  if (!directory) {
    return null;
  }

  const index = await readOpfsIndex(directory);
  const entry = index.entries.find((candidate) => candidate.key === options.key);
  if (!entry) {
    return null;
  }

  try {
    const handle = await directory.getFileHandle(dataFileName(entry.id));
    const file = await handle.getFile();
    const data = await file.arrayBuffer();
    entry.accessedAt = Date.now();
    await writeOpfsIndex(directory, index);
    return data;
  } catch {
    index.entries = index.entries.filter((candidate) => candidate.key !== options.key);
    try {
      await writeOpfsIndex(directory, index);
    } catch {
      // Ignore index repair failures.
    }
    return null;
  }
}

async function writeToOpfs(options: PersistentBinaryCacheOptions, bytes: Uint8Array): Promise<boolean> {
  const directory = await getOpfsNamespaceDirectory(options.namespace, true);
  if (!directory) {
    return false;
  }

  const index = await readOpfsIndex(directory);
  const id = entryIdForKey(options.key);

  try {
    const handle = await directory.getFileHandle(dataFileName(id), { create: true });
    const writable = await handle.createWritable();
    if (typeof writable.truncate === 'function') {
      await writable.truncate(0);
    }
    await writable.write(bytes);
    await writable.close();
  } catch {
    return false;
  }

  const previous = index.entries.find((entry) => entry.key === options.key);
  index.entries = index.entries.filter((entry) => entry.key !== options.key);
  index.entries.push({
    key: options.key,
    id,
    size: bytes.byteLength,
    accessedAt: Date.now(),
  });

  if (previous && previous.id !== id) {
    await removeOpfsEntry(directory, previous);
  }

  const { kept, evicted } = enforceLimits(index.entries, options.maxEntries, options.maxBytes);
  index.entries = kept;

  for (const evictedEntry of evicted) {
    await removeOpfsEntry(directory, evictedEntry);
  }

  try {
    await writeOpfsIndex(directory, index);
    return true;
  } catch {
    return false;
  }
}

export async function readPersistentBinaryCache(
  options: PersistentBinaryCacheOptions
): Promise<ArrayBuffer | null> {
  if (!isBrowserRuntime()) {
    return null;
  }

  if (options.maxEntries <= 0 || options.maxBytes <= 0) {
    return null;
  }

  const opfsResult = await readFromOpfs(options);
  if (opfsResult) {
    return cloneArrayBuffer(opfsResult);
  }

  const localResult = readFromLocalStorage(options);
  if (localResult) {
    return cloneArrayBuffer(localResult);
  }

  return null;
}

export async function writePersistentBinaryCache(
  options: PersistentBinaryCacheOptions,
  payload: ArrayBuffer | Uint8Array
): Promise<void> {
  if (!isBrowserRuntime()) {
    return;
  }

  if (options.maxEntries <= 0 || options.maxBytes <= 0) {
    return;
  }

  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (bytes.byteLength <= 0 || bytes.byteLength > options.maxBytes) {
    return;
  }

  await withNamespaceWriteLock(options.namespace, async () => {
    const opfsStored = await writeToOpfs(options, bytes);
    if (opfsStored) {
      return;
    }

    writeToLocalStorage(options, bytes);
  });
}

function clearLocalStorageCache(namespace?: string): void {
  const storage = getLocalStorageLike();
  if (!storage) {
    return;
  }

  const namespaceToken = namespace ? namespaceId(namespace) : null;
  const toDelete: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key) {
      continue;
    }

    const isCacheKey = key.startsWith(LOCAL_INDEX_PREFIX) || key.startsWith(LOCAL_ENTRY_PREFIX);
    if (!isCacheKey) {
      continue;
    }

    if (!namespaceToken || key.includes(namespaceToken)) {
      toDelete.push(key);
    }
  }

  for (const key of toDelete) {
    try {
      storage.removeItem(key);
    } catch {
      // Ignore cleanup failures.
    }
  }
}

export async function clearPersistentBinaryCacheForTests(namespace?: string): Promise<void> {
  if (namespace) {
    namespaceWriteLocks.delete(namespace);
  } else {
    namespaceWriteLocks.clear();
  }

  clearLocalStorageCache(namespace);

  const root = await getNavigatorStorageRoot();
  if (!root) {
    return;
  }

  try {
    if (!namespace) {
      await root.removeEntry(OPFS_ROOT_DIR, { recursive: true });
      return;
    }

    const cacheRoot = await root.getDirectoryHandle(OPFS_ROOT_DIR);
    await cacheRoot.removeEntry(namespaceId(namespace), { recursive: true });
  } catch {
    // Ignore OPFS cleanup failures.
  }
}
