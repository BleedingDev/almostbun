import { describe, expect, it } from 'vitest';
import {
  clearPersistentBinaryCacheForTests,
  readPersistentBinaryCache,
  writePersistentBinaryCache,
} from '../src/cache/persistent-binary-cache';

describe('persistent binary cache', () => {
  it('stores and reads payload via localStorage fallback when OPFS is unavailable', async () => {
    const restore = installBrowserEnvironment({
      localStorage: createStorageMock(),
      navigatorStorage: undefined,
    });

    try {
      await writePersistentBinaryCache(
        {
          namespace: 'local-fallback',
          key: 'archive-a',
          maxEntries: 8,
          maxBytes: 1024 * 1024,
        },
        encodeText('hello-cache')
      );

      const result = await readPersistentBinaryCache({
        namespace: 'local-fallback',
        key: 'archive-a',
        maxEntries: 8,
        maxBytes: 1024 * 1024,
      });

      expect(result).not.toBeNull();
      expect(decodeText(result!)).toBe('hello-cache');
    } finally {
      await clearPersistentBinaryCacheForTests();
      restore();
    }
  });

  it('overwrites OPFS payload cleanly when a new payload is shorter', async () => {
    const opfsRoot = new FakeOpfsDirectory({ writeDelayMs: 0 });
    const restore = installBrowserEnvironment({
      localStorage: createStorageMock(),
      navigatorStorage: {
        getDirectory: async () => opfsRoot,
      },
    });

    try {
      await writePersistentBinaryCache(
        {
          namespace: 'opfs-overwrite',
          key: 'archive-a',
          maxEntries: 8,
          maxBytes: 1024 * 1024,
        },
        encodeText('0123456789')
      );

      await writePersistentBinaryCache(
        {
          namespace: 'opfs-overwrite',
          key: 'archive-a',
          maxEntries: 8,
          maxBytes: 1024 * 1024,
        },
        encodeText('abc')
      );

      const result = await readPersistentBinaryCache({
        namespace: 'opfs-overwrite',
        key: 'archive-a',
        maxEntries: 8,
        maxBytes: 1024 * 1024,
      });

      expect(result).not.toBeNull();
      expect(decodeText(result!)).toBe('abc');
    } finally {
      await clearPersistentBinaryCacheForTests();
      restore();
    }
  });

  it('preserves both entries when writing concurrently in the same namespace', async () => {
    const opfsRoot = new FakeOpfsDirectory({ writeDelayMs: 15 });
    const restore = installBrowserEnvironment({
      localStorage: createStorageMock(),
      navigatorStorage: {
        getDirectory: async () => opfsRoot,
      },
    });

    const options = {
      namespace: 'opfs-concurrent',
      maxEntries: 16,
      maxBytes: 1024 * 1024,
    };

    try {
      await Promise.all([
        writePersistentBinaryCache({ ...options, key: 'a' }, encodeText('payload-a')),
        writePersistentBinaryCache({ ...options, key: 'b' }, encodeText('payload-b')),
      ]);

      const [a, b] = await Promise.all([
        readPersistentBinaryCache({ ...options, key: 'a' }),
        readPersistentBinaryCache({ ...options, key: 'b' }),
      ]);

      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(decodeText(a!)).toBe('payload-a');
      expect(decodeText(b!)).toBe('payload-b');
    } finally {
      await clearPersistentBinaryCacheForTests();
      restore();
    }
  });

  it('enforces global cache quota across namespaces', async () => {
    const restore = installBrowserEnvironment({
      localStorage: createStorageMock(),
      navigatorStorage: undefined,
    });

    const originalGlobalEntries = process.env.ALMOSTBUN_GLOBAL_CACHE_MAX_ENTRIES;
    const originalGlobalBytes = process.env.ALMOSTBUN_GLOBAL_CACHE_MAX_BYTES;
    process.env.ALMOSTBUN_GLOBAL_CACHE_MAX_ENTRIES = '1';
    process.env.ALMOSTBUN_GLOBAL_CACHE_MAX_BYTES = String(1024 * 1024);

    try {
      await writePersistentBinaryCache(
        {
          namespace: 'global-a',
          key: 'entry-a',
          maxEntries: 8,
          maxBytes: 1024 * 1024,
        },
        encodeText('payload-a')
      );

      await writePersistentBinaryCache(
        {
          namespace: 'global-b',
          key: 'entry-b',
          maxEntries: 8,
          maxBytes: 1024 * 1024,
        },
        encodeText('payload-b')
      );

      const first = await readPersistentBinaryCache({
        namespace: 'global-a',
        key: 'entry-a',
        maxEntries: 8,
        maxBytes: 1024 * 1024,
      });
      const second = await readPersistentBinaryCache({
        namespace: 'global-b',
        key: 'entry-b',
        maxEntries: 8,
        maxBytes: 1024 * 1024,
      });

      expect(first).toBeNull();
      expect(second).not.toBeNull();
      expect(decodeText(second!)).toBe('payload-b');
    } finally {
      if (originalGlobalEntries === undefined) {
        delete process.env.ALMOSTBUN_GLOBAL_CACHE_MAX_ENTRIES;
      } else {
        process.env.ALMOSTBUN_GLOBAL_CACHE_MAX_ENTRIES = originalGlobalEntries;
      }
      if (originalGlobalBytes === undefined) {
        delete process.env.ALMOSTBUN_GLOBAL_CACHE_MAX_BYTES;
      } else {
        process.env.ALMOSTBUN_GLOBAL_CACHE_MAX_BYTES = originalGlobalBytes;
      }
      await clearPersistentBinaryCacheForTests();
      restore();
    }
  });
});

