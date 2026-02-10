/**
 * ESM to CJS Transformer using esbuild-wasm
 *
 * Transforms ES modules to CommonJS format during npm install,
 * so require() can work synchronously.
 */

import { VirtualFS } from './virtual-fs';

// Check if we're in a browser environment
const isBrowser = typeof window !== 'undefined';
type NodeEsbuild = {
  transformSync: (code: string, options: Record<string, unknown>) => { code: string };
};

let nodeEsbuild: NodeEsbuild | null = null;
let nodeEsbuildPromise: Promise<NodeEsbuild | null> | null = null;

const DYNAMIC_BUILTIN_MODULES = [
  // Node built-ins
  'assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram', 'dns',
  'events', 'fs', 'http', 'http2', 'https', 'net', 'os', 'path', 'perf_hooks',
  'querystring', 'readline', 'stream', 'string_decoder', 'timers', 'tls',
  'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib', 'async_hooks', 'inspector', 'module',
  // Bun built-ins
  'bun', 'bun:sqlite', 'bun:test', 'bun:ffi', 'bun:jsc',
];

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function patchDynamicBuiltinImports(code: string): string {
  let transformed = code;

  // Convert dynamic import() of node: modules to require()
  transformed = transformed.replace(
    /\bimport\s*\(\s*["']node:([^"']+)["']\s*\)/g,
    'Promise.resolve(require("node:$1"))'
  );

  for (const builtin of DYNAMIC_BUILTIN_MODULES) {
    // Match import("fs") or import('fs') but not import("fs-extra")
    const pattern = new RegExp(`\\bimport\\s*\\(\\s*["']${escapeRegExp(builtin)}["']\\s*\\)`, 'g');
    transformed = transformed.replace(pattern, `Promise.resolve(require("${builtin}"))`);
  }

  return transformed;
}

// Window.__esbuild type is declared in src/types/external.d.ts

async function loadNodeEsbuild(): Promise<NodeEsbuild | null> {
  if (isBrowser) {
    return null;
  }

  if (nodeEsbuild) {
    return nodeEsbuild;
  }

  if (nodeEsbuildPromise) {
    return nodeEsbuildPromise;
  }

  nodeEsbuildPromise = (async () => {
    try {
      const specifier = 'esbuild';
      let mod: { default?: unknown } | null = null;

      try {
        // Variable specifier avoids eager bundling while still working in Node/Vitest.
        mod = await import(
          /* @vite-ignore */
          specifier
        ) as { default?: unknown };
      } catch {
        // Fallback for runtimes where direct dynamic import is restricted.
        const dynamicImport = new Function(
          's',
          'return import(s);'
        ) as (s: string) => Promise<unknown>;
        mod = await dynamicImport(specifier) as { default?: unknown };
      }

      const candidate = (mod.default || mod) as {
        transformSync?: (code: string, options: Record<string, unknown>) => { code: string };
      };
      if (candidate && typeof candidate.transformSync === 'function') {
        nodeEsbuild = {
          transformSync: candidate.transformSync.bind(candidate),
        };
      } else {
        nodeEsbuild = null;
      }
    } catch {
      nodeEsbuild = null;
    } finally {
      nodeEsbuildPromise = null;
    }

    return nodeEsbuild;
  })();

  return nodeEsbuildPromise;
}

/**
 * Initialize esbuild-wasm (reuses existing instance if already initialized)
 */
