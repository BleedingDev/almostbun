/**
 * Node.js module shim
 * Provides a lightweight CommonJS module loader with pluggable runtime hooks.
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

function stripNodePrefix(moduleName: string): string {
  return moduleName.startsWith('node:') ? moduleName.slice(5) : moduleName;
}

export function isBuiltin(moduleName: string): boolean {
  return builtinModules.includes(stripNodePrefix(moduleName));
}

export type ModuleRequire = ((id: string) => unknown) & {
  resolve?: (id: string) => string;
  cache?: Record<string, Module>;
  main?: Module;
};

export interface ModuleRuntimeHooks {
  createRequire?: (filename: string) => ModuleRequire;
  resolve?: (id: string, fromFilename: string) => string;
  exists?: (filename: string) => boolean;
  readFile?: (filename: string) => string;
}

let runtimeHooks: ModuleRuntimeHooks | null = null;

// Test/runtime utility: in-memory source registry used when no runtime hook exists.
const mockFiles = new Map<string, string>();

const normalizeModulePath = (filename: string): string => {
  const normalized = filename.replace(/\\/g, '/');
  const withRoot = normalized.startsWith('/') ? normalized : pathShim.resolve('/', normalized);
  return pathShim.normalize(withRoot);
};

const getModuleSource = (filename: string): string | undefined => {
  const normalized = normalizeModulePath(filename);
  if (runtimeHooks?.readFile) {
    try {
      return runtimeHooks.readFile(normalized);
    } catch {
      // fall through to mock files
    }
  }
  return mockFiles.get(normalized);
};

const moduleExists = (filename: string): boolean => {
  const normalized = normalizeModulePath(filename);
  if (runtimeHooks?.exists) {
    try {
      return runtimeHooks.exists(normalized);
    } catch {
      // fall through to mock files
    }
  }
  return mockFiles.has(normalized);
};

const resolveAsFileOrDirectory = (basePath: string): string | null => {
  const normalizedBase = normalizeModulePath(basePath);
  const candidates = [
    normalizedBase,
    `${normalizedBase}.js`,
    `${normalizedBase}.json`,
    `${normalizedBase}.cjs`,
    `${normalizedBase}.mjs`,
    pathShim.join(normalizedBase, 'index.js'),
    pathShim.join(normalizedBase, 'index.json'),
    pathShim.join(normalizedBase, 'index.cjs'),
    pathShim.join(normalizedBase, 'index.mjs'),
  ];

  for (const candidate of candidates) {
    if (moduleExists(candidate)) {
      return candidate;
    }
  }

  return null;
};

const resolveFilename = (id: string, fromFilename: string): string => {
  const moduleId = stripNodePrefix(id);

  if (isBuiltin(moduleId)) {
    return moduleId;
  }

  if (runtimeHooks?.resolve) {
    return normalizeModulePath(runtimeHooks.resolve(moduleId, normalizeModulePath(fromFilename)));
  }

  const fromDir = pathShim.dirname(normalizeModulePath(fromFilename));
  if (
    moduleId === '.' ||
    moduleId === '..' ||
    moduleId.startsWith('./') ||
    moduleId.startsWith('../') ||
    moduleId.startsWith('/')
  ) {
    const basePath = moduleId.startsWith('/')
      ? moduleId
      : pathShim.resolve(fromDir, moduleId);
    const resolved = resolveAsFileOrDirectory(basePath);
    if (resolved) return resolved;
    throw new Error(`Cannot find module '${id}' from '${fromFilename}'`);
  }

  // Minimal node_modules traversal for fallback mode.
  let current = fromDir;
  while (true) {
    const asPackage = resolveAsFileOrDirectory(pathShim.join(current, 'node_modules', moduleId));
    if (asPackage) return asPackage;
    if (current === '/') break;
    current = pathShim.dirname(current);
  }

  throw new Error(`Cannot find module '${id}' from '${fromFilename}'`);
};

const loadModule = (resolvedFilename: string, parent: Module | null): Module => {
  const cached = _cache[resolvedFilename];
  if (cached) {
    return cached;
  }

  const mod = new Module(resolvedFilename, parent);
  mod.filename = resolvedFilename;
  mod.path = pathShim.dirname(resolvedFilename);
  _cache[resolvedFilename] = mod;

  const ext = pathShim.extname(resolvedFilename) || '.js';
  const loader = _extensions[ext] || _extensions['.js'];
  loader(mod, resolvedFilename);
  mod.loaded = true;
  return mod;
};

export function createRequire(filename: string): ModuleRequire {
  const normalizedFrom = normalizeModulePath(filename);

  if (runtimeHooks?.createRequire) {
    const delegated = runtimeHooks.createRequire(normalizedFrom);
    if (!delegated.cache) {
      delegated.cache = _cache;
    }
    if (!delegated.main && delegated.cache) {
      delegated.main = delegated.cache[normalizedFrom];
    }
    return delegated;
  }

  const require = ((id: string): unknown => {
    const resolved = resolveFilename(id, normalizedFrom);
    if (isBuiltin(resolved)) {
      return {};
    }
    const loaded = loadModule(resolved, null);
    return loaded.exports;
  }) as ModuleRequire;

  require.resolve = (id: string): string => {
    const cacheKey = `${normalizedFrom}::${id}`;
    const cached = _pathCache[cacheKey];
    if (cached) return cached;
    const resolved = resolveFilename(id, normalizedFrom);
    _pathCache[cacheKey] = resolved;
    return resolved;
  };
  require.cache = _cache;
  require.main = _cache[normalizedFrom];

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
    this.path = pathShim.dirname(id || '/');
    this.exports = {};
    this.parent = parent;
    this.children = [];
    this.loaded = false;
    this.paths = Module._nodeModulePaths(this.path);
    this.require = createRequire(id || '/');
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

export const _cache: Record<string, Module> = {};
export const _pathCache: Record<string, string> = {};
export const _extensions: Record<string, (module: Module, filename: string) => void> = {
  '.js': (module: Module, filename: string): void => {
    const source = getModuleSource(filename);
    if (source === undefined) {
      throw new Error(`Cannot find module '${filename}'`);
    }

    const code = source.startsWith('#!')
      ? source.replace(/^#![^\r\n]*(?:\r?\n)?/, '')
      : source;
    const wrapped = new Function(
      'exports',
      'require',
      'module',
      '__filename',
      '__dirname',
      code
    ) as (
      exports: unknown,
      require: ModuleRequire,
      module: Module,
      __filename: string,
      __dirname: string
    ) => void;
    wrapped(module.exports, module.require, module, filename, pathShim.dirname(filename));
  },
  '.json': (module: Module, filename: string): void => {
    const source = getModuleSource(filename);
    if (source === undefined) {
      throw new Error(`Cannot find module '${filename}'`);
    }
    module.exports = JSON.parse(source);
  },
  '.node': (_module: Module, filename: string): void => {
    throw new Error(`Native addons are not supported: ${filename}`);
  },
};

export function syncBuiltinESMExports(): void {
  // No-op in browser/runtime shim.
}

// Internal hooks used by runtime and unit tests.
export function __setRuntimeHooks(hooks: ModuleRuntimeHooks | null): void {
  runtimeHooks = hooks;
}

export function __setMockFiles(files: Record<string, string>): void {
  mockFiles.clear();
  for (const [filePath, source] of Object.entries(files)) {
    mockFiles.set(normalizeModulePath(filePath), source);
  }
}

export function __clearMockFiles(): void {
  mockFiles.clear();
  for (const key of Object.keys(_cache)) {
    delete _cache[key];
  }
  for (const key of Object.keys(_pathCache)) {
    delete _pathCache[key];
  }
}

type ModuleCtor = typeof Module & {
  Module: typeof Module;
  createRequire: (filename: string) => ModuleRequire;
  builtinModules: string[];
  isBuiltin: (moduleName: string) => boolean;
  wrap: (script: string) => string;
  wrapper: readonly [string, string];
  _nodeModulePaths: (from: string) => string[];
  _cache: Record<string, Module>;
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
