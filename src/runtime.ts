/**
 * Runtime - Execute user code with shimmed Node.js globals
 *
 * ESM to CJS transformation is now handled during npm install by transform.ts
 * using esbuild-wasm. This runtime just executes the pre-transformed CJS code.
 */

import { VirtualFS } from './virtual-fs';
import type { IRuntime, IExecuteResult, IRuntimeOptions } from './runtime-interface';
import type { PackageJson } from './types/package-json';
import { simpleHash } from './utils/hash';
import { uint8ToBase64, uint8ToHex } from './utils/binary-encoding';
import { createFsShim, FsShim } from './shims/fs';
import * as pathShim from './shims/path';
import { createProcess, Process } from './shims/process';
import * as httpShim from './shims/http';
import * as httpsShim from './shims/https';
import * as netShim from './shims/net';
import eventsShim from './shims/events';
import streamShim from './shims/stream';
import * as urlShim from './shims/url';
import * as querystringShim from './shims/querystring';
import * as utilShim from './shims/util';
import * as ttyShim from './shims/tty';
import * as osShim from './shims/os';
import * as cryptoShim from './shims/crypto';
import * as zlibShim from './shims/zlib';
import * as dnsShim from './shims/dns';
import bufferShim from './shims/buffer';
import * as childProcessShim from './shims/child_process';
import { initChildProcess } from './shims/child_process';
import { getServerBridge } from './server-bridge';
import * as chokidarShim from './shims/chokidar';
import * as wsShim from './shims/ws';
import * as fseventsShim from './shims/fsevents';
import * as readdirpShim from './shims/readdirp';
import * as moduleShim from './shims/module';
import * as perfHooksShim from './shims/perf_hooks';
import * as workerThreadsShim from './shims/worker_threads';
import * as esbuildShim from './shims/esbuild';
import * as rollupShim from './shims/rollup';
import * as v8Shim from './shims/v8';
import * as readlineShim from './shims/readline';
import * as tlsShim from './shims/tls';
import * as http2Shim from './shims/http2';
import * as clusterShim from './shims/cluster';
import * as dgramShim from './shims/dgram';
import * as vmShim from './shims/vm';
import * as inspectorShim from './shims/inspector';
import * as asyncHooksShim from './shims/async_hooks';
import * as domainShim from './shims/domain';
import * as diagnosticsChannelShim from './shims/diagnostics_channel';
import * as wasiShim from './shims/wasi';
import * as sentryShim from './shims/sentry';
import assertShim from './shims/assert';
import constantsShim from './shims/constants';
import {
  createBunModule,
  type BunModule,
} from './shims/bun';
import * as bunSqliteShim from './shims/bun-sqlite';
import * as bunTestShim from './shims/bun-test';
import * as bunFfiShim from './shims/bun-ffi';
import * as bunJscShim from './shims/bun-jsc';
import * as modernJsEffectClientShim from './shims/modernjs-effect-client';
import * as modernJsEffectServerShim from './shims/modernjs-effect-server';
import { resolve as resolveExports } from 'resolve.exports';

/**
 * Transform dynamic imports in code: import('x') -> __dynamicImport('x')
 * This allows dynamic imports to work in our eval-based runtime
 */
