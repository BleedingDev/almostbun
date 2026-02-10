/**
 * Mini WebContainers MVP - Main Entry Point
 *
 * Provides a browser-based Node.js-like environment
 * with virtual file system and CommonJS module support
 */

export { VirtualFS } from './virtual-fs';
export type { FSNode, Stats, FSWatcher, WatchListener, WatchEventType } from './virtual-fs';
export { Runtime, execute } from './runtime';
export type { Module, RuntimeOptions, RequireFunction } from './runtime';
export { createRuntime, WorkerRuntime, SandboxRuntime } from './create-runtime';
export type { IRuntime, IExecuteResult, CreateRuntimeOptions, IRuntimeOptions, VFSSnapshot } from './runtime-interface';
export { generateSandboxFiles, getSandboxHtml, getSandboxVercelConfig, SANDBOX_SETUP_INSTRUCTIONS } from './sandbox-helpers';
export { createFsShim } from './shims/fs';
export type { FsShim } from './shims/fs';
export { createProcess } from './shims/process';
export type { Process, ProcessEnv } from './shims/process';
export * as path from './shims/path';
export * as http from './shims/http';
export * as net from './shims/net';
export * as events from './shims/events';
export * as stream from './shims/stream';
export * as url from './shims/url';
export * as querystring from './shims/querystring';
export * as util from './shims/util';
export * as npm from './npm';
export { PackageManager, install } from './npm';
export * as repo from './repo';
export { parseGitHubRepoUrl, importGitHubRepo, bootstrapGitHubProject } from './repo';
export type {
  ParsedGitHubRepoUrl,
  ImportGitHubRepoOptions,
  ImportGitHubRepoResult,
  BootstrapGitHubProjectOptions,
  BootstrapGitHubProjectResult,
} from './repo';
export {
  detectRunnableProject,
  startDetectedProject,
  bootstrapAndRunGitHubProject,
} from './repo';
export type {
  RunnableProjectKind,
  DetectRunnableProjectOptions,
  DetectedRunnableProject,
  StartDetectedProjectOptions,
  RunningProject,
  BootstrapAndRunOptions,
  BootstrapAndRunResult,
} from './repo';
export { ServerBridge, getServerBridge, resetServerBridge } from './server-bridge';
export type { InitServiceWorkerOptions } from './server-bridge';
// Dev servers
export { DevServer } from './dev-server';
export type { DevServerOptions, ResponseData, HMRUpdate } from './dev-server';
export { ViteDevServer } from './frameworks/vite-dev-server';
export type { ViteDevServerOptions } from './frameworks/vite-dev-server';
export { NextDevServer } from './frameworks/next-dev-server';
export type { NextDevServerOptions } from './frameworks/next-dev-server';
export { ModernJsDistServer } from './frameworks/modernjs-dist-server';
export type { ModernJsDistServerOptions } from './frameworks/modernjs-dist-server';
// New shims for Vite support
export * as chokidar from './shims/chokidar';
export * as ws from './shims/ws';
export * as fsevents from './shims/fsevents';
export * as readdirp from './shims/readdirp';
export * as module from './shims/module';
export * as perf_hooks from './shims/perf_hooks';
export * as worker_threads from './shims/worker_threads';
export * as esbuild from './shims/esbuild';
export * as rollup from './shims/rollup';
export * as assert from './shims/assert';
export * as bun from './shims/bun';
export * as bun_sqlite from './shims/bun-sqlite';
export * as bun_test from './shims/bun-test';
export * as bun_ffi from './shims/bun-ffi';
export * as bun_jsc from './shims/bun-jsc';
export * as modernjs_effect_client from './shims/modernjs-effect-client';
export * as modernjs_effect_server from './shims/modernjs-effect-server';

// Demo exports
export {
  createConvexAppProject,
  initConvexAppDemo,
  startConvexAppDevServer,
  PACKAGE_JSON as CONVEX_APP_PACKAGE_JSON,
  DEMO_PACKAGES as CONVEX_APP_DEMO_PACKAGES,
} from './convex-app-demo';

import { VirtualFS } from './virtual-fs';
import { Runtime, RuntimeOptions } from './runtime';
import { PackageManager } from './npm';
import { ServerBridge, getServerBridge } from './server-bridge';

export interface ContainerOptions extends RuntimeOptions {
  baseUrl?: string;
  onServerReady?: (port: number, url: string) => void;
}

/**
 * Create a new WebContainer-like environment
 */
export function createContainer(options?: ContainerOptions): {
  vfs: VirtualFS;
  runtime: Runtime;
  npm: PackageManager;
  serverBridge: ServerBridge;
  execute: (code: string, filename?: string) => { exports: unknown };
  runFile: (filename: string) => { exports: unknown };
  createREPL: () => { eval: (code: string) => unknown };
  on: (event: string, listener: (...args: unknown[]) => void) => void;
} {
  const vfs = new VirtualFS();
  const runtime = new Runtime(vfs, options);
  const npmManager = new PackageManager(vfs);
  const serverBridge = getServerBridge({
    baseUrl: options?.baseUrl,
    onServerReady: options?.onServerReady,
  });

  return {
    vfs,
    runtime,
    npm: npmManager,
    serverBridge,
    execute: (code: string, filename?: string) => runtime.execute(code, filename),
    runFile: (filename: string) => runtime.runFile(filename),
    createREPL: () => runtime.createREPL(),
    on: (event: string, listener: (...args: unknown[]) => void) => {
      serverBridge.on(event, listener);
    },
  };
}

export default createContainer;
