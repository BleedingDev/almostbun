/**
 * Node.js module shim
 * Provides basic module system functionality
 */

import * as pathShim from './path';

export const builtinModules = [
  'assert',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'dns',
  'domain',
  'events',
  'fs',
  'http',
  'https',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'sys',
  'timers',
  'tls',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
  'bun',
  'bun:sqlite',
  'bun:test',
  'bun:ffi',
  'bun:jsc',
];

export function isBuiltin(moduleName: string): boolean {
  // Strip node: prefix if present
  const name = moduleName.startsWith('node:') ? moduleName.slice(5) : moduleName;
  return builtinModules.includes(name);
}

export type ModuleRequire = ((id: string) => unknown) & {
  resolve?: (id: string) => string;
  cache?: Record<string, unknown>;
  main?: Module;
};

export function createRequire(filename: string): ModuleRequire {
  const require = ((id: string): unknown => {
    throw new Error(`Cannot find module '${id}' from '${filename}'`);
  }) as ModuleRequire;
  require.resolve = (id: string): string => id;
  require.cache = _cache;
  return require;
}

export class Module {
  id: string;
  filename: string;
  path: string;
  exports: unknown;
  parent: Module | null;
  children: Module[];
  loaded: boolean;
  paths: string[];
  require: ModuleRequire;

  constructor(id = '', parent: Module | null = null) {
    this.id = id;
    this.filename = id;
    this.path = id;
    this.exports = {};
    this.parent = parent;
    this.children = [];
    this.loaded = false;
    this.paths = [];
    this.require = createRequire(id);
  }

  static wrapper = [
    '(function (exports, require, module, __filename, __dirname) { ',
    '\n});',
  ] as const;

  static wrap(script: string): string {
    return `${Module.wrapper[0]}${script}${Module.wrapper[1]}`;
  }

  static _nodeModulePaths(from: string): string[] {
    const out: string[] = [];
    let current = from.replace(/\\/g, '/');

    if (!current.startsWith('/')) {
      current = `/${current}`;
    }
    current = current.replace(/\/+/g, '/');

    while (true) {
      const nodeModulesPath = (current === '/'
        ? '/node_modules'
        : `${current}/node_modules`
      ).replace(/\/+/g, '/');
      out.push(nodeModulesPath);

      if (current === '/') {
        break;
      }
      current = pathShim.dirname(current);
    }

    return out;
  }
}

export const _cache: Record<string, unknown> = {};
export const _extensions: Record<string, (module: Module, filename: string) => void> = {
  '.js': () => {},
  '.json': () => {},
  '.node': () => {},
};
export const _pathCache: Record<string, string> = {};

export function syncBuiltinESMExports(): void {
  // No-op in browser
}

type ModuleCtor = typeof Module & {
  Module: typeof Module;
  createRequire: (filename: string) => ModuleRequire;
  builtinModules: string[];
  isBuiltin: (moduleName: string) => boolean;
  wrap: (script: string) => string;
  wrapper: readonly [string, string];
  _nodeModulePaths: (from: string) => string[];
  _cache: Record<string, unknown>;
  _extensions: Record<string, (module: Module, filename: string) => void>;
  _pathCache: Record<string, string>;
  syncBuiltinESMExports: () => void;
};

const moduleCtor = Module as ModuleCtor;
moduleCtor.Module = Module;
moduleCtor.createRequire = createRequire;
moduleCtor.builtinModules = builtinModules;
moduleCtor.isBuiltin = isBuiltin;
moduleCtor.wrap = Module.wrap;
moduleCtor.wrapper = Module.wrapper;
moduleCtor._nodeModulePaths = Module._nodeModulePaths;
moduleCtor._cache = _cache;
moduleCtor._extensions = _extensions;
moduleCtor._pathCache = _pathCache;
moduleCtor.syncBuiltinESMExports = syncBuiltinESMExports;

export default moduleCtor;