function encodeText(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

function decodeText(input: ArrayBuffer): string {
  return new TextDecoder().decode(new Uint8Array(input));
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

function installBrowserEnvironment(params: {
  localStorage: unknown;
  navigatorStorage: { getDirectory: () => Promise<unknown> } | undefined;
}): () => void {
  const previousWindow = (globalThis as any).window;
  const previousDocument = (globalThis as any).document;
  const previousLocalStorage = (globalThis as any).localStorage;
  const previousNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const previousNavigator = (globalThis as any).navigator;

  (globalThis as any).window = {};
  (globalThis as any).document = {};
  (globalThis as any).localStorage = params.localStorage;

  const nextNavigator = {
    ...(previousNavigator || {}),
    ...(params.navigatorStorage
      ? { storage: params.navigatorStorage }
      : { storage: undefined }),
  };

  Object.defineProperty(globalThis, 'navigator', {
    value: nextNavigator,
    configurable: true,
    writable: true,
    enumerable: previousNavigatorDescriptor?.enumerable ?? true,
  });

  return () => {
    if (previousWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = previousWindow;

    if (previousDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = previousDocument;

    if (previousLocalStorage === undefined) delete (globalThis as any).localStorage;
    else (globalThis as any).localStorage = previousLocalStorage;

    if (previousNavigatorDescriptor) {
      Object.defineProperty(globalThis, 'navigator', previousNavigatorDescriptor);
    } else {
      delete (globalThis as any).navigator;
    }
  };
}

class FakeOpfsDirectory {
  private readonly directories = new Map<string, FakeOpfsDirectory>();
  private readonly files = new Map<string, FakeOpfsFile>();

  constructor(private readonly options: { writeDelayMs: number }) {}

  async getDirectoryHandle(
    name: string,
    handleOptions?: { create?: boolean }
  ): Promise<FakeOpfsDirectory> {
    const existing = this.directories.get(name);
    if (existing) {
      return existing;
    }

    if (!handleOptions?.create) {
      throw new Error(`Directory not found: ${name}`);
    }

    const created = new FakeOpfsDirectory(this.options);
    this.directories.set(name, created);
    return created;
  }

  async getFileHandle(
    name: string,
    handleOptions?: { create?: boolean }
  ): Promise<FakeOpfsFileHandle> {
    const existing = this.files.get(name);
    if (existing) {
      return new FakeOpfsFileHandle(existing, this.options.writeDelayMs);
    }

    if (!handleOptions?.create) {
      throw new Error(`File not found: ${name}`);
    }

    const created = new FakeOpfsFile();
    this.files.set(name, created);
    return new FakeOpfsFileHandle(created, this.options.writeDelayMs);
  }

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    if (this.files.delete(name)) {
      return;
    }

    const directory = this.directories.get(name);
    if (!directory) {
      return;
    }

    if (!options?.recursive && (directory.directories.size > 0 || directory.files.size > 0)) {
      throw new Error(`Directory not empty: ${name}`);
    }

    this.directories.delete(name);
  }
}

class FakeOpfsFile {
  bytes = new Uint8Array(0);
}

class FakeOpfsFileHandle {
  constructor(
    private readonly file: FakeOpfsFile,
    private readonly writeDelayMs: number
  ) {}

  async getFile(): Promise<{ arrayBuffer: () => Promise<ArrayBuffer>; text: () => Promise<string> }> {
    const snapshot = this.file.bytes.slice();
    return {
      arrayBuffer: async () => snapshot.buffer.slice(0),
      text: async () => new TextDecoder().decode(snapshot),
    };
  }

  async createWritable(): Promise<{
    write: (data: string | BufferSource) => Promise<void>;
    close: () => Promise<void>;
    truncate: (size: number) => Promise<void>;
  }> {
    let staged = this.file.bytes.slice();
    let wasTruncated = false;

    return {
      truncate: async (size: number) => {
        staged = staged.slice(0, Math.max(0, size));
        wasTruncated = true;
      },
      write: async (data: string | BufferSource) => {
        if (this.writeDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.writeDelayMs));
        }

        const incoming = toUint8Array(data);
        if (wasTruncated) {
          staged = incoming;
          return;
        }

        const merged = new Uint8Array(Math.max(staged.byteLength, incoming.byteLength));
        merged.set(staged);
        merged.set(incoming, 0);
        staged = merged;
      },
      close: async () => {
        this.file.bytes = staged;
      },
    };
  }
}

function toUint8Array(input: string | BufferSource): Uint8Array {
  if (typeof input === 'string') {
    return new TextEncoder().encode(input);
  }

  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }

  return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
}