function transformDynamicImports(code: string): string {
  // Use a regex that matches import( but not things like:
  // - "import(" in strings
  // - // import( in comments
  // This is a simple approach that works for most bundled code
  // For a more robust solution, we'd need a proper parser

  // Match: import( with optional whitespace, not preceded by word char or $
  // This handles: import('x'), import ("x"), await import('x'), etc.
  return code.replace(/(?<![.$\w])import\s*\(/g, '__dynamicImport(');
}

/**
 * Simple synchronous ESM to CJS transform
 * Handles basic import/export syntax without needing esbuild
 */
function transformEsmToCjs(code: string, filename: string): string {
  // Check if code has ESM syntax
  const hasImport = /\bimport\s+[\w{*'"]/m.test(code);
  const hasExport = /\bexport\s+(?:default|const|let|var|async\s+function|function|class|{|\*)/m.test(code);
  const hasImportMeta = /\bimport\.meta\b/.test(code);

  if (!hasImport && !hasExport && !hasImportMeta) {
    return code; // Already CJS or no module syntax
  }

  let transformed = code;
  const namedDeclarationExports = new Set<string>();
  let reExportCounter = 0;

  // Transform import.meta.url to a file:// URL
  transformed = transformed.replace(/\bimport\.meta\.url\b/g, `"file://${filename}"`);
  transformed = transformed.replace(/\bimport\.meta\.dirname\b/g, `"${pathShim.dirname(filename)}"`);
  transformed = transformed.replace(/\bimport\.meta\.filename\b/g, `"${filename}"`);
  transformed = transformed.replace(/\bimport\.meta\b/g, `({ url: "file://${filename}", dirname: "${pathShim.dirname(filename)}", filename: "${filename}" })`);

  // Transform named imports: import { a, b } from 'x' -> const { a, b } = require('x')
  transformed = transformed.replace(
    /\bimport\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]\s*;?/g,
    (_, imports, module) => {
      const cleanImports = imports.replace(/\s+as\s+/g, ': ');
      return `const {${cleanImports}} = require("${module}");`;
    }
  );

  // Transform default imports: import x from 'y' -> const x = require('y').default || require('y')
  transformed = transformed.replace(
    /\bimport\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/g,
    (_, name, module) => {
      return `const ${name} = (function() { const m = require("${module}"); return m && m.__esModule ? m.default : m; })();`;
    }
  );

  // Transform namespace imports: import * as x from 'y' -> const x = require('y')
  transformed = transformed.replace(
    /\bimport\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/g,
    'const $1 = require("$2");'
  );

  // Transform side-effect imports: import 'x' -> require('x')
  transformed = transformed.replace(
    /\bimport\s+['"]([^'"]+)['"]\s*;?/g,
    'require("$1");'
  );

  // Transform export default: export default x -> module.exports.default = x; module.exports = x
  transformed = transformed.replace(
    /\bexport\s+default\s+/g,
    'module.exports = module.exports.default = '
  );

  // Transform export * from: export * from 'x' -> Object.assign(module.exports, require('x'))
  transformed = transformed.replace(
    /\bexport\s+\*\s+from\s+['"]([^'"]+)['"]\s*;?/g,
    (_, module) => `Object.assign(module.exports, require("${module}"));`
  );

  // Transform re-export lists: export { a as b } from 'x'
  transformed = transformed.replace(
    /\bexport\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]\s*;?/g,
    (_, exports, module) => {
      const tempVar = `__reexport_${reExportCounter++}`;
      const lines = [`const ${tempVar} = require("${module}");`];
      for (const item of exports.split(',')) {
        const [local, exported] = item.trim().split(/\s+as\s+/);
        const localName = local.trim();
        const exportName = (exported || local).trim();
        lines.push(`module.exports.${exportName} = ${tempVar}.${localName};`);
      }
      return lines.join('\n');
    }
  );

  // Transform named exports: export { a, b } -> module.exports.a = a; module.exports.b = b
  transformed = transformed.replace(
    /\bexport\s+\{([^}]+)\}\s*;?/g,
    (_, exports) => {
      const items = exports.split(',').map((item: string) => {
        const [local, exported] = item.trim().split(/\s+as\s+/);
        const exportName = exported || local;
        return `module.exports.${exportName.trim()} = ${local.trim()};`;
      });
      return items.join('\n');
    }
  );

  // Transform export const/let/var: export const x = 1 -> const x = 1; module.exports.x = x
  transformed = transformed.replace(
    /\bexport\s+(const|let|var)\s+(\w+)\s*=/g,
    '$1 $2 = module.exports.$2 ='
  );

  // Transform export async function: export async function x() {} -> async function x() {}
  transformed = transformed.replace(
    /\bexport\s+async\s+function\s+(\w+)/g,
    (_, name) => {
      namedDeclarationExports.add(name);
      return `async function ${name}`;
    }
  );

  // Transform export function: export function x() {} -> function x() {} module.exports.x = x
  transformed = transformed.replace(
    /\bexport\s+function\s+(\w+)/g,
    (_, name) => {
      namedDeclarationExports.add(name);
      return `function ${name}`;
    }
  );

  // Transform export class: export class X {} -> class X {} module.exports.X = X
  transformed = transformed.replace(
    /\bexport\s+class\s+(\w+)/g,
    (_, name) => {
      namedDeclarationExports.add(name);
      return `class ${name}`;
    }
  );

  if (namedDeclarationExports.size > 0) {
    transformed += `\n${Array.from(namedDeclarationExports)
      .map((name) => `module.exports.${name} = ${name};`)
      .join('\n')}`;
  }

  // Mark as ES module for interop
  if (hasExport) {
    transformed = 'Object.defineProperty(exports, "__esModule", { value: true });\n' + transformed;
  }

  return transformed;
}

/**
 * Create a dynamic import function for a module context
 * Returns a function that wraps require() in a Promise
 */
function createDynamicImport(moduleRequire: RequireFunction): (specifier: string) => Promise<unknown> {
  return async (specifier: string): Promise<unknown> => {
    try {
      const mod = moduleRequire(specifier);

      // If the module has a default export or is already ESM-like, return as-is
      if (mod && typeof mod === 'object' && ('default' in (mod as object) || '__esModule' in (mod as object))) {
        return mod;
      }

      // For CommonJS modules, wrap in an object with default export
      // This matches how dynamic import() handles CJS modules
      return {
        default: mod,
        ...(mod && typeof mod === 'object' ? mod as object : {}),
      };
    } catch (error) {
      // Re-throw as a rejected promise (which is what dynamic import does)
      throw error;
    }
  };
}

export interface Module {
  id: string;
  filename: string;
  exports: unknown;
  loaded: boolean;
  children: Module[];
  paths: string[];
}

export interface RuntimeOptions {
  cwd?: string;
  env?: Record<string, string>;
  argv?: string[];
  onConsole?: (method: string, args: unknown[]) => void;
}

export interface RequireFunction {
  (id: string): unknown;
  resolve: (id: string) => string;
  cache: Record<string, Module>;
}

/**
 * Create a basic string_decoder module
 */
function createStringDecoderModule() {
  class StringDecoder {
    encoding: string;
    constructor(encoding?: string) {
      this.encoding = encoding || 'utf8';
    }
    write(buffer: Uint8Array): string {
      return new TextDecoder(this.encoding).decode(buffer);
    }
    end(buffer?: Uint8Array): string {
      if (buffer) return this.write(buffer);
      return '';
    }
  }
  return { StringDecoder };
}

/**
 * Create a basic timers module
 */
function createTimersModule() {
  const runtimeGlobal = globalThis as typeof globalThis & {
    setImmediate?: (callback: (...args: unknown[]) => void, ...args: unknown[]) => unknown;
    clearImmediate?: (handle: unknown) => void;
  };
  const globalSetImmediate = runtimeGlobal.setImmediate;
  const globalClearImmediate = runtimeGlobal.clearImmediate;

  return {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    setImmediate: typeof globalSetImmediate === 'function'
      ? globalSetImmediate.bind(globalThis)
      : (fn: (...args: unknown[]) => void, ...args: unknown[]) => setTimeout(() => fn(...args), 0),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    clearImmediate: typeof globalClearImmediate === 'function'
      ? globalClearImmediate.bind(globalThis)
      : globalThis.clearTimeout.bind(globalThis),
  };
}

/**
 * Minimal prettier shim - just returns input unchanged
 * This is needed because prettier uses createRequire which conflicts with our runtime
 */
const prettierShim = {
  format: (source: string, _options?: unknown) => Promise.resolve(source),
  formatWithCursor: (source: string, _options?: unknown) => Promise.resolve({ formatted: source, cursorOffset: 0 }),
  check: (_source: string, _options?: unknown) => Promise.resolve(true),
  resolveConfig: () => Promise.resolve(null),
  resolveConfigFile: () => Promise.resolve(null),
  clearConfigCache: () => {},
  getFileInfo: () => Promise.resolve({ ignored: false, inferredParser: null }),
  getSupportInfo: () => Promise.resolve({ languages: [], options: [] }),
  version: '3.0.0',
  doc: {
    builders: {},
    printer: {},
    utils: {},
  },
};

/**
 * Create a mutable copy of a module for packages that need to patch it
 * (e.g., Sentry needs to patch http.request/http.get)
 */
function makeMutable(mod: Record<string, unknown>): Record<string, unknown> {
  const mutable: Record<string, unknown> = {};
  for (const key of Object.keys(mod)) {
    mutable[key] = mod[key];
  }
  return mutable;
}

/**
 * Built-in modules registry
 */
const builtinModules: Record<string, unknown> = {
  path: pathShim,
  // Make http/https mutable so packages like Sentry can patch them
  http: makeMutable(httpShim as unknown as Record<string, unknown>),
  https: makeMutable(httpsShim as unknown as Record<string, unknown>),
  net: netShim,
  events: eventsShim,
  stream: streamShim,
  buffer: bufferShim,
  url: urlShim,
  querystring: querystringShim,
  util: utilShim,
  tty: ttyShim,
  os: osShim,
  crypto: cryptoShim,
  zlib: zlibShim,
  dns: dnsShim,
  child_process: childProcessShim,
  assert: assertShim,
  constants: constantsShim,
  string_decoder: createStringDecoderModule(),
  timers: createTimersModule(),
  _http_common: {},
  _http_incoming: {},
  _http_outgoing: {},
  // New shims for Vite support
  chokidar: chokidarShim,
  ws: wsShim,
  fsevents: fseventsShim,
  readdirp: readdirpShim,
  module: moduleShim,
  perf_hooks: perfHooksShim,
  worker_threads: workerThreadsShim,
  esbuild: esbuildShim,
  rollup: rollupShim,
  v8: v8Shim,
  readline: readlineShim,
  tls: tlsShim,
  http2: http2Shim,
  cluster: clusterShim,
  dgram: dgramShim,
  vm: vmShim,
  inspector: inspectorShim,
  'inspector/promises': inspectorShim,
  async_hooks: asyncHooksShim,
  domain: domainShim,
  diagnostics_channel: diagnosticsChannelShim,
  wasi: wasiShim,
  // prettier uses createRequire which doesn't work in our runtime, so we shim it
  prettier: prettierShim,
  // Some packages explicitly require 'console'
  console: console,
  // util/types is accessed as a subpath
  'util/types': utilShim.types,
  // Sentry SDK (no-op since error tracking isn't useful in browser runtime)
  '@sentry/node': sentryShim,
  '@sentry/core': sentryShim,
  // Bun built-ins
  'bun:sqlite': bunSqliteShim,
  'bun:test': bunTestShim,
  'bun:ffi': bunFfiShim,
  'bun:jsc': bunJscShim,
  // Modern.js Effect BFF
  '@modern-js/plugin-bff/effect-client': modernJsEffectClientShim,
  '@modern-js/plugin-bff/effect-server': modernJsEffectServerShim,
};

/**
 * Create a require function for a specific module context
 */
function createRequire(
  vfs: VirtualFS,
  fsShim: FsShim,
  process: Process,
  currentDir: string,
  moduleCache: Record<string, Module>,
  options: RuntimeOptions,
  processedCodeCache?: Map<string, string>,
  bunModule?: BunModule
): RequireFunction {
  const bun = bunModule ?? createBunModule(fsShim, process);

  // Module resolution cache for faster repeated imports
  const resolutionCache: Map<string, string | null> = new Map();

  // Package.json parsing cache
  const packageJsonCache: Map<string, PackageJson | null> = new Map();
  const nearestTsConfigCache: Map<string, string | null> = new Map();
  const tsConfigAliasCache: Map<string, {
    baseUrl: string;
    paths: Array<{ pattern: string; targets: string[] }>;
  } | null> = new Map();
  let legacyEventsModuleCache: unknown = null;

  const copyDescriptors = (from: Record<string, unknown>, to: Record<string, unknown>): void => {
    for (const prop of Object.getOwnPropertyNames(from)) {
      if (prop === 'length' || prop === 'name' || prop === 'prototype') {
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(from, prop);
      if (!descriptor) {
        continue;
      }
      try {
        Object.defineProperty(to, prop, descriptor);
      } catch {
        // Ignore non-configurable properties.
      }
    }
  };

  const getLegacyCompatibleEventsModule = (): unknown => {
    if (legacyEventsModuleCache) {
      return legacyEventsModuleCache;
    }

    const originalModule = builtinModules.events as unknown;
    const eventEmitterCtor =
      typeof originalModule === 'function'
        ? originalModule
        : (originalModule &&
            typeof originalModule === 'object' &&
            typeof (originalModule as { EventEmitter?: unknown }).EventEmitter === 'function'
          ? (originalModule as { EventEmitter: (...args: unknown[]) => unknown }).EventEmitter
          : null);

    if (!eventEmitterCtor || !/^\s*class\b/.test(Function.prototype.toString.call(eventEmitterCtor))) {
      legacyEventsModuleCache = originalModule;
      return originalModule;
    }

    const classEmitter = eventEmitterCtor as (...args: unknown[]) => unknown;
    const callableEmitter = function EventEmitterCompat(this: object): unknown {
      if (!(this instanceof callableEmitter)) {
        return new (callableEmitter as unknown as { new(): unknown })();
      }
      return undefined;
    } as ((...args: unknown[]) => unknown) & Record<string, unknown>;

    callableEmitter.prototype = (classEmitter as unknown as { prototype: unknown }).prototype;
    try {
      Object.setPrototypeOf(callableEmitter, classEmitter);
    } catch {
      // Ignore prototype assignment issues.
    }

    copyDescriptors(classEmitter as unknown as Record<string, unknown>, callableEmitter);
    if (originalModule && originalModule !== classEmitter && typeof originalModule === 'object') {
      copyDescriptors(originalModule as Record<string, unknown>, callableEmitter);
    }
    callableEmitter.EventEmitter = callableEmitter;

    legacyEventsModuleCache = callableEmitter;
    return legacyEventsModuleCache;
  };

  const getParsedPackageJson = (pkgPath: string): PackageJson | null => {
    if (packageJsonCache.has(pkgPath)) {
      return packageJsonCache.get(pkgPath)!;
    }
    try {
      const content = vfs.readFileSync(pkgPath, 'utf8');
      const parsed = JSON.parse(content) as PackageJson;
      packageJsonCache.set(pkgPath, parsed);
      return parsed;
    } catch {
      packageJsonCache.set(pkgPath, null);
      return null;
    }
  };

  const moduleExtensions = ['.js', '.json', '.node', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.jsx'];

  const tryResolveFile = (basePath: string): string | null => {
    // Try exact path first
    if (vfs.existsSync(basePath)) {
      const stats = vfs.statSync(basePath);
      if (stats.isFile()) {
        return basePath;
      }
      // Directory - honor package.json entry points first.
      const pkgJsonPath = pathShim.join(basePath, 'package.json');
      if (vfs.existsSync(pkgJsonPath)) {
        const pkg = getParsedPackageJson(pkgJsonPath);
        if (pkg) {
          const entryCandidates = [pkg.main, pkg.module]
            .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
          for (const entry of entryCandidates) {
            const entryPath = entry.startsWith('/')
              ? entry
              : pathShim.resolve(basePath, entry);
            const resolvedEntry = tryResolveFile(entryPath);
            if (resolvedEntry) {
              return resolvedEntry;
            }
          }
        }
      }

      // Directory - look for index files
      for (const ext of moduleExtensions) {
        const indexPath = pathShim.join(basePath, `index${ext}`);
        if (vfs.existsSync(indexPath)) {
          return indexPath;
        }
      }
    }

    // Try with extensions
    for (const ext of moduleExtensions) {
      const withExt = basePath + ext;
      if (vfs.existsSync(withExt)) {
        return withExt;
      }
    }

    return null;
  };

  const getNearestTsConfigDir = (startDir: string): string | null => {
    if (nearestTsConfigCache.has(startDir)) {
      return nearestTsConfigCache.get(startDir)!;
    }

    const visited: string[] = [];
    let current = startDir;

    while (true) {
      if (nearestTsConfigCache.has(current)) {
        const cached = nearestTsConfigCache.get(current)!;
        for (const dir of visited) {
          nearestTsConfigCache.set(dir, cached);
        }
        return cached;
      }

      visited.push(current);
      const tsconfigPath = pathShim.join(current, 'tsconfig.json');
      const jsconfigPath = pathShim.join(current, 'jsconfig.json');
      if (vfs.existsSync(tsconfigPath) || vfs.existsSync(jsconfigPath)) {
        for (const dir of visited) {
          nearestTsConfigCache.set(dir, current);
        }
        return current;
      }

      if (current === '/') {
        for (const dir of visited) {
          nearestTsConfigCache.set(dir, null);
        }
        return null;
      }

      current = pathShim.dirname(current);
    }
  };

  const getTsConfigAliases = (tsconfigDir: string): {
    baseUrl: string;
    paths: Array<{ pattern: string; targets: string[] }>;
  } | null => {
    if (tsConfigAliasCache.has(tsconfigDir)) {
      return tsConfigAliasCache.get(tsconfigDir)!;
    }

    const tsconfigPath = pathShim.join(tsconfigDir, 'tsconfig.json');
    const jsconfigPath = pathShim.join(tsconfigDir, 'jsconfig.json');
    const configPath = vfs.existsSync(tsconfigPath) ? tsconfigPath : jsconfigPath;
    if (!vfs.existsSync(configPath)) {
      tsConfigAliasCache.set(tsconfigDir, null);
      return null;
    }

    try {
      const raw = vfs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw) as {
        compilerOptions?: {
          baseUrl?: unknown;
          paths?: unknown;
        };
      };
      const compilerOptions = parsed.compilerOptions || {};
      const rawBaseUrl = typeof compilerOptions.baseUrl === 'string'
        ? compilerOptions.baseUrl
        : '.';
      const baseUrl = rawBaseUrl.startsWith('/')
        ? rawBaseUrl
        : pathShim.resolve(tsconfigDir, rawBaseUrl);

      const pathEntries: Array<{ pattern: string; targets: string[] }> = [];
      const rawPaths = compilerOptions.paths;
      if (rawPaths && typeof rawPaths === 'object') {
        for (const [pattern, targets] of Object.entries(rawPaths as Record<string, unknown>)) {
          if (typeof pattern !== 'string') continue;
          if (Array.isArray(targets)) {
            const stringTargets = targets.filter((entry): entry is string => typeof entry === 'string');
            if (stringTargets.length > 0) {
              pathEntries.push({ pattern, targets: stringTargets });
            }
            continue;
          }
          if (typeof targets === 'string') {
            pathEntries.push({ pattern, targets: [targets] });
          }
        }
      }

      const info = {
        baseUrl,
        paths: pathEntries,
      };
      tsConfigAliasCache.set(tsconfigDir, info);
      return info;
    } catch {
      tsConfigAliasCache.set(tsconfigDir, null);
      return null;
    }
  };

  const matchPathPattern = (pattern: string, request: string): string | null => {
    const starIndex = pattern.indexOf('*');
    if (starIndex < 0) {
      return pattern === request ? '' : null;
    }

    const prefix = pattern.slice(0, starIndex);
    const suffix = pattern.slice(starIndex + 1);
    if (!request.startsWith(prefix)) {
      return null;
    }
    if (suffix && !request.endsWith(suffix)) {
      return null;
    }

    return request.slice(prefix.length, request.length - suffix.length);
  };

  const applyPathTarget = (target: string, wildcardMatch: string): string => {
    const starIndex = target.indexOf('*');
    if (starIndex < 0) {
      return target;
    }
    return `${target.slice(0, starIndex)}${wildcardMatch}${target.slice(starIndex + 1)}`;
  };

  const resolveTsConfigAlias = (id: string, fromDir: string): string | null => {
    const tsconfigDir = getNearestTsConfigDir(fromDir);
    if (!tsconfigDir) {
      return null;
    }

    const aliases = getTsConfigAliases(tsconfigDir);
    if (!aliases) {
      return null;
    }

    for (const entry of aliases.paths) {
      const wildcardMatch = matchPathPattern(entry.pattern, id);
      if (wildcardMatch === null) {
        continue;
      }

      for (const target of entry.targets) {
        const mappedTarget = applyPathTarget(target, wildcardMatch);
        const candidateBase = mappedTarget.startsWith('/')
          ? mappedTarget
          : pathShim.resolve(aliases.baseUrl, mappedTarget);
        const resolved = tryResolveFile(candidateBase);
        if (resolved) {
          return resolved;
        }
      }
    }

    // Support baseUrl-only absolute imports (e.g. "src/foo") while avoiding package names.
    if (id.includes('/') || id === 'package.json') {
      const baseUrlCandidate = tryResolveFile(pathShim.resolve(aliases.baseUrl, id));
      if (baseUrlCandidate) {
        return baseUrlCandidate;
      }
    }

    return null;
  };

  const resolveModule = (id: string, fromDir: string): string => {
    // Handle node: protocol prefix (Node.js 16+)
    if (id.startsWith('node:')) {
      id = id.slice(5);
    }

    // Handle Bun protocol modules (bun:sqlite, bun:test, etc.)
    if (id.startsWith('bun:') && builtinModules[id]) {
      return id;
    }

    // Built-in modules
    if (
      builtinModules[id] ||
      id === 'bun' ||
      id === 'fs' ||
      id === 'fs/promises' ||
      id === 'process' ||
      id === 'url' ||
      id === 'querystring' ||
      id === 'util'
    ) {
      return id;
    }

    // Check resolution cache
    const cacheKey = `${fromDir}|${id}`;
    const cached = resolutionCache.get(cacheKey);
    if (cached !== undefined) {
      if (cached === null) {
        throw new Error(`Cannot find module '${id}'`);
      }
      return cached;
    }

    // Relative paths
    if (id === '.' || id === '..' || id.startsWith('./') || id.startsWith('../') || id.startsWith('/')) {
      const resolved = id.startsWith('/')
        ? id
        : pathShim.resolve(fromDir, id);

      const resolvedFile = tryResolveFile(resolved);
      if (resolvedFile) {
        resolutionCache.set(cacheKey, resolvedFile);
        return resolvedFile;
      }

      resolutionCache.set(cacheKey, null);
      throw new Error(`Cannot find module '${id}' from '${fromDir}'`);
    }

    // tsconfig/jsconfig path aliases (e.g. @/* -> src/*)
    const aliasResolved = resolveTsConfigAlias(id, fromDir);
    if (aliasResolved) {
      resolutionCache.set(cacheKey, aliasResolved);
      return aliasResolved;
    }

    // Runtime executes server-oriented Node code, so do not apply browser field remapping.
    const applyBrowserFieldRemap = (resolvedPath: string, pkg: PackageJson, pkgRoot: string): string | null => {
      return resolvedPath;
    };

    const normalizeResolvedExports = (value: unknown): string[] => {
      const out: string[] = [];
      const seen = new Set<string>();

      const visit = (node: unknown) => {
        if (!node) return;
        if (typeof node === 'string') {
          if (!seen.has(node)) {
            seen.add(node);
            out.push(node);
          }
          return;
        }
        if (Array.isArray(node)) {
          for (const item of node) visit(item);
          return;
        }
        if (typeof node === 'object') {
          for (const value of Object.values(node as Record<string, unknown>)) {
            visit(value);
          }
        }
      };

      visit(value);
      return out;
    };

    const tryResolveFromPackageExports = (
      pkg: PackageJson,
      pkgRoot: string,
      pkgName: string,
      moduleId: string
    ): string | null => {
      if (!pkg.exports) return null;

      const subPath = moduleId === pkgName
        ? '.'
        : `./${moduleId.slice(pkgName.length + 1)}`;

      const requestCandidates = moduleId === pkgName
        ? [moduleId, '.']
        : [moduleId, subPath];

      const conditionCandidates: Array<Record<string, boolean>> = [
        { require: true },
        {},
      ];

      for (const request of requestCandidates) {
        for (const conditions of conditionCandidates) {
          try {
            const resolved = resolveExports(pkg, request, conditions);
            const exportPaths = normalizeResolvedExports(resolved);

            for (const exportPath of exportPaths) {
              const fullExportPath = exportPath.startsWith('/')
                ? exportPath
                : pathShim.join(pkgRoot, exportPath);
              const resolvedFile = tryResolveFile(fullExportPath);
              if (!resolvedFile) continue;

              const remapped = applyBrowserFieldRemap(resolvedFile, pkg, pkgRoot);
              if (remapped) return remapped;
            }
          } catch {
            // resolve.exports throws on no match; continue to fallback strategies.
          }
        }
      }

      return null;
    };

    const pnpmRootsCache = new Map<string, string[]>();

    const getPnpmPackageRoots = (nodeModulesDir: string, pkgName: string): string[] => {
      const cacheKey = `${nodeModulesDir}|${pkgName}`;
      const cached = pnpmRootsCache.get(cacheKey);
      if (cached) return cached;

      const storeDir = pathShim.join(nodeModulesDir, '.pnpm');
      const roots: string[] = [];

      if (vfs.existsSync(storeDir) && vfs.statSync(storeDir).isDirectory()) {
        let entries: string[] = [];
        try {
          entries = vfs.readdirSync(storeDir);
        } catch {
          entries = [];
        }

        const token = pkgName.startsWith('@')
          ? `${pkgName.slice(1).replace('/', '+')}@`
          : `${pkgName}@`;

        for (const entry of entries) {
          if (!entry.includes(token)) continue;

          const pkgRoot = pathShim.join(storeDir, entry, 'node_modules', pkgName);
          const pkgPath = pathShim.join(pkgRoot, 'package.json');
          if (vfs.existsSync(pkgPath)) {
            roots.push(pkgRoot);
          }
        }
      }

      pnpmRootsCache.set(cacheKey, roots);
      return roots;
    };

    // Helper to resolve from a node_modules directory
    const tryResolveFromNodeModules = (nodeModulesDir: string, moduleId: string): string | null => {
      // Determine the package name and root
      const parts = moduleId.split('/');
      const pkgName = parts[0].startsWith('@') && parts.length > 1
        ? `${parts[0]}/${parts[1]}`  // Scoped package
        : parts[0];

      const packageRoots = [
        pathShim.join(nodeModulesDir, pkgName),
        ...getPnpmPackageRoots(nodeModulesDir, pkgName),
      ];

      for (const pkgRoot of packageRoots) {
        const pkgPath = pathShim.join(pkgRoot, 'package.json');
        const pkg = getParsedPackageJson(pkgPath);

        // Check package.json first — it controls entry points (browser, main, exports)
        if (pkg) {
          const exportResolved = tryResolveFromPackageExports(pkg, pkgRoot, pkgName, moduleId);
          if (exportResolved) return exportResolved;

          // If this is the package root (no sub-path), use main/module entry.
          if (pkgName === moduleId) {
            const main = pkg.main || pkg.module || 'index.js';
            const mainPath = pathShim.join(pkgRoot, main);
            const resolvedMain = tryResolveFile(mainPath);
            if (resolvedMain) {
              const remapped = applyBrowserFieldRemap(resolvedMain, pkg, pkgRoot);
              if (remapped) return remapped;
            }
          }
        }

        // Resolve sub-path directly from package root when exports are absent/incomplete.
        if (moduleId !== pkgName && moduleId.startsWith(`${pkgName}/`)) {
          const subPath = moduleId.slice(pkgName.length + 1);
          const resolvedSubPath = tryResolveFile(pathShim.join(pkgRoot, subPath));
          if (resolvedSubPath) {
            if (pkg) {
              const remapped = applyBrowserFieldRemap(resolvedSubPath, pkg, pkgRoot);
              if (remapped) return remapped;
            }
            return resolvedSubPath;
          }
        }
      }

      // Fall back to direct file/directory resolution (for sub-paths or packages without package.json)
      const fullPath = pathShim.join(nodeModulesDir, moduleId);
      const resolved = tryResolveFile(fullPath);
      if (resolved) return resolved;

      return null;
    };

    // Node modules resolution
    let searchDir = fromDir;
    while (searchDir !== '/') {
      const nodeModulesDir = pathShim.join(searchDir, 'node_modules');
      const resolved = tryResolveFromNodeModules(nodeModulesDir, id);
      if (resolved) {
        resolutionCache.set(cacheKey, resolved);
        return resolved;
      }

      searchDir = pathShim.dirname(searchDir);
    }

    // Try root node_modules as last resort
    const rootResolved = tryResolveFromNodeModules('/node_modules', id);
    if (rootResolved) {
      resolutionCache.set(cacheKey, rootResolved);
      return rootResolved;
    }

    resolutionCache.set(cacheKey, null);
    throw new Error(`Cannot find module '${id}'`);
  };

  const loadModule = (resolvedPath: string): Module => {
    // Return cached module
    if (moduleCache[resolvedPath]) {
      return moduleCache[resolvedPath];
    }

    // Create module object
    const module: Module = {
      id: resolvedPath,
      filename: resolvedPath,
      exports: {},
      loaded: false,
      children: [],
      paths: [],
    };

    // Cache before loading to handle circular dependencies
    moduleCache[resolvedPath] = module;

    // Evict oldest entry if cache exceeds bounds
    const cacheKeys = Object.keys(moduleCache);
    if (cacheKeys.length > 2000) {
      delete moduleCache[cacheKeys[0]];
    }

    // Handle JSON files
    if (resolvedPath.endsWith('.json')) {
      const content = vfs.readFileSync(resolvedPath, 'utf8');
      module.exports = JSON.parse(content);
      module.loaded = true;
      return module;
    }

    // Native Node addons cannot execute in browser runtime.
    if (resolvedPath.endsWith('.node')) {
      throw new Error(`Native addons are not supported in this runtime: ${resolvedPath}`);
    }

    // Read and execute JS file
    const rawCode = vfs.readFileSync(resolvedPath, 'utf8');
    // Node-style executables often start with a shebang line (#!/usr/bin/env node).
    // Strip it before eval so CLI bins from node_modules can execute in-browser.
    const sanitizedRawCode = rawCode.startsWith('#!')
      ? rawCode.replace(/^#![^\r\n]*(?:\r?\n)?/, '')
      : rawCode;
    const dirname = pathShim.dirname(resolvedPath);

    // Check processed code cache (useful for HMR when module cache is cleared but code hasn't changed)
    // Use a simple hash of the content for cache key to handle content changes
    const codeCacheKey = `${resolvedPath}|${simpleHash(sanitizedRawCode)}`;
    let code = processedCodeCache?.get(codeCacheKey);

    if (!code) {
      code = sanitizedRawCode;

      // Transform ESM to CJS if needed (for .mjs files or ESM that wasn't pre-transformed)
      // This handles files that weren't transformed during npm install
      // BUT skip .cjs files and already-bundled CJS code
      const isCjsFile = resolvedPath.endsWith('.cjs');
      const isAlreadyBundledCjs = code.startsWith('"use strict";\nvar __') ||
                                   code.startsWith("'use strict';\nvar __") ||
                                   code.startsWith('var __create = Object.create;') ||
                                   code.startsWith('Object.defineProperty(exports, "__esModule", { value: true });');

      const hasEsmImport = /^\s*import\s+[\w{*'"]/m.test(code);
      const hasEsmExport = /^\s*export\s+(?:default|const|let|var|function|class|{|\*)/m.test(code);

      if (!isCjsFile && !isAlreadyBundledCjs) {
        if (resolvedPath.endsWith('.mjs') || resolvedPath.includes('/esm/') || hasEsmImport || hasEsmExport) {
          code = transformEsmToCjs(code, resolvedPath);
        }
      }

      // Transform dynamic imports: import('x') -> __dynamicImport('x')
      // This allows dynamic imports to work in our eval-based runtime
      code = transformDynamicImports(code);

      // Cache the processed code
      processedCodeCache?.set(codeCacheKey, code);
    }

    // Create require for this module
    const moduleRequire = createRequire(
      vfs,
      fsShim,
      process,
      dirname,
      moduleCache,
      options,
      processedCodeCache,
      bun
    );
    moduleRequire.cache = moduleCache;

    // Create console wrapper
    const consoleWrapper = createConsoleWrapper(options.onConsole);

    // Execute module code
    // We use an outer/inner function pattern to avoid conflicts:
    // - Outer function receives parameters and sets up vars
    // - Inner function runs the code, allowing let/const to shadow without "already declared" errors
    // - import.meta is provided for ESM code that uses it
    try {
      const importMetaUrl = 'file://' + resolvedPath;
      const wrappedCode = `(function($exports, $require, $module, $filename, $dirname, $process, $console, $importMeta, $dynamicImport, $bun) {
var exports = $exports;
var require = $require;
var module = $module;
var __filename = $filename;
var __dirname = $dirname;
var process = $process;
var console = $console;
var import_meta = $importMeta;
var __dynamicImport = $dynamicImport;
var Bun = $bun;
// Set up global.process and globalThis.process for code that accesses them directly
var global = globalThis;
globalThis.process = $process;
global.process = $process;
globalThis.Bun = $bun;
global.Bun = $bun;
return (function() {
${code}
}).call(this);
})`;

      let fn;
      try {
        fn = eval(wrappedCode);
      } catch (evalError) {
        console.error('[runtime] Eval failed for:', resolvedPath);
        console.error('[runtime] First 500 chars of code:', code.substring(0, 500));
        throw evalError;
      }
      // Create dynamic import function for this module context
      const dynamicImport = createDynamicImport(moduleRequire);
      (globalThis as typeof globalThis & {
        __almostbunDynamicImport?: (specifier: string) => Promise<unknown>;
      }).__almostbunDynamicImport = dynamicImport;
      try {
        // Ensure generated/eval'd code that references __dynamicImport as a free
        // identifier can resolve it from global scope.
        (0, eval)('var __dynamicImport = globalThis.__almostbunDynamicImport;');
      } catch {
        // Best-effort; local wrapper still provides __dynamicImport.
      }

      fn(
        module.exports,
        moduleRequire,
        module,
        resolvedPath,
        dirname,
        process,
        consoleWrapper,
        { url: importMetaUrl, dirname, filename: resolvedPath },
        dynamicImport,
        bun
      );

      module.loaded = true;
    } catch (error) {
      // Remove from cache on error
      delete moduleCache[resolvedPath];
      if (error instanceof Error && !error.message.includes('[while loading')) {
        error.message = `${error.message} [while loading ${resolvedPath}]`;
      }
      throw error;
    }

    return module;
  };

  let swcCoreShimCache: Record<string, unknown> | null = null;
  let httpErrorsShimCache: Record<string, unknown> | null = null;
  const getSwcCoreShim = (): Record<string, unknown> => {
    if (swcCoreShimCache) {
      return swcCoreShimCache;
    }

    const transpileSync = (
      input: string,
      options?: {
        filename?: string;
        sourceMaps?: boolean;
        jsc?: {
          parser?: {
            syntax?: string;
            jsx?: boolean;
            tsx?: boolean;
          };
        };
      }
    ): { code: string; map: string } => {
      try {
        const ts = require('typescript') as {
          transpileModule?: (
            code: string,
            options: {
              fileName?: string;
              reportDiagnostics?: boolean;
              compilerOptions?: Record<string, unknown>;
            }
          ) => { outputText?: string; sourceMapText?: string };
          ModuleKind?: { CommonJS?: number };
          ScriptTarget?: { ES2020?: number };
          JsxEmit?: { ReactJSX?: number; Preserve?: number };
        };
        if (typeof ts?.transpileModule === 'function') {
          const parser = options?.jsc?.parser;
          const usesJsx = !!(parser?.jsx || parser?.tsx);
          const output = ts.transpileModule(input, {
            fileName: options?.filename,
            reportDiagnostics: false,
            compilerOptions: {
              module: ts.ModuleKind?.CommonJS,
              target: ts.ScriptTarget?.ES2020,
              sourceMap: !!options?.sourceMaps,
              jsx: usesJsx ? ts.JsxEmit?.ReactJSX : ts.JsxEmit?.Preserve,
            },
          });
          return {
            code: output.outputText || input,
            map: output.sourceMapText || '',
          };
        }
      } catch {
        // Fallback to passthrough below.
      }
      return {
        code: input,
        map: '',
      };
    };

    class Compiler {
      transformSync(code: string, options?: unknown) {
        return transpileSync(code, options as Parameters<typeof transpileSync>[1]);
      }
      async transform(code: string, options?: unknown) {
        return this.transformSync(code, options);
      }
      minifySync(code: string) {
        return { code, map: '' };
      }
      async minify(code: string) {
        return this.minifySync(code);
      }
      parseSync() {
        return { type: 'Program', body: [] as unknown[] };
      }
      async parse() {
        return this.parseSync();
      }
      printSync(program: unknown) {
        if (typeof program === 'string') {
          return { code: program, map: '' };
        }
        return { code: '', map: '' };
      }
      async print(program: unknown) {
        return this.printSync(program);
      }
      async bundle() {
        return {};
      }
    }

    const compiler = new Compiler();
    swcCoreShimCache = {
      version: '0.0.0-almostbun',
      Compiler,
      transformSync: compiler.transformSync.bind(compiler),
      transform: compiler.transform.bind(compiler),
      minifySync: compiler.minifySync.bind(compiler),
      minify: compiler.minify.bind(compiler),
      parseSync: compiler.parseSync.bind(compiler),
      parse: compiler.parse.bind(compiler),
      printSync: compiler.printSync.bind(compiler),
      print: compiler.print.bind(compiler),
      bundle: compiler.bundle.bind(compiler),
    };
    return swcCoreShimCache;
  };

  const getHttpErrorsShim = (): Record<string, unknown> => {
    if (httpErrorsShimCache) {
      return httpErrorsShimCache;
    }

    class HttpError extends Error {
      status: number;
      statusCode: number;
      expose: boolean;

      constructor(status = 500, message?: string) {
        super(message || `HTTP ${status}`);
        this.name = 'HttpError';
        this.status = status;
        this.statusCode = status;
        this.expose = status < 500;
      }
    }

    const createError = (...args: unknown[]): HttpError => {
      let status = 500;
      let message: string | undefined;
      let originalError: Error | undefined;

      for (const arg of args) {
        if (typeof arg === 'number') {
          status = arg;
          continue;
        }
        if (typeof arg === 'string') {
          message = arg;
          continue;
        }
        if (arg instanceof Error) {
          originalError = arg;
          continue;
        }
      }

      const err = new HttpError(status, message || originalError?.message);
      if (originalError?.stack) {
        err.stack = originalError.stack;
      }
      return err;
    };

    const withStatics = createError as ((...args: unknown[]) => HttpError) & {
      HttpError: typeof HttpError;
      isHttpError: (value: unknown) => boolean;
      [status: number]: (message?: string) => HttpError;
    };

    withStatics.HttpError = HttpError;
    withStatics.isHttpError = (value: unknown): boolean => {
      if (!value || typeof value !== 'object') {
        return false;
      }
      const candidate = value as { status?: unknown; statusCode?: unknown };
      return (
        typeof candidate.status === 'number' &&
        typeof candidate.statusCode === 'number'
      );
    };

    for (let status = 400; status < 600; status += 1) {
      withStatics[status] = (message?: string) => createError(status, message);
    }

    httpErrorsShimCache = withStatics as unknown as Record<string, unknown>;
    return httpErrorsShimCache;
  };

  // Expose runtime-aware hooks to the standalone module shim so `require("module")`
  // can resolve and load files using the active runtime/VFS.
  if (typeof moduleShim.__setRuntimeHooks === 'function') {
    moduleShim.__setRuntimeHooks({
      createRequire: (filename: string) => {
        const normalized = filename.startsWith('file://') ? filename.slice(7) : filename;
        const fromDir = pathShim.dirname(normalized);
        const runtimeRequire = createRequire(
          vfs,
          fsShim,
          process,
          fromDir,
          moduleCache,
          options,
          processedCodeCache,
          bun
        );
        runtimeRequire.cache = moduleCache;
        return runtimeRequire as unknown as moduleShim.ModuleRequire;
      },
      resolve: (id: string, fromFilename: string) => {
        const fromDir = pathShim.dirname(fromFilename);
        return resolveModule(id, fromDir);
      },
      exists: (filename: string) => {
        try {
          return vfs.existsSync(filename) && vfs.statSync(filename).isFile();
        } catch {
          return false;
        }
      },
      readFile: (filename: string) => vfs.readFileSync(filename, 'utf8'),
    });
  }

  const require: RequireFunction = (id: string): unknown => {
    // Handle node: protocol prefix (Node.js 16+)
    if (id.startsWith('node:')) {
      id = id.slice(5);
    }
    // Some packages request built-ins with a trailing slash (e.g. "string_decoder/").
    // Normalize this to the canonical module id.
    id = id.replace(/\/+$/, '');

    if (id === 'bun') {
      return bun;
    }

    if (id.startsWith('bun:') && builtinModules[id]) {
      return builtinModules[id];
    }

    // Built-in modules
    if (id === 'fs') {
      return fsShim;
    }
    if (id === 'fs/promises') {
      return fsShim.promises;
    }
    if (id === 'process') {
      return process;
    }
    if (id === '@swc/core' || id === '@swc/core-wasm32-wasi' || id.startsWith('@swc/core/')) {
      return getSwcCoreShim();
    }
    if (id === 'http-errors') {
      return getHttpErrorsShim();
    }
    if (id === 'toidentifier') {
      return function toIdentifier(input: unknown): string {
        const str = input == null ? '' : String(input);
        return str
          .split(' ')
          .map((token) => token.slice(0, 1).toUpperCase() + token.slice(1))
          .join('')
          .replace(/[^ _0-9a-z]/gi, '');
      };
    }
    // Special handling for 'module' - provide a constructor-compatible export
    // with a runtime-bound createRequire implementation.
    if (id === 'module') {
      class RuntimeModule extends moduleShim.Module {}
      type RuntimeModuleCtor = typeof RuntimeModule & {
        Module: typeof RuntimeModule;
        createRequire: (filenameOrUrl: string) => RequireFunction;
        builtinModules: string[];
        isBuiltin: (moduleName: string) => boolean;
        _cache: Record<string, Module>;
        _extensions: Record<string, unknown>;
        _pathCache: Record<string, string>;
        syncBuiltinESMExports: () => void;
      };

      const runtimeModule = RuntimeModule as RuntimeModuleCtor;
      runtimeModule.Module = RuntimeModule;
      runtimeModule.builtinModules = moduleShim.builtinModules;
      runtimeModule.isBuiltin = moduleShim.isBuiltin;
      runtimeModule._cache = moduleCache;
      runtimeModule._extensions = moduleShim._extensions;
      runtimeModule._pathCache = moduleShim._pathCache;
      runtimeModule.syncBuiltinESMExports = moduleShim.syncBuiltinESMExports;
      runtimeModule.createRequire = (filenameOrUrl: string): RequireFunction => {
        // Convert file:// URL to path
        let fromPath = filenameOrUrl;
        if (filenameOrUrl.startsWith('file://')) {
          fromPath = filenameOrUrl.slice(7); // Remove 'file://'
          // Handle Windows-style file:///C:/ URLs (though unlikely in our env)
          if (fromPath.startsWith('/') && fromPath[2] === ':') {
            fromPath = fromPath.slice(1);
          }
        }
        // Get directory from the path
        const fromDir = pathShim.dirname(fromPath);
        // Return a require function that resolves from this directory
        const newRequire = createRequire(
          vfs,
          fsShim,
          process,
          fromDir,
          moduleCache,
          options,
          undefined,
          bun
        );
        newRequire.cache = moduleCache;
        return newRequire;
      };

      return runtimeModule;
    }
    if (id === 'events') {
      return getLegacyCompatibleEventsModule();
    }
    if (builtinModules[id]) {
      return builtinModules[id];
    }

    // Intercept rollup and esbuild - always use our shims
    // These packages have native binaries that don't work in browser
    if (id === 'rollup' || id.startsWith('rollup/') || id.startsWith('@rollup/')) {
      console.log('[runtime] Intercepted rollup:', id);
      return builtinModules['rollup'];
    }
    if (id === 'esbuild' || id.startsWith('esbuild/') || id.startsWith('@esbuild/')) {
      console.log('[runtime] Intercepted esbuild:', id);
      return builtinModules['esbuild'];
    }
    // Intercept prettier - uses createRequire which doesn't work in our runtime
    if (id === 'prettier' || id.startsWith('prettier/')) {
      return builtinModules['prettier'];
    }
    // Intercept Sentry - SDK tries to monkey-patch http which doesn't work
    if (id.startsWith('@sentry/')) {
      return builtinModules['@sentry/node'];
    }

    const resolved = resolveModule(id, currentDir);

    // If resolved to a built-in name (shouldn't happen but safety check)
    if (builtinModules[resolved]) {
      if (resolved === 'events') {
        return getLegacyCompatibleEventsModule();
      }
      return builtinModules[resolved];
    }

    // Also check if resolved path is to rollup, esbuild, or prettier in node_modules
    if (resolved.includes('/node_modules/rollup/') ||
        resolved.includes('/node_modules/@rollup/')) {
      return builtinModules['rollup'];
    }
    if (resolved.includes('/node_modules/esbuild/') ||
        resolved.includes('/node_modules/@esbuild/')) {
      return builtinModules['esbuild'];
    }
    if (resolved.includes('/node_modules/prettier/')) {
      return builtinModules['prettier'];
    }
    if (resolved.includes('/node_modules/@sentry/')) {
      return builtinModules['@sentry/node'];
    }
    if (resolved.includes('/node_modules/@swc/core/')) {
      return getSwcCoreShim();
    }
    if (resolved.includes('/node_modules/http-errors/')) {
      return getHttpErrorsShim();
    }
    if (resolved.includes('/node_modules/toidentifier/')) {
      return function toIdentifier(input: unknown): string {
        const str = input == null ? '' : String(input);
        return str
          .split(' ')
          .map((token) => token.slice(0, 1).toUpperCase() + token.slice(1))
          .join('')
          .replace(/[^ _0-9a-z]/gi, '');
      };
    }

    let loadedExports = loadModule(resolved).exports as any;

    // CommonJS/ESM interop edge case:
    // Some packages expect require('lru-cache').LRUCache even when the package
    // exports the constructor directly as module.exports.
    if (
      id === 'lru-cache' ||
      /\/node_modules\/lru-cache\//.test(resolved)
    ) {
      if (typeof loadedExports === 'function') {
        if (!loadedExports.LRUCache) {
          loadedExports.LRUCache = loadedExports;
        }
        return loadedExports;
      }
      if (loadedExports && typeof loadedExports === 'object') {
        if (!loadedExports.LRUCache && typeof loadedExports.default === 'function') {
          loadedExports.LRUCache = loadedExports.default;
        }
      }
    }

    // CommonJS/ESM interop edge case for chalk:
    // transformed ESM builds may expose color methods under `default`
    // while CJS callers expect `require('chalk').cyan(...)`.
    if (
      id === 'chalk' ||
      /\/node_modules\/chalk\//.test(resolved)
    ) {
      if (typeof loadedExports === 'function') {
        // Many bundler `__toESM` helpers copy only enumerable properties from
        // CJS exports. Chalk color methods are non-enumerable on the function
        // export, so make them enumerable to preserve `import * as chalk` usage.
        for (const prop of Object.getOwnPropertyNames(loadedExports)) {
          if (
            prop === 'length' ||
            prop === 'name' ||
            prop === 'prototype' ||
            prop === 'arguments' ||
            prop === 'caller'
          ) {
            continue;
          }
          const descriptor = Object.getOwnPropertyDescriptor(loadedExports, prop);
          if (!descriptor || descriptor.enumerable) {
            continue;
          }
          try {
            Object.defineProperty(loadedExports, prop, {
              ...descriptor,
              enumerable: true,
            });
          } catch {
            // Ignore non-configurable properties.
          }
        }
        return loadedExports;
      }
      if (loadedExports && typeof loadedExports === 'object') {
        const defaultExport = loadedExports.default;
        if (
          defaultExport &&
          (typeof defaultExport === 'function' || typeof defaultExport === 'object') &&
          typeof loadedExports.cyan !== 'function' &&
          typeof defaultExport.cyan === 'function'
        ) {
          return defaultExport;
        }
      }
    }

    // Compatibility for mixed statuses/http-errors versions:
    // some `http-errors` releases read `statuses.message`, while newer
    // `statuses` publishes `STATUS_CODES`.
    if (
      id === 'statuses' ||
      /\/node_modules\/statuses\//.test(resolved)
    ) {
      if (loadedExports && (typeof loadedExports === 'function' || typeof loadedExports === 'object')) {
        if (!loadedExports.message && loadedExports.STATUS_CODES && typeof loadedExports.STATUS_CODES === 'object') {
          loadedExports.message = loadedExports.STATUS_CODES;
        }
        if (!loadedExports.STATUS_CODES && loadedExports.message && typeof loadedExports.message === 'object') {
          loadedExports.STATUS_CODES = loadedExports.message;
        }
      }
    }

    // Compatibility for etag-like modules:
    // some frameworks pass Uint8Array / ArrayBuffer, while etag expects
    // Node Buffer|string|fs.Stats.
    if (
      (id === 'etag' || /\/node_modules\/etag\//.test(resolved)) &&
      typeof loadedExports === 'function'
    ) {
      const etagImpl = loadedExports as ((entity: unknown, options?: unknown) => unknown) & Record<string, unknown>;
      const wrapped = ((entity: unknown, options?: unknown) => {
        let normalized = entity;
        if (entity instanceof ArrayBuffer) {
          normalized = Buffer.from(entity);
        } else if (ArrayBuffer.isView(entity)) {
          normalized = Buffer.from(entity as ArrayBufferView as Uint8Array);
        }
        return etagImpl(normalized, options);
      }) as typeof etagImpl;

      for (const prop of Object.getOwnPropertyNames(etagImpl)) {
        if (prop === 'length' || prop === 'name' || prop === 'prototype') {
          continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(etagImpl, prop);
        if (!descriptor) {
          continue;
        }
        try {
          Object.defineProperty(wrapped, prop, descriptor);
        } catch {
          // Ignore non-configurable properties.
        }
      }

      loadedExports = wrapped;
    }

    // Legacy EventEmitter compatibility:
    // older stacks use util.inherits + EventEmitter.call(this), which fails
    // when EventEmitter is class-only.
    if (
      id === 'events' ||
      /\/node_modules\/events\//.test(resolved)
    ) {
      const candidate =
        typeof loadedExports === 'function'
          ? loadedExports
          : (loadedExports && typeof loadedExports === 'object' && typeof loadedExports.EventEmitter === 'function'
            ? loadedExports.EventEmitter
            : null);

      if (candidate && /^\s*class\b/.test(Function.prototype.toString.call(candidate))) {
        const classEmitter = candidate as (...args: unknown[]) => unknown;
        const callableEmitter = function EventEmitterCompat(this: object): unknown {
          if (!(this instanceof callableEmitter)) {
            return new (callableEmitter as unknown as { new(): unknown })();
          }
          return undefined;
        } as ((...args: unknown[]) => unknown) & Record<string, unknown>;

        callableEmitter.prototype = (classEmitter as unknown as { prototype: unknown }).prototype;
        try {
          Object.setPrototypeOf(callableEmitter, classEmitter);
        } catch {
          // Ignore if prototype assignment fails in this runtime.
        }

        for (const prop of Object.getOwnPropertyNames(classEmitter)) {
          if (prop === 'length' || prop === 'name' || prop === 'prototype') {
            continue;
          }
          const descriptor = Object.getOwnPropertyDescriptor(classEmitter, prop);
          if (!descriptor) {
            continue;
          }
          try {
            Object.defineProperty(callableEmitter, prop, descriptor);
          } catch {
            // Ignore non-configurable properties.
          }
        }

        if (loadedExports === classEmitter) {
          loadedExports = callableEmitter;
          loadedExports.EventEmitter = callableEmitter;
        } else if (loadedExports && typeof loadedExports === 'object') {
          if (loadedExports.EventEmitter === classEmitter) {
            loadedExports.EventEmitter = callableEmitter;
          }
          if (loadedExports.default === classEmitter) {
            loadedExports.default = callableEmitter;
          }
        }
      }
    }

    return loadedExports;
  };

  require.resolve = (id: string): string => {
    if (id === 'bun' || id === 'fs' || id === 'fs/promises' || id === 'process' || builtinModules[id]) {
      return id;
    }
    return resolveModule(id, currentDir);
  };

  require.cache = moduleCache;

  return require;
}

/**
 * Create a console wrapper that can capture output
 */
function createConsoleWrapper(
  onConsole?: (method: string, args: unknown[]) => void
): Console {
  const wrapper = {
    log: (...args: unknown[]) => {
      console.log(...args);
      onConsole?.('log', args);
    },
    error: (...args: unknown[]) => {
      console.error(...args);
      onConsole?.('error', args);
    },
    warn: (...args: unknown[]) => {
      console.warn(...args);
      onConsole?.('warn', args);
    },
    info: (...args: unknown[]) => {
      console.info(...args);
      onConsole?.('info', args);
    },
    debug: (...args: unknown[]) => {
      console.debug(...args);
      onConsole?.('debug', args);
    },
    trace: (...args: unknown[]) => {
      console.trace(...args);
      onConsole?.('trace', args);
    },
    dir: (obj: unknown) => {
      console.dir(obj);
      onConsole?.('dir', [obj]);
    },
    time: console.time.bind(console),
    timeEnd: console.timeEnd.bind(console),
    timeLog: console.timeLog.bind(console),
    assert: console.assert.bind(console),
    clear: console.clear.bind(console),
    count: console.count.bind(console),
    countReset: console.countReset.bind(console),
    group: console.group.bind(console),
    groupCollapsed: console.groupCollapsed.bind(console),
    groupEnd: console.groupEnd.bind(console),
    table: console.table.bind(console),
  };

  return wrapper as unknown as Console;
}

/**
 * Runtime class for executing code in virtual environment
 * Note: This class has sync methods for backward compatibility.
 * Use createRuntime() factory for IRuntime interface compliance.
 */
export class Runtime {
  private vfs: VirtualFS;
  private fsShim: FsShim;
  private process: Process;
  private bunModule: BunModule;
  private moduleCache: Record<string, Module> = {};
  private options: RuntimeOptions;
  /** Cache for pre-processed code (after ESM transform) before eval */
  private processedCodeCache: Map<string, string> = new Map();

  constructor(vfs: VirtualFS, options: RuntimeOptions = {}) {
    this.vfs = vfs;
    // Create process first so we can get cwd for fs shim
    this.process = createProcess({
      cwd: options.cwd || '/',
      env: options.env,
      argv: options.argv,
    });
    // Create fs shim with cwd getter for relative path resolution
    this.fsShim = createFsShim(vfs, () => this.process.cwd());
    this.bunModule = createBunModule(this.fsShim, this.process);
    this.options = options;
    (globalThis as typeof globalThis & { __almostbunFsShim?: FsShim }).__almostbunFsShim = this.fsShim;

    // Initialize child_process with VFS for bash command support
    initChildProcess(vfs);

    // Initialize file watcher shims with VFS
    chokidarShim.setVFS(vfs);
    readdirpShim.setVFS(vfs);

    // Initialize esbuild shim with VFS for file access
    esbuildShim.setVFS(vfs);

    // Polyfill Error.captureStackTrace/prepareStackTrace for Safari/WebKit
    // (V8-specific API used by Express's depd and other npm packages)
    this.setupStackTracePolyfill();

    // Polyfill TextDecoder to handle base64/base64url/hex gracefully
    // (Some CLI tools incorrectly try to use TextDecoder for these)
    this.setupTextDecoderPolyfill();

    // Polyfill global setImmediate/clearImmediate used by many Node HTTP packages.
    this.setupImmediatePolyfill();
  }

  private setupImmediatePolyfill(): void {
    const runtimeGlobal = globalThis as typeof globalThis & {
      setImmediate?: (callback: (...args: unknown[]) => void, ...args: unknown[]) => unknown;
      clearImmediate?: (handle: unknown) => void;
      __almostbunImmediateHandles?: Map<number, ReturnType<typeof setTimeout>>;
      __almostbunImmediateNextId?: number;
    };

    if (typeof runtimeGlobal.setImmediate === 'function' && typeof runtimeGlobal.clearImmediate === 'function') {
      return;
    }

    if (!runtimeGlobal.__almostbunImmediateHandles) {
      runtimeGlobal.__almostbunImmediateHandles = new Map<number, ReturnType<typeof setTimeout>>();
      runtimeGlobal.__almostbunImmediateNextId = 1;
    }

    if (typeof runtimeGlobal.setImmediate !== 'function') {
      runtimeGlobal.setImmediate = ((callback: (...args: unknown[]) => void, ...args: unknown[]) => {
        const id = runtimeGlobal.__almostbunImmediateNextId ?? 1;
        runtimeGlobal.__almostbunImmediateNextId = id + 1;
        const handle = setTimeout(() => {
          runtimeGlobal.__almostbunImmediateHandles?.delete(id);
          callback(...args);
        }, 0);
        runtimeGlobal.__almostbunImmediateHandles?.set(id, handle);
        return id;
      }) as any;
    }

    if (typeof runtimeGlobal.clearImmediate !== 'function') {
      runtimeGlobal.clearImmediate = (handle: unknown) => {
        const id = typeof handle === 'number'
          ? handle
          : Number.parseInt(String(handle), 10);
        if (!Number.isFinite(id)) {
          return;
        }
        const timeoutHandle = runtimeGlobal.__almostbunImmediateHandles?.get(id);
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
          runtimeGlobal.__almostbunImmediateHandles?.delete(id);
          return;
        }
        clearTimeout(id);
      };
    }
  }

  /**
   * Set up a polyfilled TextDecoder that handles binary encodings
   */
  private setupTextDecoderPolyfill(): void {
    const OriginalTextDecoder = globalThis.TextDecoder;

    class PolyfillTextDecoder {
      private encoding: string;
      private decoder: TextDecoder | null = null;

      constructor(encoding: string = 'utf-8', options?: TextDecoderOptions) {
        this.encoding = encoding.toLowerCase();

        // For valid text encodings, use the real TextDecoder
        const validTextEncodings = [
          'utf-8', 'utf8', 'utf-16le', 'utf-16be', 'utf-16',
          'ascii', 'iso-8859-1', 'latin1', 'windows-1252'
        ];

        if (validTextEncodings.includes(this.encoding)) {
          try {
            this.decoder = new OriginalTextDecoder(encoding, options);
          } catch {
            // Fall back to utf-8
            this.decoder = new OriginalTextDecoder('utf-8', options);
          }
        }
        // For binary encodings (base64, base64url, hex), decoder stays null
      }

      decode(input?: BufferSource, options?: TextDecodeOptions): string {
        if (this.decoder) {
          return this.decoder.decode(input, options);
        }

        // Handle binary encodings manually
        if (!input) return '';

        const bytes = input instanceof ArrayBuffer
          ? new Uint8Array(input)
          : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);

        if (this.encoding === 'base64') {
          return uint8ToBase64(bytes);
        }

        if (this.encoding === 'base64url') {
          return uint8ToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
        }

        if (this.encoding === 'hex') {
          return uint8ToHex(bytes);
        }

        // Fallback: decode as utf-8
        return new OriginalTextDecoder('utf-8').decode(input, options);
      }

      get fatal(): boolean {
        return this.decoder?.fatal ?? false;
      }

      get ignoreBOM(): boolean {
        return this.decoder?.ignoreBOM ?? false;
      }
    }

    globalThis.TextDecoder = PolyfillTextDecoder as unknown as typeof TextDecoder;
  }

  /**
   * Polyfill V8's Error.captureStackTrace and Error.prepareStackTrace for Safari/WebKit.
   * Express's `depd` and other npm packages use these V8-specific APIs which don't
   * exist in Safari, causing "callSite.getFileName is not a function" errors.
   */
  private setupStackTracePolyfill(): void {
    // Only polyfill if not already available (i.e., not V8/Chrome)
    if (typeof (Error as any).captureStackTrace === 'function') return;

    // Set a default stackTraceLimit so Math.max(10, undefined) doesn't produce NaN
    // (depd and other packages read this value)
    if ((Error as any).stackTraceLimit === undefined) {
      (Error as any).stackTraceLimit = 10;
    }

    // Parse a stack trace string into structured frames
    function parseStack(stack: string): Array<{fn: string, file: string, line: number, col: number}> {
      if (!stack) return [];
      const frames: Array<{fn: string, file: string, line: number, col: number}> = [];
      const lines = stack.split('\n');

      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('Error') || line.startsWith('TypeError')) continue;

        let fn = '', file = '', lineNo = 0, colNo = 0;

        // Safari format: "functionName@file:line:col" or "@file:line:col"
        const safariMatch = line.match(/^(.*)@(.*?):(\d+):(\d+)$/);
        if (safariMatch) {
          fn = safariMatch[1] || '';
          file = safariMatch[2];
          lineNo = parseInt(safariMatch[3], 10);
          colNo = parseInt(safariMatch[4], 10);
          frames.push({ fn, file, line: lineNo, col: colNo });
          continue;
        }

        // Chrome format: "at functionName (file:line:col)" or "at file:line:col"
        const chromeMatch = line.match(/^at\s+(?:(.+?)\s+\()?(.*?):(\d+):(\d+)\)?$/);
        if (chromeMatch) {
          fn = chromeMatch[1] || '';
          file = chromeMatch[2];
          lineNo = parseInt(chromeMatch[3], 10);
          colNo = parseInt(chromeMatch[4], 10);
          frames.push({ fn, file, line: lineNo, col: colNo });
          continue;
        }
      }
      return frames;
    }

    // Create a mock CallSite object from a parsed frame
    function createCallSite(frame: {fn: string, file: string, line: number, col: number}) {
      return {
        getFileName: () => frame.file || null,
        getLineNumber: () => frame.line || null,
        getColumnNumber: () => frame.col || null,
        getFunctionName: () => frame.fn || null,
        getMethodName: () => frame.fn || null,
        getTypeName: () => null,
        getThis: () => undefined,
        getFunction: () => undefined,
        getEvalOrigin: () => undefined,
        isNative: () => false,
        isConstructor: () => false,
        isToplevel: () => !frame.fn,
        isEval: () => false,
        toString: () => frame.fn
          ? `${frame.fn} (${frame.file}:${frame.line}:${frame.col})`
          : `${frame.file}:${frame.line}:${frame.col}`,
      };
    }

    // Helper: parse stack and create CallSite objects, used by both captureStackTrace and .stack getter
    function buildCallSites(stack: string, constructorOpt?: Function) {
      const frames = parseStack(stack);
      let startIdx = 0;
      if (constructorOpt && constructorOpt.name) {
        for (let i = 0; i < frames.length; i++) {
          if (frames[i].fn === constructorOpt.name) {
            startIdx = i + 1;
            break;
          }
        }
      }
      return frames.slice(startIdx).map(createCallSite);
    }

    // Symbol to store raw stack string, used by the .stack getter
    const stackSymbol = Symbol('rawStack');

    // Intercept .stack on Error.prototype so that packages using the V8 pattern
    // "Error.prepareStackTrace = fn; new Error().stack" also get CallSite objects.
    // In V8, reading .stack lazily triggers prepareStackTrace; Safari doesn't do this.
    Object.defineProperty(Error.prototype, 'stack', {
      get() {
        const rawStack = (this as any)[stackSymbol];
        if (rawStack !== undefined && typeof (Error as any).prepareStackTrace === 'function') {
          const callSites = buildCallSites(rawStack);
          try {
            return (Error as any).prepareStackTrace(this, callSites);
          } catch {
            return rawStack;
          }
        }
        return rawStack;
      },
      set(value: string) {
        (this as any)[stackSymbol] = value;
      },
      configurable: true,
      enumerable: false,
    });

    // Polyfill Error.captureStackTrace
    (Error as any).captureStackTrace = function(target: any, constructorOpt?: Function) {
      // Temporarily clear prepareStackTrace to get the raw stack string
      // (otherwise our .stack getter would call prepareStackTrace recursively)
      const savedPrepare = (Error as any).prepareStackTrace;
      (Error as any).prepareStackTrace = undefined;
      const err = new Error();
      const rawStack = err.stack || '';
      (Error as any).prepareStackTrace = savedPrepare;

      // If prepareStackTrace is set, provide structured call sites
      if (typeof savedPrepare === 'function') {
        const callSites = buildCallSites(rawStack, constructorOpt);
        try {
          target.stack = savedPrepare(target, callSites);
        } catch (e) {
          console.warn('[almostnode] Error.prepareStackTrace threw:', e);
          target.stack = rawStack;
        }
      } else {
        target.stack = rawStack;
      }
    };
  }

  /**
   * Execute code as a module (synchronous - backward compatible)
   */
  execute(
    code: string,
    filename: string = '/index.js'
  ): { exports: unknown; module: Module } {
    const dirname = pathShim.dirname(filename);

    // Write code to virtual file system
    this.vfs.writeFileSync(filename, code);

    // Create require function
    const require = createRequire(
      this.vfs,
      this.fsShim,
      this.process,
      dirname,
      this.moduleCache,
      this.options,
      this.processedCodeCache,
      this.bunModule
    );

    // Create module object
    const module: Module = {
      id: filename,
      filename,
      exports: {},
      loaded: false,
      children: [],
      paths: [],
    };

    // Cache the module
    this.moduleCache[filename] = module;

    // Create console wrapper
    const consoleWrapper = createConsoleWrapper(this.options.onConsole);

    // Execute code
    // Use the same wrapper pattern as loadModule for consistency
    try {
      const importMetaUrl = 'file://' + filename;
      const wrappedCode = `(function($exports, $require, $module, $filename, $dirname, $process, $console, $importMeta, $dynamicImport, $bun) {
var exports = $exports;
var require = $require;
var module = $module;
var __filename = $filename;
var __dirname = $dirname;
var process = $process;
var console = $console;
var import_meta = $importMeta;
var __dynamicImport = $dynamicImport;
var Bun = $bun;
// Set up global.process and globalThis.process for code that accesses them directly
var global = globalThis;
globalThis.process = $process;
global.process = $process;
globalThis.Bun = $bun;
global.Bun = $bun;

return (function() {
${code}
}).call(this);
})`;

      const fn = eval(wrappedCode);
      const dynamicImport = createDynamicImport(require);
      (globalThis as typeof globalThis & {
        __almostbunDynamicImport?: (specifier: string) => Promise<unknown>;
      }).__almostbunDynamicImport = dynamicImport;
      try {
        (0, eval)('var __dynamicImport = globalThis.__almostbunDynamicImport;');
      } catch {
        // Best-effort; local wrapper still provides __dynamicImport.
      }
      fn(
        module.exports,
        require,
        module,
        filename,
        dirname,
        this.process,
        consoleWrapper,
        { url: importMetaUrl, dirname, filename },
        dynamicImport,
        this.bunModule
      );

      module.loaded = true;
    } catch (error) {
      delete this.moduleCache[filename];
      throw error;
    }

    return { exports: module.exports, module };
  }

  /**
   * Execute code as a module (async version for IRuntime interface)
   * Alias: executeSync() is the same as execute() for backward compatibility
   */
  executeSync = this.execute;

  /**
   * Execute code as a module (async - for IRuntime interface)
   */
  async executeAsync(
    code: string,
    filename: string = '/index.js'
  ): Promise<IExecuteResult> {
    return Promise.resolve(this.execute(code, filename));
  }

  /**
   * Run a file from the virtual file system (synchronous - backward compatible)
   */
  runFile(filename: string): { exports: unknown; module: Module } {
    const entryPath = filename.startsWith('/')
      ? filename
      : pathShim.resolve(this.process.cwd(), filename);
    const require = createRequire(
      this.vfs,
      this.fsShim,
      this.process,
      pathShim.dirname(entryPath),
      this.moduleCache,
      this.options,
      this.processedCodeCache,
      this.bunModule
    );
    require.cache = this.moduleCache;

    const resolvedPath = require.resolve(entryPath);
    const exports = require(resolvedPath);
    const module = this.moduleCache[resolvedPath] || {
      id: resolvedPath,
      filename: resolvedPath,
      exports,
      loaded: true,
      children: [],
      paths: [],
    };

    return { exports, module };
  }

  /**
   * Alias for runFile (backward compatibility)
   */
  runFileSync = this.runFile;

  /**
   * Run a file from the virtual file system (async - for IRuntime interface)
   */
  async runFileAsync(filename: string): Promise<IExecuteResult> {
    return Promise.resolve(this.runFile(filename));
  }

  /**
   * Clear the module cache
   */
  clearCache(): void {
    this.moduleCache = {};
  }

  /**
   * Get the virtual file system
   */
  getVFS(): VirtualFS {
    return this.vfs;
  }

  /**
   * Get the process object
   */
  getProcess(): Process {
    return this.process;
  }

  /**
   * Create a REPL context that evaluates expressions and persists state.
   *
   * Returns an object with an `eval` method that:
   * - Returns the value of the last expression (unlike `execute` which returns module.exports)
   * - Persists variables between calls (`var x = 1` then `x` works)
   * - Has access to `require`, `console`, `process`, `Buffer` (same as execute)
   *
   * Security: The eval runs inside a Generator's local scope via direct eval,
   * NOT in the global scope. Only the runtime's own require/console/process are
   * exposed — the same sandbox boundary as execute(). Variables created in the
   * REPL are confined to the generator's closure and cannot leak to the page.
   *
   * Note: `const`/`let` are transformed to `var` so they persist across calls
   * (var hoists to the generator's function scope, const/let are block-scoped
   * to each eval call and would be lost).
   */
  createREPL(): { eval: (code: string) => unknown } {
    const require = createRequire(
      this.vfs,
      this.fsShim,
      this.process,
      '/',
      this.moduleCache,
      this.options,
      this.processedCodeCache,
      this.bunModule
    );
    const consoleWrapper = createConsoleWrapper(this.options.onConsole);
    const process = this.process;
    const buffer = bufferShim.Buffer;
    const bun = this.bunModule;

    // Use a Generator to maintain a persistent eval scope.
    // Generator functions preserve their local scope across yields, so
    // var declarations from eval() persist between calls. Direct eval
    // runs in the generator's scope (not global), providing isolation.
    const GeneratorFunction = Object.getPrototypeOf(function* () {}).constructor;
    const replGen = new GeneratorFunction(
      'require',
      'console',
      'process',
      'Buffer',
      'Bun',
      `var __code, __result;
globalThis.Bun = Bun;
while (true) {
  __code = yield;
  try {
    __result = eval(__code);
    yield { value: __result, error: null };
  } catch (e) {
    yield { value: undefined, error: e };
  }
}`
    )(require, consoleWrapper, process, buffer, bun);
    replGen.next(); // prime the generator

    return {
      eval(code: string): unknown {
        // Transform const/let to var for persistence across REPL calls.
        // var declarations in direct eval are added to the enclosing function
        // scope (the generator), so they survive across yields.
        const transformed = code.replace(/^\s*(const|let)\s+/gm, 'var ');

        // Try as expression first (wrapping in parens), fall back to statement.
        // replGen.next(code) sends code to the generator, which evals it and
        // yields the result — so the result is in the return value of .next().
        const exprResult = replGen.next('(' + transformed + ')').value as { value: unknown; error: unknown };
        if (!exprResult.error) {
          // Advance past the wait-for-code yield so it's ready for next call
          replGen.next();
          return exprResult.value;
        }

        // Expression parse failed — advance past wait-for-code, then try as statement
        replGen.next();
        const stmtResult = replGen.next(transformed).value as { value: unknown; error: unknown };
        if (stmtResult.error) {
          replGen.next(); // advance past wait-for-code yield
          throw stmtResult.error;
        }
        replGen.next(); // advance past wait-for-code yield
        return stmtResult.value;
      },
    };
  }
}

/**
 * Create and execute code in a new runtime (synchronous - backward compatible)
 */
export function execute(
  code: string,
  vfs: VirtualFS,
  options?: RuntimeOptions
): { exports: unknown; module: Module } {
  const runtime = new Runtime(vfs, options);
  return runtime.execute(code);
}

// Re-export types
export type { IRuntime, IExecuteResult, IRuntimeOptions } from './runtime-interface';

export default Runtime;
