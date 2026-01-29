/**
 * Runtime Factory - Create main-thread or worker runtime based on configuration
 *
 * Usage:
 *   // Main thread (default)
 *   const runtime = await createRuntime(vfs, { useWorker: false });
 *
 *   // Worker mode
 *   const runtime = await createRuntime(vfs, { useWorker: true });
 *
 *   // Auto-detect
 *   const runtime = await createRuntime(vfs, { useWorker: 'auto' });
 */

import { Runtime } from './runtime';
import { WorkerRuntime } from './worker-runtime';
import type { VirtualFS } from './virtual-fs';
import type { IRuntime, IExecuteResult, CreateRuntimeOptions, IRuntimeOptions } from './runtime-interface';

/**
 * Check if Web Workers are available in the current environment
 */
function isWorkerAvailable(): boolean {
  return typeof Worker !== 'undefined';
}

/**
 * Wrapper that makes the synchronous Runtime conform to the async IRuntime interface
 */
class AsyncRuntimeWrapper implements IRuntime {
  private runtime: Runtime;

  constructor(vfs: VirtualFS, options: IRuntimeOptions = {}) {
    this.runtime = new Runtime(vfs, options);
  }

  async execute(code: string, filename?: string): Promise<IExecuteResult> {
    return Promise.resolve(this.runtime.execute(code, filename));
  }

  async runFile(filename: string): Promise<IExecuteResult> {
    return Promise.resolve(this.runtime.runFile(filename));
  }

  clearCache(): void {
    this.runtime.clearCache();
  }

  getVFS(): VirtualFS {
    return this.runtime.getVFS();
  }

  /**
   * Get the underlying sync Runtime for direct access to sync methods
   */
  getSyncRuntime(): Runtime {
    return this.runtime;
  }
}

/**
 * Create a runtime instance based on configuration
 *
 * @param vfs - Virtual file system instance
 * @param options - Runtime options including useWorker flag
 * @returns Promise resolving to IRuntime instance
 */
export async function createRuntime(
  vfs: VirtualFS,
  options: CreateRuntimeOptions = {}
): Promise<IRuntime> {
  const { useWorker = false, ...runtimeOptions } = options;

  // Determine if we should use a worker
  let shouldUseWorker = false;

  if (useWorker === true) {
    shouldUseWorker = isWorkerAvailable();
    if (!shouldUseWorker) {
      console.warn('[createRuntime] Worker requested but not available, falling back to main thread');
    }
  } else if (useWorker === 'auto') {
    shouldUseWorker = isWorkerAvailable();
    console.log(`[createRuntime] Auto mode: using ${shouldUseWorker ? 'worker' : 'main thread'}`);
  }

  if (shouldUseWorker) {
    console.log('[createRuntime] Creating WorkerRuntime');
    const workerRuntime = new WorkerRuntime(vfs, runtimeOptions);
    // Wait for worker to be ready by executing a simple command
    await workerRuntime.execute('/* worker ready check */', '/__worker_init__.js');
    return workerRuntime;
  }

  console.log('[createRuntime] Creating main-thread Runtime');
  return new AsyncRuntimeWrapper(vfs, runtimeOptions);
}

// Re-export types and classes for convenience
export { Runtime } from './runtime';
export { WorkerRuntime } from './worker-runtime';
export type {
  IRuntime,
  IExecuteResult,
  IRuntimeOptions,
  CreateRuntimeOptions,
  VFSSnapshot,
} from './runtime-interface';
