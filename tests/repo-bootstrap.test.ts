import { afterEach, describe, expect, it, vi } from 'vitest';
import pako from 'pako';
import { VirtualFS } from '../src/virtual-fs';
import { bootstrapGitHubProject } from '../src/repo/bootstrap';

describe('bootstrapGitHubProject', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('imports repo and installs dependencies in one flow', async () => {
    const vfs = new VirtualFS();
    const repoArchive = pako.gzip(
      createMinimalTarball({
        'package/package.json': JSON.stringify({
          name: 'demo-app',
          version: '1.0.0',
          dependencies: {
            'tiny-pkg': '^1.0.0',
          },
        }),
        'package/index.js': 'module.exports = require("tiny-pkg");',
      })
    );

    const tinyManifest = {
      name: 'tiny-pkg',
      'dist-tags': { latest: '1.2.0' },
      versions: {
        '1.2.0': {
          name: 'tiny-pkg',
          version: '1.2.0',
          dist: {
            tarball: 'https://registry.npmjs.org/tiny-pkg/-/tiny-pkg-1.2.0.tgz',
            shasum: 'abc123',
          },
          dependencies: {},
        },
      },
    };

    const tinyArchive = pako.gzip(
      createMinimalTarball({
        'package/package.json': '{"name":"tiny-pkg","version":"1.2.0"}',
        'package/index.js': 'module.exports = "tiny";',
      })
    );

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr === 'https://codeload.github.com/acme/demo/tar.gz/HEAD') {
        return new Response(repoArchive, { status: 200 });
      }
      if (urlStr.includes('registry.npmjs.org/tiny-pkg') && !urlStr.includes('.tgz')) {
        return new Response(JSON.stringify(tinyManifest), { status: 200 });
      }
      if (urlStr.includes('tiny-pkg-1.2.0.tgz')) {
        return new Response(tinyArchive, { status: 200 });
      }
      return new Response('not-found', { status: 404 });
    });

    const result = await bootstrapGitHubProject(vfs, 'https://github.com/acme/demo');

    expect(result.rootPath).toBe('/project');
    expect(result.projectPath).toBe('/project');
    expect(result.installResult?.installed.get('tiny-pkg')?.version).toBe('1.2.0');
    expect(vfs.existsSync('/project/node_modules/tiny-pkg/package.json')).toBe(true);
  });

  it('supports skipInstall for clone-only flow', async () => {
    const vfs = new VirtualFS();
    const repoArchive = pako.gzip(
      createMinimalTarball({
        'package/package.json': '{"name":"demo","version":"1.0.0"}',
      })
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr === 'https://codeload.github.com/acme/demo/tar.gz/HEAD') {
        return new Response(repoArchive, { status: 200 });
      }
      return new Response('not-found', { status: 404 });
    });

    const result = await bootstrapGitHubProject(vfs, 'https://github.com/acme/demo', {
      skipInstall: true,
    });

    expect(result.installResult).toBeUndefined();
    expect(vfs.existsSync('/project/package.json')).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('transforms project TypeScript sources during bootstrap', async () => {
    const vfs = new VirtualFS();
    const repoArchive = pako.gzip(
      createMinimalTarball({
        'package/package.json': JSON.stringify({
          name: 'ts-app',
          version: '1.0.0',
        }),
        'package/src/constants.ts': `
          export enum Env {
            Development = "development",
            Production = "production"
          }
        `,
      })
    );

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr === 'https://codeload.github.com/acme/demo/tar.gz/HEAD') {
        return new Response(repoArchive, { status: 200 });
      }
      return new Response('not-found', { status: 404 });
    });

    const result = await bootstrapGitHubProject(vfs, 'https://github.com/acme/demo');

    expect(result.transformedProjectFiles).toBeGreaterThan(0);
    const transformed = vfs.readFileSync('/project/src/constants.ts', 'utf8');
    expect(transformed).not.toContain('export enum');
    expect(transformed).toContain('Development');
  });

  it('skips project source transform when transformProjectSources is false', async () => {
    const vfs = new VirtualFS();
    const repoArchive = pako.gzip(
      createMinimalTarball({
        'package/package.json': JSON.stringify({
          name: 'ts-app',
          version: '1.0.0',
        }),
        'package/src/constants.ts': `
          export enum Env {
            Development = "development",
            Production = "production"
          }
        `,
      })
    );

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr === 'https://codeload.github.com/acme/demo/tar.gz/HEAD') {
        return new Response(repoArchive, { status: 200 });
      }
      return new Response('not-found', { status: 404 });
    });

    const result = await bootstrapGitHubProject(vfs, 'https://github.com/acme/demo', {
      transformProjectSources: false,
    });

    expect(result.transformedProjectFiles ?? 0).toBe(0);
    const source = vfs.readFileSync('/project/src/constants.ts', 'utf8');
    expect(source).toContain('export enum Env');
  });
});

function createMinimalTarball(files: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];

  for (const [filename, content] of Object.entries(files)) {
    const contentBytes = encoder.encode(content);
    const header = new Uint8Array(512);

    const nameBytes = encoder.encode(filename);
    header.set(nameBytes.slice(0, 100), 0);
    header.set(encoder.encode('0000644\0'), 100);
    header.set(encoder.encode('0000000\0'), 108);
    header.set(encoder.encode('0000000\0'), 116);

    const sizeOctal = contentBytes.length.toString(8).padStart(11, '0') + ' ';
    header.set(encoder.encode(sizeOctal), 124);
    header.set(encoder.encode('00000000000\0'), 136);
    header.set(encoder.encode('        '), 148);
    header[156] = 48;

    let checksum = 0;
    for (let i = 0; i < 512; i++) {
      checksum += header[i];
    }
    const checksumStr = checksum.toString(8).padStart(6, '0') + '\0 ';
    header.set(encoder.encode(checksumStr), 148);

    chunks.push(header);

    const paddedSize = Math.ceil(contentBytes.length / 512) * 512;
    const paddedContent = new Uint8Array(paddedSize);
    paddedContent.set(contentBytes);
    chunks.push(paddedContent);
  }

  chunks.push(new Uint8Array(1024));

  const totalSize = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}
