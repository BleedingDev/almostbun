import { describe, it, expect, beforeEach } from 'vitest';
import { Runtime } from '../src/runtime';
import { VirtualFS } from '../src/virtual-fs';

describe('runtime lru-cache interop', () => {
  let vfs: VirtualFS;
  let runtime: Runtime;

  beforeEach(() => {
    vfs = new VirtualFS();
    runtime = new Runtime(vfs, { cwd: '/project' });

    vfs.writeFileSync(
      '/project/node_modules/lru-cache/package.json',
      JSON.stringify({
        name: 'lru-cache',
        version: '0.0.0-test',
        main: 'index.js',
      })
    );
  });

  it('exposes .LRUCache when package exports constructor directly', () => {
    vfs.writeFileSync(
      '/project/node_modules/lru-cache/index.js',
      `
      class Cache {
        constructor() {
          this.ok = true;
        }
      }
      module.exports = Cache;
      `
    );

    const { exports } = runtime.execute(
      `
      const cachePkg = require('lru-cache');
      const instance = new cachePkg.LRUCache();
      module.exports = {
        hasNamedCtor: typeof cachePkg.LRUCache,
        ok: instance.ok,
      };
      `,
      '/project/entry.js'
    );

    expect(exports).toEqual({
      hasNamedCtor: 'function',
      ok: true,
    });
  });

  it('normalizes trailing slash built-in requests like string_decoder/', () => {
    const { exports } = runtime.execute(
      `
      const a = require('string_decoder');
      const b = require('string_decoder/');
      module.exports = {
        sameType: typeof a.StringDecoder === typeof b.StringDecoder,
        ctorType: typeof b.StringDecoder,
      };
      `,
      '/project/entry-builtins.js'
    );

    expect(exports).toEqual({
      sameType: true,
      ctorType: 'function',
    });
  });

  it('returns constructor-compatible module builtin', () => {
    const { exports } = runtime.execute(
      `
      const Module = require('module');
      const instance = new Module.Module('/project/smoke.js');
      module.exports = {
        typeOfModule: typeof Module,
        typeOfNamedCtor: typeof Module.Module,
        namedCtorMatchesDefault: Module.Module === Module,
        instanceId: instance.id,
        hasCreateRequire: typeof Module.createRequire,
        fsIsBuiltin: Module.isBuiltin('node:fs'),
      };
      `,
      '/project/entry-module-smoke.js'
    );

    expect(exports).toEqual({
      typeOfModule: 'function',
      typeOfNamedCtor: 'function',
      namedCtorMatchesDefault: true,
      instanceId: '/project/smoke.js',
      hasCreateRequire: 'function',
      fsIsBuiltin: true,
    });
  });

  it('supports Module.createRequire with file URL inputs', () => {
    vfs.writeFileSync('/project/lib/value.js', 'module.exports = 12345;');

    const { exports } = runtime.execute(
      `
      const Module = require('module');
      const req = Module.createRequire('file:///project/lib/main.js');
      module.exports = {
        loaded: req('./value'),
      };
      `,
      '/project/entry-module-create-require.js'
    );

    expect(exports).toEqual({
      loaded: 12345,
    });
  });

  it('exposes Node-style Module.wrap and Module._nodeModulePaths', () => {
    const { exports } = runtime.execute(
      `
      const Module = require('module');
      const wrapped = Module.wrap('module.exports = 1;');
      const paths = Module._nodeModulePaths('/project/src');
      module.exports = {
        hasFunctionWrapper: wrapped.startsWith('(function (exports, require, module, __filename, __dirname) { '),
        hasWrapperSuffix: wrapped.endsWith('\\n});'),
        paths,
      };
      `,
      '/project/entry-module-internals.js'
    );

    expect(exports).toEqual({
      hasFunctionWrapper: true,
      hasWrapperSuffix: true,
      paths: [
        '/project/src/node_modules',
        '/project/node_modules',
        '/node_modules',
      ],
    });
  });

  it('provides process.report.getReport for native binding probes', () => {
    const { exports } = runtime.execute(
      `
      const report = process.report?.getReport?.();
      module.exports = {
        hasGetReport: typeof process.report?.getReport,
        glibcVersionRuntime: report?.header?.glibcVersionRuntime || null,
        hasSharedObjectsArray: Array.isArray(report?.sharedObjects),
      };
      `,
      '/project/entry-process-report.js'
    );

    expect(exports).toEqual({
      hasGetReport: 'function',
      glibcVersionRuntime: '2.31',
      hasSharedObjectsArray: true,
    });
  });

  it('throws a clear error when requiring native .node addons', () => {
    vfs.writeFileSync('/project/native-addon.node', new Uint8Array([0x7f, 0x45, 0x4c, 0x46]));

    const { exports } = runtime.execute(
      `
      let message = '';
      try {
        require('./native-addon.node');
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      module.exports = { message };
      `,
      '/project/entry-native-node.js'
    );

    expect((exports as { message: string }).message).toContain('Native addons are not supported');
  });

  it('resolves package main when requiring parent directory (require(\"..\"))', () => {
    vfs.writeFileSync(
      '/project/node_modules/demo-parent/package.json',
      JSON.stringify({
        name: 'demo-parent',
        version: '1.0.0',
        main: 'main.js',
      })
    );
    vfs.writeFileSync(
      '/project/node_modules/demo-parent/main.js',
      'module.exports = { ok: true };'
    );
    vfs.writeFileSync(
      '/project/node_modules/demo-parent/lib/pre-binding.js',
      'module.exports = require("..").ok;'
    );

    const { exports } = runtime.execute(
      `
      module.exports = require('demo-parent/lib/pre-binding.js');
      `,
      '/project/entry-parent.js'
    );

    expect(exports).toBe(true);
  });

  it('provides @swc/core shim when native bindings are unavailable', () => {
    vfs.writeFileSync(
      '/project/node_modules/@swc/core/package.json',
      JSON.stringify({
        name: '@swc/core',
        version: '0.0.0-test',
        main: 'index.js',
      })
    );
    vfs.writeFileSync(
      '/project/node_modules/@swc/core/index.js',
      'throw new Error("native swc should not be loaded in this test");'
    );

    const { exports } = runtime.execute(
      `
      const swc = require('@swc/core');
      const out = swc.transformSync('const value = 1;', { jsc: { parser: { syntax: 'ecmascript' } } });
      module.exports = {
        hasTransformSync: typeof swc.transformSync,
        hasCompiler: typeof swc.Compiler,
        transformedType: typeof out.code,
      };
      `,
      '/project/entry-swc.js'
    );

    expect(exports).toEqual({
      hasTransformSync: 'function',
      hasCompiler: 'function',
      transformedType: 'string',
    });
  });

  it('maps chalk default export for CJS callers expecting chalk.cyan', () => {
    vfs.writeFileSync(
      '/project/node_modules/chalk/package.json',
      JSON.stringify({
        name: 'chalk',
        version: '0.0.0-test',
        main: 'index.js',
      })
    );
    vfs.writeFileSync(
      '/project/node_modules/chalk/index.js',
      `
      module.exports = {
        default: {
          cyan(value) {
            return '[cyan]' + value;
          }
        }
      };
      `
    );

    const { exports } = runtime.execute(
      `
      const chalk = require('chalk');
      module.exports = {
        cyanType: typeof chalk.cyan,
        sample: chalk.cyan('ok'),
      };
      `,
      '/project/entry-chalk.js'
    );

    expect(exports).toEqual({
      cyanType: 'function',
      sample: '[cyan]ok',
    });
  });

  it('preserves chalk.cyan under __toESM-style namespace wrapping', () => {
    vfs.writeFileSync(
      '/project/node_modules/chalk/package.json',
      JSON.stringify({
        name: 'chalk',
        version: '0.0.0-test',
        main: 'index.js',
      })
    );
    vfs.writeFileSync(
      '/project/node_modules/chalk/index.js',
      `
      function chalk(value) {
        return value;
      }
      Object.defineProperty(chalk, 'cyan', {
        value(value) {
          return '[cyan]' + value;
        },
        enumerable: false,
        configurable: true,
      });
      module.exports = chalk;
      `
    );

    const { exports } = runtime.execute(
      `
      function __toESM(mod) {
        const ns = {};
        for (const key in mod) {
          ns[key] = mod[key];
        }
        ns.default = mod;
        return ns;
      }
      const chalkNs = __toESM(require('chalk'));
      module.exports = {
        cyanType: typeof chalkNs.cyan,
        sample: chalkNs.cyan('ok'),
      };
      `,
      '/project/entry-chalk-to-esm.js'
    );

    expect(exports).toEqual({
      cyanType: 'function',
      sample: '[cyan]ok',
    });
  });

  it('provides __dynamicImport fallback for vm.runInThisContext wrappers', async () => {
    vfs.writeFileSync('/project/dep.js', 'module.exports = 77;');

    const { exports } = runtime.execute(
      `
      const vm = require('vm');
      const thunk = vm.runInThisContext('(function () { return __dynamicImport("./dep.js"); })');
      module.exports = thunk().then(mod => mod.default);
      `,
      '/project/entry-vm-dynamic.js'
    );

    await expect(exports as Promise<unknown>).resolves.toBe(77);
  });

  it('supports require.resolve for fs/promises builtin', () => {
    const { exports } = runtime.execute(
      `
      const resolved = require.resolve('fs/promises');
      module.exports = { resolved };
      `,
      '/project/entry-resolve-fs-promises.js'
    );

    expect(exports).toEqual({
      resolved: 'fs/promises',
    });
  });

  it('aliases statuses.STATUS_CODES to statuses.message for http-errors compatibility', () => {
    vfs.writeFileSync(
      '/project/node_modules/statuses/package.json',
      JSON.stringify({
        name: 'statuses',
        version: '0.0.0-test',
        main: 'index.js',
      })
    );
    vfs.writeFileSync(
      '/project/node_modules/statuses/index.js',
      `
      function statuses() {}
      statuses.STATUS_CODES = { 200: 'OK', 500: 'Internal Server Error' };
      module.exports = statuses;
      `
    );

    const { exports } = runtime.execute(
      `
      const statuses = require('statuses');
      module.exports = {
        hasMessage: typeof statuses.message,
        ok: statuses.message[200],
        hasStatusCodes: typeof statuses.STATUS_CODES,
      };
      `,
      '/project/entry-statuses.js'
    );

    expect(exports).toEqual({
      hasMessage: 'object',
      ok: 'OK',
      hasStatusCodes: 'object',
    });
  });

  it('keeps toidentifier robust for undefined inputs from third-party stacks', () => {
    const { exports } = runtime.execute(
      `
      const toIdentifier = require('toidentifier');
      module.exports = {
        safeUndefined: toIdentifier(undefined),
        safeNull: toIdentifier(null),
        safeText: toIdentifier('hello world'),
      };
      `,
      '/project/entry-toidentifier.js'
    );

    expect(exports).toEqual({
      safeUndefined: '',
      safeNull: '',
      safeText: 'HelloWorld',
    });
  });

  it('normalizes Uint8Array and ArrayBuffer inputs for etag-style modules', () => {
    vfs.writeFileSync(
      '/project/node_modules/etag/package.json',
      JSON.stringify({
        name: 'etag',
        version: '0.0.0-test',
        main: 'index.js',
      })
    );
    vfs.writeFileSync(
      '/project/node_modules/etag/index.js',
      `
      const { Buffer } = require('buffer');

      function etag(entity) {
        if (typeof entity !== 'string' && !Buffer.isBuffer(entity)) {
          throw new TypeError('argument entity must be string, Buffer, or fs.Stats');
        }
        return 'W/"' + entity.length + '"';
      }

      module.exports = etag;
      `
    );

    const { exports } = runtime.execute(
      `
      const etag = require('etag');
      module.exports = {
        fromUint8Array: etag(new Uint8Array([1, 2, 3])),
        fromArrayBuffer: etag(new Uint8Array([4, 5]).buffer),
        fromString: etag('ok'),
      };
      `,
      '/project/entry-etag-compat.js'
    );

    expect(exports).toEqual({
      fromUint8Array: 'W/"3"',
      fromArrayBuffer: 'W/"2"',
      fromString: 'W/"2"',
    });
  });

  it('supports legacy EventEmitter.call(this) inheritance paths', () => {
    const { exports } = runtime.execute(
      `
      const util = require('util');
      const EventEmitter = require('events');

      function LegacyServer() {
        EventEmitter.call(this);
      }
      util.inherits(LegacyServer, EventEmitter);

      const server = new LegacyServer();
      let seen = false;
      server.on('ready', () => {
        seen = true;
      });
      server.emit('ready');

      module.exports = {
        seen,
        hasOn: typeof server.on,
        hasEmit: typeof server.emit,
      };
      `,
      '/project/entry-events-legacy.js'
    );

    expect(exports).toEqual({
      seen: true,
      hasOn: 'function',
      hasEmit: 'function',
    });
  });
});
