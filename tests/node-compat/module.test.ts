/**
 * Node.js module module compatibility tests
 *
 * Adapted from: https://github.com/nodejs/node/blob/main/test/parallel/test-module-*.js
 */

import { describe, it, expect, vi } from 'vitest';
import moduleShim, {
  createRequire,
  builtinModules,
  isBuiltin,
  _cache,
  _extensions,
  _pathCache,
  syncBuiltinESMExports,
  Module,
  __setRuntimeHooks,
  __setMockFiles,
  __clearMockFiles,
} from '../../src/shims/module';
import { assert } from './common';

describe('module module (Node.js compat)', () => {
  describe('exports', () => {
    it('should export createRequire and isBuiltin', () => {
      expect(typeof createRequire).toBe('function');
      expect(typeof isBuiltin).toBe('function');
    });

    it('should export builtinModules array', () => {
      expect(Array.isArray(builtinModules)).toBe(true);
      expect(builtinModules.length).toBeGreaterThan(0);
    });

    it('should export internal caches and extension map', () => {
      expect(typeof _cache).toBe('object');
      expect(typeof _extensions).toBe('object');
      expect(typeof _pathCache).toBe('object');
    });

    it('should export syncBuiltinESMExports', () => {
      expect(typeof syncBuiltinESMExports).toBe('function');
    });
  });

  describe('createRequire()', () => {
    it('should return a require function', () => {
      const requireFn = createRequire('/app/index.js');
      expect(typeof requireFn).toBe('function');
    });

    it('returned require should throw module-not-found style error', () => {
      const requireFn = createRequire('/app/index.js');
      assert.throws(() => requireFn('left-pad'), /Cannot find module 'left-pad' from '\/app\/index\.js'/);
    });
  });

  describe('builtinModules and isBuiltin()', () => {
    it('should include key core modules', () => {
      expect(builtinModules).toContain('fs');
      expect(builtinModules).toContain('path');
      expect(builtinModules).toContain('http');
      expect(builtinModules).toContain('worker_threads');
      expect(builtinModules).toContain('v8');
    });

    it('isBuiltin() should return true for listed builtins', () => {
      assert.strictEqual(isBuiltin('fs'), true);
      assert.strictEqual(isBuiltin('path'), true);
      assert.strictEqual(isBuiltin('worker_threads'), true);
    });

    it('isBuiltin() should support node: prefix', () => {
      assert.strictEqual(isBuiltin('node:fs'), true);
      assert.strictEqual(isBuiltin('node:path'), true);
    });

    it('isBuiltin() should return false for non-builtins', () => {
      assert.strictEqual(isBuiltin('left-pad'), false);
      assert.strictEqual(isBuiltin('./local-module'), false);
    });
  });

  describe('internal structures', () => {
    it('should expose default extension handlers', () => {
      expect(typeof _extensions['.js']).toBe('function');
      expect(typeof _extensions['.json']).toBe('function');
      expect(typeof _extensions['.node']).toBe('function');
    });

    it('syncBuiltinESMExports() should be callable', () => {
      assert.doesNotThrow(() => syncBuiltinESMExports());
    });
  });

  describe('Module export object', () => {
    it('should expose same APIs as named exports', () => {
      expect(Module.createRequire).toBe(createRequire);
      expect(Module.builtinModules).toBe(builtinModules);
      expect(Module.isBuiltin).toBe(isBuiltin);
      expect(Module._cache).toBe(_cache);
      expect(Module._extensions).toBe(_extensions);
      expect(Module._pathCache).toBe(_pathCache);
      expect(Module.syncBuiltinESMExports).toBe(syncBuiltinESMExports);
    });

    it('default export should match Module object', () => {
      expect(moduleShim).toBe(Module);
    });
  });

  describe('createRequire/module loading', () => {
    it('createRequire should resolve and load local module graph', () => {
      __clearMockFiles();
      __setMockFiles({
        '/app/dep.js': 'module.exports = { value: 42 };',
      });
      const requireFn = createRequire('/app/index.js');
      expect(requireFn('./dep')).toEqual({ value: 42 });
      __clearMockFiles();
    });

    it('Module._extensions handlers should parse/execute file contents', () => {
      __clearMockFiles();
      __setMockFiles({
        '/app/file.js': 'module.exports.value = 1;',
      });
      const jsHandler = _extensions['.js'];
      const mod = new Module('/app/file.js');
      jsHandler(mod, '/app/file.js');
      expect((mod.exports as { value: number }).value).toBe(1);
      __clearMockFiles();
    });

    it('runtime delegated require should preserve runtime cache/main', () => {
      const runtimeCache = { '/app/index.js': new Module('/app/index.js') };
      const delegated = vi.fn((id: string) => ({ id })) as unknown as ReturnType<typeof createRequire>;
      delegated.cache = runtimeCache;
      delegated.main = runtimeCache['/app/index.js'];

      __setRuntimeHooks({
        createRequire: () => delegated,
      });

      const requireFn = createRequire('/app/index.js');
      expect(requireFn).toBe(delegated);
      expect(requireFn.cache).toBe(runtimeCache);
      expect(requireFn.main).toBe(runtimeCache['/app/index.js']);
      expect(requireFn('dep')).toEqual({ id: 'dep' });

      __setRuntimeHooks(null);
    });
  });
});