export async function initTransformer(): Promise<void> {
  // Skip in non-browser environments (tests)
  if (!isBrowser) {
    console.log('[transform] Skipping esbuild init (not in browser)');
    return;
  }

  // Reuse existing esbuild instance from window (may have been initialized by next-dev-server)
  if (window.__esbuild) {
    console.log('[transform] Reusing existing esbuild instance');
    return;
  }

  // If another init is in progress, wait for it
  if (window.__esbuildInitPromise) {
    return window.__esbuildInitPromise;
  }

  window.__esbuildInitPromise = (async () => {
    try {
      console.log('[transform] Loading esbuild-wasm...');

      // Load esbuild-wasm from CDN
      const mod = await import(
        /* @vite-ignore */
        'https://esm.sh/esbuild-wasm@0.20.0'
      );

      // esm.sh wraps the module - get the actual esbuild object
      const esbuildMod = mod.default || mod;

      try {
        await esbuildMod.initialize({
          wasmURL: 'https://unpkg.com/esbuild-wasm@0.20.0/esbuild.wasm',
        });
        console.log('[transform] esbuild-wasm initialized');
      } catch (initError) {
        // Handle "already initialized" error gracefully
        if (initError instanceof Error && initError.message.includes('Cannot call "initialize" more than once')) {
          console.log('[transform] esbuild-wasm already initialized, reusing');
        } else {
          throw initError;
        }
      }

      window.__esbuild = esbuildMod;
    } catch (error) {
      console.error('[transform] Failed to initialize esbuild:', error);
      window.__esbuildInitPromise = undefined;
      throw error;
    }
  })();

  return window.__esbuildInitPromise;
}

/**
 * Check if transformer is ready
 */
export function isTransformerReady(): boolean {
  // In non-browser, we skip transformation
  if (!isBrowser) return true;
  return window.__esbuild !== undefined;
}

/**
 * Transform a single file from ESM to CJS
 */
export async function transformFile(
  code: string,
  filename: string
): Promise<string> {
  // Determine loader based on file extension
  let loader: 'js' | 'jsx' | 'ts' | 'tsx' = 'js';
  if (filename.endsWith('.jsx')) loader = 'jsx';
  else if (filename.endsWith('.ts') || filename.endsWith('.mts') || filename.endsWith('.cts')) loader = 'ts';
  else if (filename.endsWith('.tsx')) loader = 'tsx';
  else if (filename.endsWith('.mjs') || filename.endsWith('.cjs')) loader = 'js';

  // Node/test fallback: use native esbuild when available.
  if (!isBrowser) {
    const esbuild = await loadNodeEsbuild();
    if (!esbuild) {
      return code;
    }

    try {
      const result = esbuild.transformSync(code, {
        loader,
        format: 'cjs',
        target: 'esnext',
        platform: 'neutral',
        define: {
          'import.meta.url': 'import_meta.url',
          'import.meta.dirname': 'import_meta.dirname',
          'import.meta.filename': 'import_meta.filename',
          'import.meta': 'import_meta',
        },
      });

      return patchDynamicBuiltinImports(result.code);
    } catch {
      return code;
    }
  }

  if (!window.__esbuild) {
    await initTransformer();
  }

  const esbuild = window.__esbuild;
  if (!esbuild) {
    throw new Error('esbuild not initialized');
  }

  try {
    const result = await esbuild.transform(code, {
      loader,
      format: 'cjs',
      target: 'esnext',
      platform: 'neutral',
      // Replace import.meta with our runtime-provided variable
      // This is the proper esbuild way to handle import.meta in CJS
      define: {
        'import.meta.url': 'import_meta.url',
        'import.meta.dirname': 'import_meta.dirname',
        'import.meta.filename': 'import_meta.filename',
        'import.meta': 'import_meta',
      },
    });

    let transformed = result.code;

    transformed = patchDynamicBuiltinImports(transformed);

    return transformed;
  } catch (error: unknown) {
    // Check if it's a top-level await error - these files are usually CLI entry points
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg.includes('Top-level await')) {
      console.log(`[transform] Skipping ${filename} (has top-level await, likely CLI entry point)`);
      // Return original code - it won't be require()'d directly anyway
      return code;
    }

    console.warn(`[transform] Failed to transform ${filename}:`, error);
    // Return original code if transform fails
    return code;
  }
}

/**
 * Check if a file needs ESM to CJS transformation
 */
