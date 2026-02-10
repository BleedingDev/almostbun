import { describe, expect, it } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { createFsShim } from '../src/shims/fs';

describe('fs shim encoding interop', () => {
  it('returns string for readFileSync with options encoding', () => {
    const vfs = new VirtualFS();
    vfs.writeFileSync('/project/package.json', '{"name":"demo"}');
    const fs = createFsShim(vfs);

    const value = fs.readFileSync('/project/package.json', { encoding: 'utf8' });
    expect(value).toBe('{"name":"demo"}');
  });

  it('supports case-insensitive utf8 encoding aliases', () => {
    const vfs = new VirtualFS();
    vfs.writeFileSync('/project/package.json', '{"name":"demo"}');
    const fs = createFsShim(vfs);

    const value = fs.readFileSync('/project/package.json', { encoding: 'UTF-8' as unknown as 'utf8' });
    expect(value).toBe('{"name":"demo"}');
  });

  it('returns string for promises.readFile with object options', async () => {
    const vfs = new VirtualFS();
    vfs.writeFileSync('/project/package.json', '{"name":"demo"}');
    const fs = createFsShim(vfs);

    const value = await fs.promises.readFile(
      '/project/package.json',
      { encoding: 'utf8', flag: 'r' } as { encoding: 'utf8' }
    );
    expect(value).toBe('{"name":"demo"}');
  });

  it('treats empty options object as utf8 text for compatibility', () => {
    const vfs = new VirtualFS();
    vfs.writeFileSync('/project/package.json', '{"name":"demo"}');
    const fs = createFsShim(vfs);

    const value = fs.readFileSync('/project/package.json', {} as { encoding?: string });
    expect(value).toBe('{"name":"demo"}');
  });

  it('supports callback-style fs.writeFile used by fs-extra wrappers', async () => {
    const vfs = new VirtualFS();
    const fs = createFsShim(vfs);

    await new Promise<void>((resolve, reject) => {
      fs.writeFile('/project/output.txt', 'hello', (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });

    expect(vfs.readFileSync('/project/output.txt', 'utf8')).toBe('hello');
  });
});
