import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime, execute } from '../src/runtime';

describe('Runtime', () => {
  let vfs: VirtualFS;
  let runtime: Runtime;

  beforeEach(() => {
    vfs = new VirtualFS();
    runtime = new Runtime(vfs);
  });

  describe('basic execution', () => {
    it('should execute simple code', () => {
      const { exports } = runtime.execute('module.exports = 42;');
      expect(exports).toBe(42);
    });

    it('should provide __filename and __dirname', () => {
      const { exports } = runtime.execute(`
        module.exports = { filename: __filename, dirname: __dirname };
      `, '/test/file.js');
      expect(exports).toEqual({
        filename: '/test/file.js',
        dirname: '/test',
      });
    });

    it('should handle exports object', () => {
      const { exports } = runtime.execute(`
        exports.foo = 'bar';
        exports.num = 123;
      `);
      expect(exports).toEqual({ foo: 'bar', num: 123 });
    });

    it('should handle module.exports object', () => {
      const { exports } = runtime.execute(`
        module.exports = { hello: 'world' };
      `);
      expect(exports).toEqual({ hello: 'world' });
    });

    it('should expose global setImmediate/clearImmediate', () => {
      const { exports } = runtime.execute(`
        module.exports = {
          hasSetImmediate: typeof setImmediate === 'function',
          hasClearImmediate: typeof clearImmediate === 'function',
        };
      `);

      expect(exports).toEqual({
        hasSetImmediate: true,
        hasClearImmediate: true,
      });
    });

    it('should run callbacks scheduled via global setImmediate', async () => {
      runtime.execute(`
        globalThis.__runtimeImmediateFlag = false;
        setImmediate(() => {
          globalThis.__runtimeImmediateFlag = true;
        });
      `);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const { exports } = runtime.execute(`
        module.exports = globalThis.__runtimeImmediateFlag;
      `);

      expect(exports).toBe(true);
    });
  });

  describe('fs shim', () => {
    it('should provide fs module', () => {
      const { exports } = runtime.execute(`
        const fs = require('fs');
        module.exports = typeof fs.readFileSync;
      `);
      expect(exports).toBe('function');
    });

    it('should read and write files', () => {
      runtime.execute(`
        const fs = require('fs');
        fs.writeFileSync('/output.txt', 'hello from script');
      `);

      expect(vfs.readFileSync('/output.txt', 'utf8')).toBe('hello from script');
    });

    it('should check file existence', () => {
      vfs.writeFileSync('/exists.txt', 'content');

      const { exports } = runtime.execute(`
        const fs = require('fs');
        module.exports = {
          exists: fs.existsSync('/exists.txt'),
          notExists: fs.existsSync('/nonexistent.txt'),
        };
      `);

      expect(exports).toEqual({ exists: true, notExists: false });
    });

    it('should create directories', () => {
      runtime.execute(`
        const fs = require('fs');
        fs.mkdirSync('/mydir');
        fs.mkdirSync('/deep/nested/dir', { recursive: true });
      `);

      expect(vfs.existsSync('/mydir')).toBe(true);
      expect(vfs.existsSync('/deep/nested/dir')).toBe(true);
    });

    it('should list directory contents', () => {
      vfs.writeFileSync('/dir/a.txt', '');
      vfs.writeFileSync('/dir/b.txt', '');

      const { exports } = runtime.execute(`
        const fs = require('fs');
        module.exports = fs.readdirSync('/dir').sort();
      `);

      expect(exports).toEqual(['a.txt', 'b.txt']);
    });
  });

  describe('constants shim', () => {
    it('should provide constants module', () => {
      const { exports } = runtime.execute(`
        const constants = require('constants');
        module.exports = {
          fOk: constants.F_OK,
          rOk: constants.R_OK,
          sigint: constants.SIGINT,
        };
      `);

      expect(exports).toEqual({
        fOk: 0,
        rOk: 4,
        sigint: 2,
      });
    });

    it('should support node:constants protocol', () => {
      const { exports } = runtime.execute(`
        const constants = require('node:constants');
        module.exports = constants.W_OK;
      `);

      expect(exports).toBe(2);
    });
  });

  describe('path shim', () => {
    it('should provide path module', () => {
      const { exports } = runtime.execute(`
        const path = require('path');
        module.exports = {
          join: path.join('/foo', 'bar', 'baz'),
          dirname: path.dirname('/foo/bar/file.js'),
          basename: path.basename('/foo/bar/file.js'),
          extname: path.extname('/foo/bar/file.js'),
        };
      `);

      expect(exports).toEqual({
        join: '/foo/bar/baz',
        dirname: '/foo/bar',
        basename: 'file.js',
        extname: '.js',
      });
    });

    it('should resolve paths', () => {
      const { exports } = runtime.execute(`
        const path = require('path');
        module.exports = path.resolve('/foo/bar', '../baz', 'file.js');
      `);

      expect(exports).toBe('/foo/baz/file.js');
    });
  });

  describe('process shim', () => {
    it('should provide process object', () => {
      const { exports } = runtime.execute(`
        module.exports = {
          cwd: process.cwd(),
          platform: process.platform,
          arch: process.arch,
          hasEnv: typeof process.env === 'object',
        };
      `);

      expect(exports).toEqual({
        cwd: '/',
        platform: 'linux', // Pretend to be linux for Node.js compatibility
        arch: 'x64',
        hasEnv: true,
      });
    });

    it('should provide process via require', () => {
      const { exports } = runtime.execute(`
        const proc = require('process');
        module.exports = proc.cwd();
      `);

      expect(exports).toBe('/');
    });

    it('should expose process.release.name', () => {
      const { exports } = runtime.execute(`
        module.exports = process.release && process.release.name;
      `);

      expect(exports).toBe('node');
    });

    it('should have EventEmitter methods on process', () => {
      const { exports } = runtime.execute(`
        let called = false;
        process.once('test-event', (arg) => {
          called = arg;
        });
        process.emit('test-event', 'hello');
        module.exports = {
          called,
          hasOn: typeof process.on === 'function',
          hasOnce: typeof process.once === 'function',
          hasEmit: typeof process.emit === 'function',
          hasOff: typeof process.off === 'function',
        };
      `);

      expect(exports).toEqual({
        called: 'hello',
        hasOn: true,
        hasOnce: true,
        hasEmit: true,
        hasOff: true,
      });
    });

    it('should allow custom environment variables', () => {
      const customRuntime = new Runtime(vfs, {
        env: { MY_VAR: 'my_value', NODE_ENV: 'test' },
      });

      const { exports } = customRuntime.execute(`
        module.exports = {
          myVar: process.env.MY_VAR,
          nodeEnv: process.env.NODE_ENV,
        };
      `);

      expect(exports).toEqual({
        myVar: 'my_value',
        nodeEnv: 'test',
      });
    });
  });

  describe('module resolution', () => {
    it('should provide node:wasi shim', () => {
      const { exports } = runtime.execute(`
        const { WASI } = require('node:wasi');
        const wasi = new WASI({
          version: 'preview1',
          args: [],
          env: {},
          preopens: { '/': '/' },
        });
        module.exports = {
          hasClass: typeof WASI === 'function',
          hasGetImportObject: typeof wasi.getImportObject === 'function',
        };
      `);

      expect(exports).toEqual({
        hasClass: true,
        hasGetImportObject: true,
      });
    });

    it('allows native-addon fallback patterns when .node loading fails', () => {
      vfs.mkdirSync('/native', { recursive: true });
      vfs.writeFileSync(
        '/native/index.js',
        `
        let binding;
        try {
          binding = require('./addon.node');
        } catch (_err) {
          binding = require('./fallback.js');
        }
        module.exports = binding;
        `
      );
      // Simulate a binary addon payload that is not valid JS in browser runtime.
      vfs.writeFileSync('/native/addon.node', '\u007fELF\\u0002\\u0001\\u0001');
      vfs.writeFileSync('/native/fallback.js', 'module.exports = { mode: "fallback" };');

      const { exports } = runtime.execute(`
        module.exports = require('./native');
      `);

      expect(exports).toEqual({ mode: 'fallback' });
    });

    it('provides sqlite3 fallback shim for native package imports', () => {
      const { exports } = runtime.execute(`
        const sqlite3 = require('sqlite3');
        const db = new sqlite3.Database(':memory:');
        db.exec('CREATE TABLE users (id INT, name TEXT)');
        const runResult = db.run('INSERT INTO users VALUES (?, ?)', 1, 'Ada');
        module.exports = {
          hasDatabase: typeof sqlite3.Database === 'function',
          verbose: typeof sqlite3.verbose === 'function',
          runReturnsDatabase: runResult === db,
        };
      `);

      expect(exports).toEqual({
        hasDatabase: true,
        verbose: true,
        runReturnsDatabase: true,
      });
    });

    it('provides better-sqlite3 fallback shim for native package imports', () => {
      const { exports } = runtime.execute(`
        const Database = require('better-sqlite3');
        const db = new Database(':memory:');
        db.exec('CREATE TABLE users (id INT, name TEXT)');
        const insert = db.prepare('INSERT INTO users VALUES (?, ?)');
        insert.run(1, 'Grace');
        const row = db.prepare('SELECT name FROM users WHERE id = ?').get(1);
        module.exports = {
          hasPrepare: typeof db.prepare === 'function',
          row: row && row.name,
        };
      `);

      expect(exports).toEqual({
        hasPrepare: true,
        row: 'Grace',
      });
    });

    it('does not hijack sqlite3 subpath imports when real files exist', () => {
      vfs.writeFileSync(
        '/node_modules/sqlite3/package.json',
        JSON.stringify({
          name: 'sqlite3',
          version: '9.9.9-test',
        })
      );

      const { exports } = runtime.execute(`
        module.exports = require('sqlite3/package.json');
      `);

      expect(exports).toMatchObject({
        name: 'sqlite3',
        version: '9.9.9-test',
      });
    });

    it('applies sqlite fallback after native addon runtime errors on resolved node_modules paths', () => {
      vfs.writeFileSync(
        '/node_modules/sqlite3/index.js',
        'throw new Error("Native addons are not supported in this runtime");'
      );

      const { exports } = runtime.execute(`
        module.exports = require('/node_modules/sqlite3/index.js');
      `);

      expect(exports).toMatchObject({
        Database: expect.any(Function),
      });
    });

    it('should resolve relative modules', () => {
      vfs.writeFileSync('/lib/helper.js', 'module.exports = { value: 42 };');

      const { exports } = runtime.execute(`
        const helper = require('./lib/helper');
        module.exports = helper.value;
      `);

      expect(exports).toBe(42);
    });

    it('should resolve modules with .js extension', () => {
      vfs.writeFileSync('/lib/mod.js', 'module.exports = "found";');

      const { exports } = runtime.execute(`
        module.exports = require('./lib/mod.js');
      `);

      expect(exports).toBe('found');
    });

    it('should resolve modules without extension', () => {
      vfs.writeFileSync('/lib/noext.js', 'module.exports = "no ext";');

      const { exports } = runtime.execute(`
        module.exports = require('./lib/noext');
      `);

      expect(exports).toBe('no ext');
    });

    it('should execute shebang-prefixed modules', () => {
      vfs.writeFileSync('/dep.mjs', 'export default 42;');
      vfs.writeFileSync(
        '/script.mjs',
        '#!/usr/bin/env node\nimport value from "./dep.mjs";\nmodule.exports = value;\n'
      );

      const { exports } = runtime.runFile('/script.mjs');
      expect(exports).toBe(42);
    });

    it('should support export async function in ESM fallback transforms', () => {
      vfs.mkdirSync('/esm', { recursive: true });
      vfs.writeFileSync('/esm/async-export.mjs', 'export async function loadApp() { return "ok"; }');

      const { exports } = runtime.execute(`
        const mod = require('./esm/async-export.mjs');
        module.exports = typeof mod.loadApp;
      `);

      expect(exports).toBe('function');
    });

    it('should support re-export syntax in ESM fallback transforms', () => {
      vfs.mkdirSync('/esm', { recursive: true });
      vfs.writeFileSync('/esm/base.mjs', 'export const value = 7;');
      vfs.writeFileSync('/esm/re-export.mjs', 'export { value } from "./base.mjs";');

      const { exports } = runtime.execute(`
        const mod = require('./esm/re-export.mjs');
        module.exports = mod.value;
      `);

      expect(exports).toBe(7);
    });

    it('should resolve TypeScript modules without extension', () => {
      vfs.writeFileSync('/lib/noext-ts.ts', 'module.exports = "no ext ts";');

      const { exports } = runtime.execute(`
        module.exports = require('./lib/noext-ts');
      `);

      expect(exports).toBe('no ext ts');
    });

    it('should resolve tsconfig path aliases', () => {
      vfs.writeFileSync(
        '/tsconfig.json',
        JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
            paths: {
              '@/*': ['src/*'],
            },
          },
        })
      );
      vfs.writeFileSync('/src/shared/constants.ts', 'export const VALUE = 42;');

      const { exports } = runtime.execute(
        `
        const constants = require('@/shared/constants');
        module.exports = constants.VALUE;
      `,
        '/src/app.ts'
      );

      expect(exports).toBe(42);
    });

    it('should resolve package.json via tsconfig baseUrl', () => {
      vfs.writeFileSync(
        '/tsconfig.json',
        JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
          },
        })
      );
      vfs.writeFileSync('/package.json', JSON.stringify({ name: 'demo-app' }));

      const { exports } = runtime.execute(
        `
        module.exports = require('package.json').name;
      `,
        '/src/app.ts'
      );

      expect(exports).toBe('demo-app');
    });

    it('should resolve JSON modules', () => {
      vfs.writeFileSync('/data.json', '{"key": "value", "num": 123}');

      const { exports } = runtime.execute(`
        const data = require('./data.json');
        module.exports = data;
      `);

      expect(exports).toEqual({ key: 'value', num: 123 });
    });

    it('should resolve directory with index.js', () => {
      vfs.writeFileSync('/lib/index.js', 'module.exports = "from index";');

      const { exports } = runtime.execute(`
        module.exports = require('./lib');
      `);

      expect(exports).toBe('from index');
    });

    it('should resolve require(".") to the current directory index', () => {
      vfs.writeFileSync('/pkg/index.js', 'module.exports = "pkg-index";');
      vfs.writeFileSync('/pkg/entry.js', 'module.exports = require(".");');

      const { exports } = runtime.runFile('/pkg/entry.js');
      expect(exports).toBe('pkg-index');
    });

    it('should resolve node_modules packages', () => {
      vfs.writeFileSync(
        '/node_modules/my-pkg/package.json',
        '{"name": "my-pkg", "main": "main.js"}'
      );
      vfs.writeFileSync(
        '/node_modules/my-pkg/main.js',
        'module.exports = "from package";'
      );

      const { exports } = runtime.execute(`
        module.exports = require('my-pkg');
      `);

      expect(exports).toBe('from package');
    });

    it('should resolve node_modules with index.js fallback', () => {
      vfs.writeFileSync(
        '/node_modules/simple-pkg/index.js',
        'module.exports = "simple";'
      );

      const { exports } = runtime.execute(`
        module.exports = require('simple-pkg');
      `);

      expect(exports).toBe('simple');
    });

    it('should resolve package exports preferring require/default over browser for subpaths', () => {
      vfs.writeFileSync(
        '/node_modules/cond-pkg/package.json',
        JSON.stringify({
          name: 'cond-pkg',
          exports: {
            '.': {
              require: './require.js',
              browser: './browser.js',
              default: './default.js',
            },
            './feature': {
              require: './feature-require.js',
              browser: './feature-browser.js',
              default: './feature-default.js',
            },
          },
        })
      );
      vfs.writeFileSync('/node_modules/cond-pkg/require.js', 'module.exports = "require-root";');
      vfs.writeFileSync('/node_modules/cond-pkg/browser.js', 'module.exports = "browser-root";');
      vfs.writeFileSync('/node_modules/cond-pkg/default.js', 'module.exports = "default-root";');
      vfs.writeFileSync('/node_modules/cond-pkg/feature-require.js', 'module.exports = "require-feature";');
      vfs.writeFileSync('/node_modules/cond-pkg/feature-browser.js', 'module.exports = "browser-feature";');
      vfs.writeFileSync('/node_modules/cond-pkg/feature-default.js', 'module.exports = "default-feature";');

      const { exports } = runtime.execute(`
        module.exports = {
          root: require('cond-pkg'),
          feature: require('cond-pkg/feature'),
        };
      `);

      expect(exports).toEqual({
        root: 'require-root',
        feature: 'require-feature',
      });
    });

    it('should resolve workspace packages when they are not linked into node_modules', () => {
      vfs.writeFileSync(
        '/repo/package.json',
        JSON.stringify({
          name: 'workspace-root',
          private: true,
          workspaces: ['./packages/*'],
        })
      );
      vfs.writeFileSync(
        '/repo/packages/shared/package.json',
        JSON.stringify({
          name: '@demo/shared',
          main: 'src/index.js',
          exports: {
            '.': './src/index.js',
          },
        })
      );
      vfs.writeFileSync('/repo/packages/shared/src/index.js', 'module.exports = { shared: "ok" };');
      vfs.writeFileSync('/repo/apps/web/entry.js', 'module.exports = require("@demo/shared");');

      const workspaceRuntime = new Runtime(vfs, { cwd: '/repo/apps/web' });
      const { exports } = workspaceRuntime.runFile('/repo/apps/web/entry.js');

      expect(exports).toEqual({ shared: 'ok' });
    });

    it('should fall back to browser export when package only exposes browser condition', () => {
      vfs.writeFileSync(
        '/node_modules/browser-only-pkg/package.json',
        JSON.stringify({
          name: 'browser-only-pkg',
          exports: {
            '.': {
              browser: './browser.js',
            },
          },
        })
      );
      vfs.writeFileSync('/node_modules/browser-only-pkg/browser.js', 'module.exports = "browser-only";');

      const { exports } = runtime.execute(`
        module.exports = require('browser-only-pkg');
      `);

      expect(exports).toBe('browser-only');
    });

    it('should not transform bundled CJS files that contain import/export text in templates', () => {
      vfs.writeFileSync(
        '/node_modules/template-pkg/package.json',
        '{"name": "template-pkg", "main": "index.js"}'
      );
      vfs.writeFileSync(
        '/node_modules/template-pkg/index.js',
        `var __create = Object.create;
module.exports = function () {
  return \`import path from "node:path";
import { fileURLToPath } from "node:url";
export default "x";
\`;
};`
      );

      const { exports } = runtime.execute(`
        const makeCode = require('template-pkg');
        module.exports = makeCode();
      `);

      expect(exports).toContain('import path from "node:path";');
      expect(exports).toContain('export default "x";');
    });

    it('should cache modules', () => {
      vfs.writeFileSync('/counter.js', `
        let count = 0;
        module.exports = { increment: () => ++count, getCount: () => count };
      `);

      const { exports } = runtime.execute(`
        const counter1 = require('./counter');
        const counter2 = require('./counter');
        counter1.increment();
        counter1.increment();
        module.exports = {
          sameInstance: counter1 === counter2,
          count: counter2.getCount(),
        };
      `);

      expect(exports).toEqual({ sameInstance: true, count: 2 });
    });

    it('should throw on missing module', () => {
      expect(() =>
        runtime.execute('require("nonexistent-module");')
      ).toThrow(/Cannot find module/);
    });

    it('should emit deterministic resolve/load trace events', () => {
      const traces: Array<{ type: string; id?: string; resolvedPath?: string; reason?: string }> = [];
      vfs.writeFileSync('/lib/traced.js', 'module.exports = 7;');

      const tracedRuntime = new Runtime(vfs, {
        onTrace: (event) => {
          traces.push({
            type: event.type,
            id: event.id,
            resolvedPath: event.resolvedPath,
            reason: event.reason,
          });
        },
      });

      const { exports } = tracedRuntime.execute(`
        const first = require('./lib/traced');
        const second = require('./lib/traced');
        module.exports = first + second;
      `);
      expect(exports).toBe(14);
      expect(traces.some(event => event.type === 'resolve-cache-miss' && event.id === './lib/traced')).toBe(true);
      expect(traces.some(event => event.type === 'resolve-cache-hit' && event.id === './lib/traced')).toBe(true);
      expect(traces.some(event => event.type === 'load-module-start' && event.resolvedPath === '/lib/traced.js')).toBe(true);
      expect(traces.some(event => event.type === 'load-module-cache-hit' && event.resolvedPath === '/lib/traced.js')).toBe(true);
    });
  });

  describe('console capture', () => {
    it('should capture console output', () => {
      const logs: Array<{ method: string; args: unknown[] }> = [];

      const captureRuntime = new Runtime(vfs, {
        onConsole: (method, args) => logs.push({ method, args }),
      });

      captureRuntime.execute(`
        console.log('hello', 'world');
        console.error('error message');
        console.warn('warning');
      `);

      expect(logs).toContainEqual({ method: 'log', args: ['hello', 'world'] });
      expect(logs).toContainEqual({ method: 'error', args: ['error message'] });
      expect(logs).toContainEqual({ method: 'warn', args: ['warning'] });
    });
  });

  describe('runFile', () => {
    it('should run a file from the virtual file system', () => {
      vfs.writeFileSync('/app.js', 'module.exports = "app output";');

      const { exports } = runtime.runFile('/app.js');

      expect(exports).toBe('app output');
    });
  });

  describe('execute helper function', () => {
    it('should execute code with a new runtime', () => {
      const testVfs = new VirtualFS();
      const { exports } = execute('module.exports = "executed";', testVfs);
      expect(exports).toBe('executed');
    });
  });

  describe('clearCache', () => {
    it('should allow reloading modules after cache clear', () => {
      vfs.writeFileSync('/module.js', 'module.exports = 1;');

      const result1 = runtime.execute('module.exports = require("./module");');
      expect(result1.exports).toBe(1);

      // Modify the file
      vfs.writeFileSync('/module.js', 'module.exports = 2;');

      // Without clearing cache, still returns old value
      const result2 = runtime.execute('module.exports = require("./module");');
      expect(result2.exports).toBe(1);

      // After clearing cache, returns new value
      runtime.clearCache();
      const result3 = runtime.execute('module.exports = require("./module");');
      expect(result3.exports).toBe(2);
    });
  });

  describe('module resolution caching', () => {
    it('should resolve the same module path consistently', () => {
      vfs.writeFileSync('/lib/util.js', 'module.exports = { name: "util" };');

      // First require should resolve and cache the path
      const result1 = runtime.execute(`
        const util1 = require('./lib/util');
        const util2 = require('./lib/util');
        module.exports = util1 === util2;
      `);

      // Both requires should return the same cached module
      expect(result1.exports).toBe(true);
    });

    it('should cache module resolution across multiple files', () => {
      vfs.writeFileSync('/shared.js', 'module.exports = { count: 0 };');
      vfs.writeFileSync('/a.js', `
        const shared = require('./shared');
        shared.count++;
        module.exports = shared;
      `);
      vfs.writeFileSync('/b.js', `
        const shared = require('./shared');
        shared.count++;
        module.exports = shared;
      `);

      const result = runtime.execute(`
        const a = require('./a');
        const b = require('./b');
        module.exports = { aCount: a.count, bCount: b.count, same: a === b };
      `);

      // Both should reference the same cached module
      expect((result.exports as any).same).toBe(true);
      expect((result.exports as any).bCount).toBe(2); // Incremented twice
    });

    it('should handle resolution cache for non-existent modules', () => {
      // First attempt should fail
      expect(() => {
        runtime.execute('require("./nonexistent")');
      }).toThrow(/Cannot find module/);

      // Second attempt should also fail (cached negative result)
      expect(() => {
        runtime.execute('require("./nonexistent")');
      }).toThrow(/Cannot find module/);

      // Now create the module
      vfs.writeFileSync('/nonexistent.js', 'module.exports = "found";');

      // After cache clear, should find the module
      runtime.clearCache();
      const result = runtime.execute('module.exports = require("./nonexistent");');
      expect(result.exports).toBe('found');
    });
  });

  describe('processed code caching', () => {
    it('should reuse processed code when module cache is cleared but content unchanged', () => {
      // Create a simple CJS module
      vfs.writeFileSync('/cached-module.js', 'module.exports = { value: 42 };');

      // First execution
      const result1 = runtime.execute(`
        const mod = require('./cached-module.js');
        module.exports = mod.value;
      `);
      expect(result1.exports).toBe(42);

      // Clear module cache
      runtime.clearCache();

      // Second execution - module needs to be re-required but code processing is cached
      const result2 = runtime.execute(`
        const mod = require('./cached-module.js');
        module.exports = mod.value;
      `);
      expect(result2.exports).toBe(42);
    });

    it('should reprocess code when content changes', () => {
      vfs.writeFileSync('/changeable.js', 'module.exports = { num: 1 };');

      const result1 = runtime.execute(`
        const mod = require('./changeable.js');
        module.exports = mod.num;
      `);
      expect(result1.exports).toBe(1);

      // Modify the file
      vfs.writeFileSync('/changeable.js', 'module.exports = { num: 2 };');

      // Clear module cache to force re-require
      runtime.clearCache();

      // Should get new value (code was reprocessed due to content change)
      const result2 = runtime.execute(`
        const mod = require('./changeable.js');
        module.exports = mod.num;
      `);
      expect(result2.exports).toBe(2);
    });

    it('should handle ESM to CJS transformation caching', () => {
      // Create a file with ESM syntax in /esm/ directory (triggers transformation)
      vfs.mkdirSync('/esm', { recursive: true });
      vfs.writeFileSync('/esm/helper.js', `
        export const multiply = (a, b) => a * b;
        export const add = (a, b) => a + b;
      `);

      const result1 = runtime.execute(`
        const helper = require('./esm/helper.js');
        module.exports = helper.multiply(3, 4);
      `);
      expect(result1.exports).toBe(12);

      // Clear module cache
      runtime.clearCache();

      // The transformed code should still work after cache clear
      const result2 = runtime.execute(`
        const helper = require('./esm/helper.js');
        module.exports = helper.add(10, 5);
      `);
      expect(result2.exports).toBe(15);
    });
  });

  describe('createREPL', () => {
    it('should return expression values', () => {
      const repl = runtime.createREPL();
      expect(repl.eval('1 + 2')).toBe(3);
      expect(repl.eval('"hello".toUpperCase()')).toBe('HELLO');
    });

    it('should persist variables across calls', () => {
      const repl = runtime.createREPL();
      repl.eval('var x = 42');
      expect(repl.eval('x')).toBe(42);
    });

    it('should persist const/let as var', () => {
      const repl = runtime.createREPL();
      repl.eval('const a = 1');
      expect(repl.eval('a')).toBe(1);
      repl.eval('let b = 2');
      expect(repl.eval('b')).toBe(2);
    });

    it('should have access to require', () => {
      const repl = runtime.createREPL();
      expect(repl.eval("require('path').join('/foo', 'bar')")).toBe('/foo/bar');
    });

    it('should have access to Buffer', () => {
      const repl = runtime.createREPL();
      const result = repl.eval("Buffer.from('hello').toString('base64')");
      expect(result).toBe('aGVsbG8=');
    });

    it('should have access to process', () => {
      const repl = runtime.createREPL();
      expect(repl.eval('typeof process')).toBe('object');
      expect(repl.eval('typeof process.env')).toBe('object');
    });

    it('should handle require("fs") read/write', () => {
      vfs.mkdirSync('/repl-test', { recursive: true });
      const repl = runtime.createREPL();
      repl.eval("var fs = require('fs')");
      repl.eval("fs.writeFileSync('/repl-test/hello.txt', 'Hello REPL!')");
      expect(repl.eval("fs.readFileSync('/repl-test/hello.txt', 'utf8')")).toBe('Hello REPL!');
    });

    it('should throw on invalid code', () => {
      const repl = runtime.createREPL();
      expect(() => repl.eval('undefined_var')).toThrow();
    });

    it('should handle multi-statement code', () => {
      const repl = runtime.createREPL();
      const result = repl.eval("var a = 1; var b = 2; a + b");
      expect(result).toBe(3);
    });

    it('should capture console.log via onConsole', () => {
      const logs: string[][] = [];
      const rt = new Runtime(vfs, {
        onConsole: (method, args) => { logs.push(args.map(String)); },
      });
      const repl = rt.createREPL();
      repl.eval("console.log('hello from repl')");
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain('hello from repl');
    });

    it('should isolate separate REPL instances', () => {
      const repl1 = runtime.createREPL();
      const repl2 = runtime.createREPL();
      repl1.eval('var x = 100');
      expect(repl1.eval('x')).toBe(100);
      expect(() => repl2.eval('x')).toThrow();
    });
  });

  describe('package.json entry resolution', () => {
    it('should prefer main over browser field for runtime require()', () => {
      vfs.writeFileSync('/node_modules/testpkg/package.json', JSON.stringify({
        name: 'testpkg',
        browser: 'lib/browser/index.js',
        main: 'index.js',
      }));
      vfs.writeFileSync('/node_modules/testpkg/index.js', 'module.exports = "node";');
      vfs.writeFileSync('/node_modules/testpkg/lib/browser/index.js', 'module.exports = "browser";');

      const { exports } = runtime.execute('module.exports = require("testpkg");');
      expect(exports).toBe('node');
    });

    it('should fall back to main when browser field is not set', () => {
      vfs.writeFileSync('/node_modules/nopkg/package.json', JSON.stringify({
        name: 'nopkg',
        main: 'lib/main.js',
      }));
      vfs.writeFileSync('/node_modules/nopkg/lib/main.js', 'module.exports = "main";');

      const { exports } = runtime.execute('module.exports = require("nopkg");');
      expect(exports).toBe('main');
    });

    it('should fall back to index.js when neither browser nor main is set', () => {
      vfs.writeFileSync('/node_modules/defpkg/package.json', JSON.stringify({
        name: 'defpkg',
      }));
      vfs.writeFileSync('/node_modules/defpkg/index.js', 'module.exports = "default";');

      const { exports } = runtime.execute('module.exports = require("defpkg");');
      expect(exports).toBe('default');
    });

    it('should not apply browser field object remap for subpath imports', () => {
      vfs.writeFileSync('/node_modules/browser-map-pkg/package.json', JSON.stringify({
        name: 'browser-map-pkg',
        browser: {
          './lib/node.js': './lib/browser.js',
        },
      }));
      vfs.writeFileSync('/node_modules/browser-map-pkg/lib/node.js', 'module.exports = "node-subpath";');
      vfs.writeFileSync('/node_modules/browser-map-pkg/lib/browser.js', 'module.exports = "browser-subpath";');

      const { exports } = runtime.execute('module.exports = require("browser-map-pkg/lib/node.js");');
      expect(exports).toBe('node-subpath');
    });

    it('should resolve packages from pnpm virtual store without top-level symlink', () => {
      vfs.writeFileSync(
        '/node_modules/.pnpm/pnpm-only-pkg@1.0.0/node_modules/pnpm-only-pkg/package.json',
        JSON.stringify({
          name: 'pnpm-only-pkg',
          exports: {
            '.': {
              default: './dist/index.js',
            },
          },
        }),
      );
      vfs.writeFileSync(
        '/node_modules/.pnpm/pnpm-only-pkg@1.0.0/node_modules/pnpm-only-pkg/dist/index.js',
        'module.exports = "resolved-from-pnpm-store";'
      );

      const { exports } = runtime.execute('module.exports = require("pnpm-only-pkg");');
      expect(exports).toBe('resolved-from-pnpm-store');
    });

    it('should not treat comment text containing "export" as ESM syntax', () => {
      vfs.writeFileSync('/node_modules/mock-engine/package.json', JSON.stringify({
        name: 'mock-engine',
        main: 'index.js',
      }));
      vfs.writeFileSync(
        '/node_modules/mock-engine/index.js',
        'module.exports = { __express: function mockExpress() { return "ok"; } };'
      );

      vfs.writeFileSync(
        '/view-like.js',
        `module.exports = function loadEngine(engines) {
  if (!engines['.ejs']) {
    // default engine export
    var fn = require('mock-engine').__express
    engines['.ejs'] = fn
  }
  return engines['.ejs']
}
module.exports.__esmFlag = Object.prototype.hasOwnProperty.call(exports, '__esModule')
`
      );

      const { exports } = runtime.execute(`
        const load = require('/view-like.js');
        const engines = {};
        const engine = load(engines);
        module.exports = {
          name: engine.name,
          rendered: engine(),
          esmFlag: load.__esmFlag,
        };
      `);

      expect(exports).toEqual({
        name: 'mockExpress',
        rendered: 'ok',
        esmFlag: false,
      });
    });
  });

  describe('Error.captureStackTrace polyfill', () => {
    it('should provide CallSite objects when prepareStackTrace is set', () => {
      // Save and remove native captureStackTrace to test polyfill
      const origCapture = (Error as any).captureStackTrace;
      const origPrepare = (Error as any).prepareStackTrace;
      delete (Error as any).captureStackTrace;
      delete (Error as any).prepareStackTrace;

      try {
        // Create a fresh runtime which will install the polyfill
        const testVfs = new VirtualFS();
        new Runtime(testVfs);

        // Verify polyfill was installed
        expect(typeof (Error as any).captureStackTrace).toBe('function');

        // Test the depd pattern: set prepareStackTrace, call captureStackTrace, read .stack
        const obj: any = {};
        (Error as any).prepareStackTrace = (_err: any, stack: any[]) => stack;
        (Error as any).captureStackTrace(obj);

        // obj.stack should be an array of CallSite-like objects
        expect(Array.isArray(obj.stack)).toBe(true);
        if (obj.stack.length > 0) {
          const callSite = obj.stack[0];
          expect(typeof callSite.getFileName).toBe('function');
          expect(typeof callSite.getLineNumber).toBe('function');
          expect(typeof callSite.getColumnNumber).toBe('function');
          expect(typeof callSite.getFunctionName).toBe('function');
          expect(typeof callSite.isNative).toBe('function');
          expect(typeof callSite.isEval).toBe('function');
          expect(typeof callSite.toString).toBe('function');
        }
      } finally {
        // Restore native captureStackTrace
        (Error as any).captureStackTrace = origCapture;
        (Error as any).prepareStackTrace = origPrepare;
      }
    });

    it('should set stackTraceLimit when polyfilling', () => {
      const origCapture = (Error as any).captureStackTrace;
      const origLimit = (Error as any).stackTraceLimit;
      delete (Error as any).captureStackTrace;
      delete (Error as any).stackTraceLimit;

      try {
        const testVfs = new VirtualFS();
        new Runtime(testVfs);
        expect((Error as any).stackTraceLimit).toBe(10);
      } finally {
        (Error as any).captureStackTrace = origCapture;
        (Error as any).stackTraceLimit = origLimit;
      }
    });
  });
});