function needsTransform(filename: string, code: string): boolean {
  // TypeScript files should always be transpiled.
  if (
    filename.endsWith('.ts') ||
    filename.endsWith('.tsx') ||
    filename.endsWith('.mts') ||
    filename.endsWith('.cts')
  ) {
    return true;
  }

  // .mjs files are always ESM
  if (filename.endsWith('.mjs')) {
    return true;
  }

  // .cjs files are always CJS
  if (filename.endsWith('.cjs')) {
    return false;
  }

  // Check for ESM syntax
  const hasImport = /\bimport\s+[\w{*'"]/m.test(code);
  const hasExport = /\bexport\s+(?:default|const|let|var|function|class|{|\*)/m.test(code);
  const hasImportMeta = /\bimport\.meta\b/.test(code);

  return hasImport || hasExport || hasImportMeta;
}

/**
 * Check if a file has dynamic imports that need patching
 */
function hasDynamicNodeImports(code: string): boolean {
  // Check for import("node:...") or import('node:...')
  if (/\bimport\s*\(\s*["']node:/.test(code)) {
    return true;
  }

  for (const builtin of DYNAMIC_BUILTIN_MODULES) {
    const pattern = new RegExp(`\\bimport\\s*\\(\\s*["']${escapeRegExp(builtin)}["']\\s*\\)`);
    if (pattern.test(code)) {
      return true;
    }
  }

  return false;
}

/**
 * Patch dynamic imports in already-CJS code (e.g., pre-bundled packages)
 */
function patchDynamicImports(code: string): string {
  return patchDynamicBuiltinImports(code);
}

/**
 * Transform all ESM files in a package directory to CJS
 */
export async function transformPackage(
  vfs: VirtualFS,
  pkgPath: string,
  onProgress?: (msg: string) => void
): Promise<number> {
  let transformedCount = 0;

  // Find all JS files in the package
  const jsFiles = findJsFiles(vfs, pkgPath);

  onProgress?.(`  Transforming ${jsFiles.length} files in ${pkgPath}...`);

  // Transform files in batches
  const BATCH_SIZE = 10;
  for (let i = 0; i < jsFiles.length; i += BATCH_SIZE) {
    const batch = jsFiles.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async (filePath) => {
        try {
          const code = vfs.readFileSync(filePath, 'utf8');

          if (needsTransform(filePath, code)) {
            // Full ESM to CJS transformation
            const transformed = await transformFile(code, filePath);
            vfs.writeFileSync(filePath, transformed);
            transformedCount++;
          } else if (hasDynamicNodeImports(code)) {
            // Just patch dynamic imports in already-CJS code
            const patched = patchDynamicImports(code);
            vfs.writeFileSync(filePath, patched);
            transformedCount++;
          }
        } catch (error) {
          // Skip files that can't be read/transformed
          console.warn(`[transform] Skipping ${filePath}:`, error);
        }
      })
    );
  }

  return transformedCount;
}

/**
 * Find all JavaScript files in a directory recursively
 */
function findJsFiles(vfs: VirtualFS, dir: string): string[] {
  const files: string[] = [];

  try {
    const entries = vfs.readdirSync(dir);

    for (const entry of entries) {
      const fullPath = dir + '/' + entry;

      try {
        const stat = vfs.statSync(fullPath);

        if (stat.isDirectory()) {
          // Skip node_modules inside packages (nested deps)
          if (entry !== 'node_modules') {
            files.push(...findJsFiles(vfs, fullPath));
          }
        } else if (
          entry.endsWith('.js') ||
          entry.endsWith('.mjs') ||
          entry.endsWith('.cjs') ||
          entry.endsWith('.jsx') ||
          (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) ||
          entry.endsWith('.mts') ||
          entry.endsWith('.cts') ||
          entry.endsWith('.tsx')
        ) {
          files.push(fullPath);
        }
      } catch {
        // Skip files we can't stat
      }
    }
  } catch {
    // Skip directories we can't read
  }

  return files;
}
