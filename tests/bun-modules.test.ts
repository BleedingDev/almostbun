import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';

describe('Bun compatibility modules', () => {
  let vfs: VirtualFS;
  let runtime: Runtime;

  beforeEach(() => {
    vfs = new VirtualFS();
    runtime = new Runtime(vfs);
  });

  it('should expose Bun global and bun module', () => {
    const { exports } = runtime.execute(`
      const bun = require('bun');
      module.exports = {
        sameRef: bun === Bun,
        hasFile: typeof bun.file,
        hasWrite: typeof bun.write,
      };
    `);

    const result = exports as { sameRef: boolean; hasFile: string; hasWrite: string };
    expect(result.sameRef).toBe(true);
    expect(result.hasFile).toBe('function');
    expect(result.hasWrite).toBe('function');
  });

  it('should support Bun.write and Bun.file in the VFS', async () => {
    const { exports } = runtime.execute(`
      module.exports = (async () => {
        const bun = require('bun');
        await bun.write('/tmp/hello.txt', 'hello bun');
        return await bun.file('/tmp/hello.txt').text();
      })();
    `);

    const text = await exports as string;
    expect(text).toBe('hello bun');
  });

  it('should support bun:sqlite basic queries', () => {
    const { exports } = runtime.execute(`
      const { Database } = require('bun:sqlite');
      const db = new Database(':memory:');
      db.exec('CREATE TABLE users (id INT, name STRING)');
      db.run('INSERT INTO users VALUES (?, ?)', 1, 'Ada');
      db.run('INSERT INTO users VALUES (?, ?)', 2, 'Lin');
      const row = db.query('SELECT name FROM users WHERE id = ?').get(2);
      module.exports = row && row.name;
    `);

    expect(exports).toBe('Lin');
  });

  it('should support Bun S3Client round-trip storage', async () => {
    const { exports } = runtime.execute(`
      module.exports = (async () => {
        const bun = require('bun');
        const client = new bun.S3Client({ bucket: 'demo-bucket' });
        const file = client.file('avatars/me.txt');

        await file.write('from-s3');

        return {
          exists: await file.exists(),
          text: await file.text(),
          url: String(file),
        };
      })();
    `);

    const result = await exports as { exists: boolean; text: string; url: string };

    expect(result.exists).toBe(true);
    expect(result.text).toBe('from-s3');
    expect(result.url).toBe('s3://demo-bucket/avatars/me.txt');
  });

  it('should load bun:test, bun:ffi, and bun:jsc modules', () => {
    const { exports } = runtime.execute(`
      const bunTest = require('bun:test');
      const ffi = require('bun:ffi');
      const jsc = require('bun:jsc');

      module.exports = {
        hasTest: typeof bunTest.test,
        hasExpect: typeof bunTest.expect,
        hasFFIType: typeof ffi.FFIType,
        hasHeapStats: typeof jsc.heapStats,
      };
    `);

    const result = exports as {
      hasTest: string;
      hasExpect: string;
      hasFFIType: string;
      hasHeapStats: string;
    };

    expect(result.hasTest).toBe('function');
    expect(result.hasExpect).toBe('function');
    expect(result.hasFFIType).toBe('object');
    expect(result.hasHeapStats).toBe('function');
  });
});
