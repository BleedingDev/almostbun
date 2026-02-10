/**
 * bun:jsc shim
 *
 * Provides lightweight memory/runtime introspection hooks for browser environments.
 */

export interface HeapStats {
  heapCapacity: number;
  heapSize: number;
  objectCount: number;
  protectedObjectCount: number;
  globalObjectCount: number;
}

export interface MemoryUsage {
  current: number;
  peak: number;
}

const memoryState: MemoryUsage = {
  current: 0,
  peak: 0,
};

function updateMemoryUsage(): MemoryUsage {
  const perf = performance as Performance & {
    memory?: {
      usedJSHeapSize: number;
      jsHeapSizeLimit: number;
    };
  };

  if (perf.memory) {
    memoryState.current = perf.memory.usedJSHeapSize;
    memoryState.peak = Math.max(memoryState.peak, perf.memory.usedJSHeapSize);
  }

  return { ...memoryState };
}

export function gcAndSweep(): void {
  const maybeGc = (globalThis as { gc?: () => void }).gc;
  if (typeof maybeGc === 'function') {
    maybeGc();
  }
  updateMemoryUsage();
}

export function heapStats(): HeapStats {
  const usage = updateMemoryUsage();

  return {
    heapCapacity: usage.peak,
    heapSize: usage.current,
    objectCount: 0,
    protectedObjectCount: 0,
    globalObjectCount: 0,
  };
}

export function memoryUsage(): MemoryUsage {
  return updateMemoryUsage();
}

export function serialize(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

export function deserialize<T = unknown>(data: Uint8Array): T {
  const parsed = JSON.parse(new TextDecoder().decode(data));
  return parsed as T;
}

export function setTimeZone(_timezone: string): void {
  // Not supported in browser runtimes.
}

export default {
  gcAndSweep,
  heapStats,
  memoryUsage,
  serialize,
  deserialize,
  setTimeZone,
};
