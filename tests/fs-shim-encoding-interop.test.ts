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

    const value = fs.readFileSync('/project/package.json', {} as { encoding?: null });
    expect(value).toBe('{"name":"demo"}');
  });

  it('returns binary data when encoding is explicitly null', () => {
    const vfs = new VirtualFS();
    vfs.writeFileSync('/project/data.bin', new Uint8Array([0, 1, 2, 255]));
    const fs = createFsShim(vfs);

    const value = fs.readFileSync('/project/data.bin', { encoding: null });
    expect(value).toBeInstanceOf(Uint8Array);
    expect(Array.from(value as Uint8Array)).toEqual([0, 1, 2, 255]);
  });

  it('returns binary data when no encoding is provided', () => {
    const vfs = new VirtualFS();
    vfs.writeFileSync('/project/data.bin', new Uint8Array([10, 20, 30]));
    const fs = createFsShim(vfs);

    const value = fs.readFileSync('/project/data.bin');
    expect(value).toBeInstanceOf(Uint8Array);
    expect(Array.from(value as Uint8Array)).toEqual([10, 20, 30]);
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
