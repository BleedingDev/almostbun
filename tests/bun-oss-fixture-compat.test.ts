import { beforeEach, describe, expect, it } from 'vitest';
import { Runtime } from '../src/runtime';
import { VirtualFS } from '../src/virtual-fs';
import { clearPersistedDatabases } from '../src/shims/bun-sqlite';

describe('Bun OSS fixture compatibility', () => {
  let vfs: VirtualFS;
  let runtime: Runtime;

  beforeEach(() => {
    clearPersistedDatabases();
    vfs = new VirtualFS();
    runtime = new Runtime(vfs, {
      env: {
        PATH: '/usr/bin:/bin',
      },
    });
  });

  it('supports URLSearchParams.toJSON across URL modules (bun fixture: url.ts)', () => {
    const { exports } = runtime.execute(`
      const nodeUrl = require('node:url');
      const plainUrl = require('url');

      module.exports = {
        global: new URLSearchParams('a=1&a=2&b=3').toJSON(),
        node: new nodeUrl.URLSearchParams('x=1&x=2').toJSON(),
        plain: new plainUrl.URLSearchParams('k=v').toJSON(),
      };
    `);

    expect(exports).toEqual({
      global: { a: ['1', '2'], b: '3' },
      node: { x: ['1', '2'] },
      plain: { k: 'v' },
    });
  });

  it('supports multi-value Headers append/get semantics (bun fixture: headers.ts)', () => {
    const { exports } = runtime.execute(`
      const headers = new Headers();
      headers.append('Set-Cookie', 'a=1');
      headers.append('Set-Cookie', 'b=1; Secure');

      module.exports = {
        normalized: headers.get('set-cookie') || '',
      };
    `);

    const result = exports as { normalized: string };
    expect(result.normalized).toContain('a=1');
    expect(result.normalized).toContain('b=1; Secure');
  });

  it('supports diagnostics_channel publish/subscribe (bun fixture: diag.ts)', () => {
    const { exports } = runtime.execute(`
      const diagnostics = require('diagnostics_channel');
      const channel = diagnostics.channel('fixture');
      let seen = null;

      channel.subscribe((message, name) => {
        seen = { message, name };
      });

      channel.publish({ ok: true });

      module.exports = {
        hasSubscribers: channel.hasSubscribers,
        seen,
      };
    `);

    expect(exports).toEqual({
      hasSubscribers: true,
      seen: {
        message: { ok: true },
        name: 'fixture',
      },
    });
  });

  it('supports util/types helpers (bun fixture: util.ts)', () => {
    const { exports } = runtime.execute(`
      const util = require('node:util');
      const types = require('node:util/types');

      module.exports = {
        hasInspect: typeof util.inspect,
        hasTypes: typeof util.types,
        isArrayBuffer: types.isAnyArrayBuffer(new ArrayBuffer(4)),
      };
    `);

    expect(exports).toEqual({
      hasInspect: 'function',
      hasTypes: 'object',
      isArrayBuffer: true,
    });
  });

  it('supports EventEmitter APIs (bun fixture: events.ts)', () => {
    const { exports } = runtime.execute(`
      const { EventEmitter } = require('events');
      const emitter = new EventEmitter();
      let value = '';

      emitter.on('greet', (name) => {
        value = 'hello:' + name;
      });

      emitter.emit('greet', 'bun');
      module.exports = value;
    `);

    expect(exports).toBe('hello:bun');
  });

  it('supports performance from node:perf_hooks (bun fixture: perf_hooks.ts)', () => {
    const { exports } = runtime.execute(`
      const perf = require('node:perf_hooks').performance;
      module.exports = {
        globalNow: typeof performance.now(),
        moduleNow: typeof perf.now(),
        timeOriginType: typeof perf.timeOrigin,
      };
    `);

    expect(exports).toEqual({
      globalNow: 'number',
      moduleNow: 'number',
      timeOriginType: 'number',
    });
  });

  it('supports bun:sqlite constants + query/get/run (bun fixture: sqlite.ts)', () => {
    const { exports } = runtime.execute(`
      const sqlite = require('bun:sqlite');
      const db = new sqlite.Database(':memory:');

      db.exec('CREATE TABLE users (id INT, name STRING)');
      db.run('INSERT INTO users VALUES (?, ?)', 1, 'Ada');
      db.run('INSERT INTO users VALUES (?, ?)', 2, 'Lin');

      const row = db.query('SELECT name FROM users WHERE id = ?').get(2);

      module.exports = {
        sqliteOk: sqlite.constants.SQLITE_OK,
        name: row && row.name,
      };
    `);

    expect(exports).toEqual({
      sqliteOk: 0,
      name: 'Lin',
    });
  });

  it('supports bun:sqlite transaction rollback behavior (bun fixture: sqlite.ts)', () => {
    const { exports } = runtime.execute(`
      const { Database } = require('bun:sqlite');
      const db = new Database(':memory:');

      db.exec('CREATE TABLE entries (id INT, val STRING)');

      const insertTx = db.transaction((id, val, shouldThrow) => {
        db.run('INSERT INTO entries VALUES (?, ?)', id, val);
        if (shouldThrow) {
          throw new Error('rollback');
        }
      });

      try {
        insertTx(1, 'keep', false);
      } catch {}
      try {
        insertTx(2, 'drop', true);
      } catch {}

      const rows = db.query('SELECT id, val FROM entries').all();
      module.exports = rows;
    `);

    expect(exports).toEqual([{ id: 1, val: 'keep' }]);
  });

  it('supports bun:sqlite serialize/deserialize (bun fixture: sqlite.ts)', () => {
    const { exports } = runtime.execute(`
      const { Database } = require('bun:sqlite');

      const db1 = new Database(':memory:');
      db1.exec('CREATE TABLE t (id INT, name STRING)');
      db1.run('INSERT INTO t VALUES (?, ?)', 1, 'alpha');

      const snapshot = db1.serialize();
      const db2 = Database.deserialize(snapshot, ':memory:');
      const row = db2.query('SELECT name FROM t WHERE id = ?').get(1);

      module.exports = row && row.name;
    `);

    expect(exports).toBe('alpha');
  });

  it('supports S3 file write/stat/list/delete flows (bun fixture: s3.ts)', async () => {
    const { exports } = runtime.execute(`
      module.exports = (async () => {
        const bun = require('bun');
        const client = new bun.S3Client({ bucket: 'oss-fixture' });
        const file = client.file('demo/one.txt');

        await file.write('hello-s3');

        const stat = await file.stat();
        const list = await client.list('demo/');
        await file.delete();
        const existsAfterDelete = await file.exists();

        return {
          statSize: stat && stat.size,
          listCount: list.length,
          firstKey: list[0] && list[0].key,
          existsAfterDelete,
        };
      })();
    `);

    expect(await exports).toEqual({
      statSize: 8,
      listCount: 1,
      firstKey: 'demo/one.txt',
      existsAfterDelete: false,
    });
  });

  it('supports S3 stream consumption (bun fixture: s3.ts)', async () => {
    const { exports } = runtime.execute(`
      module.exports = (async () => {
        const bun = require('bun');
        const file = bun.s3('s3://fixture-bucket/stream.txt');
        await file.write('stream-data');

        const reader = file.stream().getReader();
        const chunks = [];
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          chunks.push(...next.value);
        }

        return new TextDecoder().decode(new Uint8Array(chunks));
      })();
    `);

    expect(await exports).toBe('stream-data');
  });

  it('supports bun:jsc serialization helpers (bun fixture: jsc.ts)', () => {
    const { exports } = runtime.execute(`
      const jsc = require('bun:jsc');
      const payload = { a: 1, b: 'two' };
      const encoded = jsc.serialize(payload);
      const decoded = jsc.deserialize(encoded);
      const stats = jsc.heapStats();

      module.exports = {
        decoded,
        hasHeapSize: typeof stats.heapSize,
        hasHeapCapacity: typeof stats.heapCapacity,
      };
    `);

    expect(exports).toEqual({
      decoded: { a: 1, b: 'two' },
      hasHeapSize: 'number',
      hasHeapCapacity: 'number',
    });
  });

  it('supports bun:test mock.fn call tracking (bun fixture: bun.test.ts)', () => {
    const { exports } = runtime.execute(`
      const bunTest = require('bun:test');
      const fn = bunTest.mock.fn((n) => n * 2);

      fn(2);
      fn(3);

      module.exports = fn.mock.calls;
    `);

    expect(exports).toEqual([[2], [3]]);
  });

  it('throws explicit errors for unsupported bun:ffi runtime calls (bun fixture: ffi.ts)', () => {
    const { exports } = runtime.execute(`
      try {
        const ffi = require('bun:ffi');
        ffi.dlopen('libmissing.so', {});
        module.exports = 'unexpected';
      } catch (error) {
        module.exports = String(error && error.message ? error.message : error);
      }
    `);

    expect(exports).toContain('bun:ffi dlopen() is not available in browser runtime');
  });

  it('supports Bun.serve lifecycle with fetch/reload/stop (bun fixture: serve.ts)', async () => {
    const { exports } = runtime.execute(`
      module.exports = (async () => {
        const bun = require('bun');
        const server = bun.serve({
          port: 4021,
          fetch: () => new Response('ok', { status: 201 }),
        });

        const first = await server.fetch(new Request('http://localhost/'));
        server.stop();
        const stopped = await server.fetch(new Request('http://localhost/'));
        server.reload({
          fetch: () => new Response('reloaded', { status: 200 }),
        });
        const reloaded = await server.fetch(new Request('http://localhost/'));

        return {
          firstStatus: first.status,
          firstBody: await first.text(),
          stoppedStatus: stopped.status,
          reloadedStatus: reloaded.status,
          reloadedBody: await reloaded.text(),
        };
      })();
    `);

    expect(await exports).toEqual({
      firstStatus: 201,
      firstBody: 'ok',
      stoppedStatus: 503,
      reloadedStatus: 200,
      reloadedBody: 'reloaded',
    });
  });

  it('supports dynamic import() for bun and bun:sqlite modules (bun fixture: sqlite.ts)', async () => {
    vfs.writeFileSync(
      '/dynamic-bun.js',
      `
      module.exports = (async () => {
        const bunModule = await import('bun');
        const sqlite = await import('bun:sqlite');
        const db = new sqlite.Database(':memory:');
        db.exec('CREATE TABLE d (name STRING)');
        db.run('INSERT INTO d VALUES (?)', 'dynamic');
        const row = db.query('SELECT name FROM d').get();
        return {
          hasWrite: typeof bunModule.default.write,
          name: row && row.name,
        };
      })();
      `
    );

    const { exports } = runtime.execute(
      `module.exports = require('./dynamic-bun.js');`,
      '/entry.js'
    );
    expect(await exports).toEqual({
      hasWrite: 'function',
      name: 'dynamic',
    });
  });
});
