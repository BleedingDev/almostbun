import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import {
  parseVersion,
  compareVersions,
  satisfies,
  findBestVersion,
} from '../src/npm/resolver';
import { extractTarball, decompress } from '../src/npm/tarball';
import {
  parseBunLockObject,
  parseDependencySpec,
  parsePackageSpec,
  PackageManager,
} from '../src/npm';
import pako from 'pako';

describe('npm', () => {
  describe('semver', () => {
    describe('parseVersion', () => {
      it('should parse standard versions', () => {
        expect(parseVersion('1.2.3')).toEqual({
          major: 1,
          minor: 2,
          patch: 3,
          prerelease: undefined,
        });
      });

      it('should parse prerelease versions', () => {
        expect(parseVersion('1.0.0-alpha.1')).toEqual({
          major: 1,
          minor: 0,
          patch: 0,
          prerelease: 'alpha.1',
        });
      });

      it('should return null for invalid versions', () => {
        expect(parseVersion('invalid')).toBeNull();
        expect(parseVersion('1.2')).toBeNull();
        expect(parseVersion('v1.2.3')).toBeNull();
      });
    });

    describe('compareVersions', () => {
      it('should compare major versions', () => {
        expect(compareVersions('2.0.0', '1.0.0')).toBeGreaterThan(0);
        expect(compareVersions('1.0.0', '2.0.0')).toBeLessThan(0);
      });

      it('should compare minor versions', () => {
        expect(compareVersions('1.2.0', '1.1.0')).toBeGreaterThan(0);
        expect(compareVersions('1.1.0', '1.2.0')).toBeLessThan(0);
      });

      it('should compare patch versions', () => {
        expect(compareVersions('1.0.2', '1.0.1')).toBeGreaterThan(0);
        expect(compareVersions('1.0.1', '1.0.2')).toBeLessThan(0);
      });

      it('should return 0 for equal versions', () => {
        expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
      });

      it('should rank prerelease lower than release', () => {
        expect(compareVersions('1.0.0-alpha', '1.0.0')).toBeLessThan(0);
        expect(compareVersions('1.0.0', '1.0.0-alpha')).toBeGreaterThan(0);
      });
    });

    describe('satisfies', () => {
      it('should match exact versions', () => {
        expect(satisfies('1.2.3', '1.2.3')).toBe(true);
        expect(satisfies('1.2.3', '1.2.4')).toBe(false);
      });

      it('should match caret ranges', () => {
        expect(satisfies('1.2.3', '^1.0.0')).toBe(true);
        expect(satisfies('1.9.9', '^1.0.0')).toBe(true);
        expect(satisfies('2.0.0', '^1.0.0')).toBe(false);
        expect(satisfies('0.9.0', '^1.0.0')).toBe(false);
      });

      it('should match shorthand caret ranges', () => {
        expect(satisfies('4.2.1', '^4')).toBe(true);
        expect(satisfies('4.0.0', '^4')).toBe(true);
        expect(satisfies('5.0.0', '^4')).toBe(false);
      });

      it('should match tilde ranges', () => {
        expect(satisfies('1.2.3', '~1.2.0')).toBe(true);
        expect(satisfies('1.2.9', '~1.2.0')).toBe(true);
        expect(satisfies('1.3.0', '~1.2.0')).toBe(false);
      });

      it('should match shorthand tilde ranges', () => {
        expect(satisfies('4.5.0', '~4')).toBe(true);
        expect(satisfies('4.0.1', '~4')).toBe(true);
        expect(satisfies('5.0.0', '~4')).toBe(false);
      });

      it('should match >= ranges', () => {
        expect(satisfies('1.2.3', '>=1.0.0')).toBe(true);
        expect(satisfies('1.0.0', '>=1.0.0')).toBe(true);
        expect(satisfies('0.9.9', '>=1.0.0')).toBe(false);
      });

      it('should match > ranges', () => {
        expect(satisfies('1.0.1', '>1.0.0')).toBe(true);
        expect(satisfies('1.0.0', '>1.0.0')).toBe(false);
      });

      it('should match <= ranges', () => {
        expect(satisfies('1.0.0', '<=1.0.0')).toBe(true);
        expect(satisfies('0.9.9', '<=1.0.0')).toBe(true);
        expect(satisfies('1.0.1', '<=1.0.0')).toBe(false);
      });

      it('should match < ranges', () => {
        expect(satisfies('0.9.9', '<1.0.0')).toBe(true);
        expect(satisfies('1.0.0', '<1.0.0')).toBe(false);
      });

      it('should match * and latest', () => {
        expect(satisfies('1.0.0', '*')).toBe(true);
        expect(satisfies('999.0.0', '*')).toBe(true);
        expect(satisfies('1.0.0', 'latest')).toBe(true);
      });

      it('should match || ranges', () => {
        expect(satisfies('1.0.0', '1.0.0 || 2.0.0')).toBe(true);
        expect(satisfies('2.0.0', '1.0.0 || 2.0.0')).toBe(true);
        expect(satisfies('3.0.0', '1.0.0 || 2.0.0')).toBe(false);
      });

      it('should match hyphen ranges', () => {
        expect(satisfies('1.5.0', '1.0.0 - 2.0.0')).toBe(true);
        expect(satisfies('1.0.0', '1.0.0 - 2.0.0')).toBe(true);
        expect(satisfies('2.0.0', '1.0.0 - 2.0.0')).toBe(true);
        expect(satisfies('2.0.1', '1.0.0 - 2.0.0')).toBe(false);
      });

      it('should skip prerelease versions by default', () => {
        expect(satisfies('1.0.0-alpha', '^1.0.0')).toBe(false);
      });
    });

    describe('findBestVersion', () => {
      const versions = ['1.0.0', '1.1.0', '1.2.0', '2.0.0', '2.1.0'];

      it('should find highest matching version for caret', () => {
        expect(findBestVersion(versions, '^1.0.0')).toBe('1.2.0');
      });

      it('should find highest matching version for shorthand caret', () => {
        expect(findBestVersion(versions, '^2')).toBe('2.1.0');
      });

      it('should find highest matching version for tilde', () => {
        expect(findBestVersion(versions, '~1.0.0')).toBe('1.0.0');
        expect(findBestVersion(versions, '~1.1.0')).toBe('1.1.0');
      });

      it('should return null if no match', () => {
        expect(findBestVersion(versions, '^3.0.0')).toBeNull();
      });
    });
  });

  describe('parsePackageSpec', () => {
    it('should parse package name only', () => {
      expect(parsePackageSpec('express')).toEqual({ name: 'express' });
    });

    it('should parse package with version', () => {
      expect(parsePackageSpec('express@4.18.2')).toEqual({
        name: 'express',
        version: '4.18.2',
      });
    });

    it('should parse scoped package', () => {
      expect(parsePackageSpec('@types/node')).toEqual({
        name: '@types/node',
      });
    });

    it('should parse scoped package with version', () => {
      expect(parsePackageSpec('@types/node@18.0.0')).toEqual({
        name: '@types/node',
        version: '18.0.0',
      });
    });

    it('should parse version ranges', () => {
      expect(parsePackageSpec('express@^4.0.0')).toEqual({
        name: 'express',
        version: '^4.0.0',
      });
    });
  });

  describe('parseDependencySpec', () => {
    it('should parse registry dependency specs', () => {
      expect(parseDependencySpec('react', '^19.0.0')).toEqual({
        name: 'react',
        protocol: 'registry',
        rawSpec: '^19.0.0',
        versionRange: '^19.0.0',
      });
    });

    it('should parse workspace protocol', () => {
      expect(parseDependencySpec('shared', 'workspace:*')).toEqual({
        name: 'shared',
        protocol: 'workspace',
        rawSpec: 'workspace:*',
        target: '*',
      });
    });

    it('should parse local file protocol', () => {
      expect(parseDependencySpec('local-lib', 'file:../packages/local-lib')).toEqual({
        name: 'local-lib',
        protocol: 'file',
        rawSpec: 'file:../packages/local-lib',
        target: '../packages/local-lib',
      });
    });

    it('should parse github dependency protocol', () => {
      expect(parseDependencySpec('repo-lib', 'github:acme/repo-lib#main')).toEqual({
        name: 'repo-lib',
        protocol: 'github',
        rawSpec: 'github:acme/repo-lib#main',
        target: 'github:acme/repo-lib#main',
      });
    });

    it('should parse npm alias dependency protocol', () => {
      expect(parseDependencySpec('alias-lib', 'npm:real-lib@^2.1.0')).toEqual({
        name: 'alias-lib',
        protocol: 'npm',
        rawSpec: 'npm:real-lib@^2.1.0',
        target: 'real-lib@^2.1.0',
      });
    });

    it('should parse scoped npm alias dependency protocol', () => {
      expect(parseDependencySpec('alias-lib', 'npm:@scope/real-lib@1.0.0')).toEqual({
        name: 'alias-lib',
        protocol: 'npm',
        rawSpec: 'npm:@scope/real-lib@1.0.0',
        target: '@scope/real-lib@1.0.0',
      });
    });
  });

  describe('parseBunLockObject', () => {
    it('should parse bun.lock package keys into node_modules install paths', () => {
      const parsed = parseBunLockObject(
        {
          lockfileVersion: 1,
          workspaces: {
            '': {
              dependencies: {
                parent: '1.0.0',
                '@scope/pkg': '2.0.0',
              },
            },
          },
          packages: {
            parent: ['parent@1.0.0', '', { dependencies: { child: '1.0.0' } }, 'sha512-parent'],
            'parent/child': ['child@1.0.0', '', {}, 'sha512-child'],
            '@scope/pkg': ['@scope/pkg@2.0.0', '', {}, 'sha512-scope'],
          },
        },
        '/project'
      );

      expect(parsed).not.toBeNull();
      const keys = (parsed?.entries || []).map((entry) => entry.key);
      expect(keys).toContain('node_modules/parent');
      expect(keys).toContain('node_modules/parent/node_modules/child');
      expect(keys).toContain('node_modules/@scope/pkg');
    });

    it('should include required peerDependencies and skip optional peers', () => {
      const parsed = parseBunLockObject(
        {
          lockfileVersion: 1,
          workspaces: {
            '': {
              dependencies: {
                app: '1.0.0',
              },
            },
          },
          packages: {
            app: [
              'app@1.0.0',
              '',
              {
                peerDependencies: {
                  'peer-required': '^1.0.0',
                  'peer-optional': '^1.0.0',
                },
                optionalPeers: ['peer-optional'],
              },
              'sha512-app',
            ],
            'peer-required': ['peer-required@1.0.0', '', {}, 'sha512-required'],
            'peer-optional': ['peer-optional@1.0.0', '', {}, 'sha512-optional'],
          },
        },
        '/project'
      );

      expect(parsed).not.toBeNull();
      const keys = (parsed?.entries || []).map((entry) => entry.key);
      expect(keys).toContain('node_modules/app');
      expect(keys).toContain('node_modules/peer-required');
      expect(keys).not.toContain('node_modules/peer-optional');
    });
  });

  describe('tarball extraction', () => {
    let vfs: VirtualFS;

    beforeEach(() => {
      vfs = new VirtualFS();
    });

    it('should decompress gzipped data', () => {
      const original = new TextEncoder().encode('hello world');
      const compressed = pako.gzip(original);
      const decompressed = decompress(compressed);
      expect(new TextDecoder().decode(decompressed)).toBe('hello world');
    });

    it('should extract tarball to VFS', () => {
      // Create a minimal tar archive with package/ prefix
      const tarball = createMinimalTarball({
        'package/package.json': '{"name":"test","version":"1.0.0"}',
        'package/index.js': 'module.exports = 42;',
      });

      // Gzip it
      const compressed = pako.gzip(tarball);

      // Extract to /node_modules/test
      const files = extractTarball(compressed, vfs, '/node_modules/test');

      expect(vfs.existsSync('/node_modules/test/package.json')).toBe(true);
      expect(vfs.existsSync('/node_modules/test/index.js')).toBe(true);

      const pkgJson = JSON.parse(
        vfs.readFileSync('/node_modules/test/package.json', 'utf8')
      );
      expect(pkgJson.name).toBe('test');
      expect(pkgJson.version).toBe('1.0.0');

      expect(vfs.readFileSync('/node_modules/test/index.js', 'utf8')).toBe(
        'module.exports = 42;'
      );
    });

    it('should strip leading path components', () => {
      const tarball = createMinimalTarball({
        'package/lib/utils.js': 'exports.util = true;',
      });
      const compressed = pako.gzip(tarball);

      extractTarball(compressed, vfs, '/pkg', { stripComponents: 1 });

      expect(vfs.existsSync('/pkg/lib/utils.js')).toBe(true);
      expect(vfs.existsSync('/pkg/package')).toBe(false);
    });

    it('should apply filter function', () => {
      const tarball = createMinimalTarball({
        'package/index.js': 'code',
        'package/test.js': 'test code',
        'package/README.md': 'readme',
      });
      const compressed = pako.gzip(tarball);

      extractTarball(compressed, vfs, '/pkg', {
        stripComponents: 1,
        filter: (path) => path.endsWith('.js'),
      });

      expect(vfs.existsSync('/pkg/index.js')).toBe(true);
      expect(vfs.existsSync('/pkg/test.js')).toBe(true);
      expect(vfs.existsSync('/pkg/README.md')).toBe(false);
    });

    it('should extract symbolic links from tarballs', () => {
      const tarball = createMinimalTarball({
        'package/index.js': 'module.exports = 1;',
        'package/index-link.js': { type: 'symlink', target: 'index.js' },
      });
      const compressed = pako.gzip(tarball);

      extractTarball(compressed, vfs, '/pkg', { stripComponents: 1 });

      expect(vfs.lstatSync('/pkg/index-link.js').isSymbolicLink()).toBe(true);
      expect(vfs.readlinkSync('/pkg/index-link.js')).toBe('index.js');
      expect(vfs.readFileSync('/pkg/index-link.js', 'utf8')).toBe('module.exports = 1;');
    });
  });

  describe('PackageManager', () => {
    let vfs: VirtualFS;
    let pm: PackageManager;

    beforeEach(() => {
      vfs = new VirtualFS();
      pm = new PackageManager(vfs);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should list installed packages', () => {
      // Manually set up installed packages
      vfs.writeFileSync(
        '/node_modules/express/package.json',
        '{"name":"express","version":"4.18.2"}'
      );
      vfs.writeFileSync(
        '/node_modules/lodash/package.json',
        '{"name":"lodash","version":"4.17.21"}'
      );

      const packages = pm.list();

      expect(packages).toEqual({
        express: '4.18.2',
        lodash: '4.17.21',
      });
    });

    it('should list scoped packages', () => {
      vfs.writeFileSync(
        '/node_modules/@types/node/package.json',
        '{"name":"@types/node","version":"18.0.0"}'
      );

      const packages = pm.list();

      expect(packages).toEqual({
        '@types/node': '18.0.0',
      });
    });

    it('should return empty object when no packages installed', () => {
      expect(pm.list()).toEqual({});
    });

    it('should install package with mocked fetch', async () => {
      // Mock fetch responses
      const mockManifest = {
        name: 'tiny-pkg',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            name: 'tiny-pkg',
            version: '1.0.0',
            dist: {
              tarball: 'https://registry.npmjs.org/tiny-pkg/-/tiny-pkg-1.0.0.tgz',
              shasum: 'abc123',
            },
            dependencies: {},
          },
        },
      };

      const tarballContent = createMinimalTarball({
        'package/package.json': '{"name":"tiny-pkg","version":"1.0.0"}',
        'package/index.js': 'module.exports = "tiny";',
      });
      const compressedTarball = pako.gzip(tarballContent);

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const urlStr = url.toString();
        if (urlStr.includes('registry.npmjs.org/tiny-pkg') && !urlStr.includes('.tgz')) {
          return new Response(JSON.stringify(mockManifest), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (urlStr.includes('.tgz')) {
          return new Response(compressedTarball, { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const result = await pm.install('tiny-pkg');

      expect(result.installed.size).toBe(1);
      expect(result.installed.has('tiny-pkg')).toBe(true);
      expect(vfs.existsSync('/node_modules/tiny-pkg/package.json')).toBe(true);
      expect(vfs.existsSync('/node_modules/tiny-pkg/index.js')).toBe(true);

      const pkgJson = JSON.parse(
        vfs.readFileSync('/node_modules/tiny-pkg/package.json', 'utf8')
      );
      expect(pkgJson.version).toBe('1.0.0');
    });

    it('should resolve and install dependencies', async () => {
      const manifestA = {
        name: 'pkg-a',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            name: 'pkg-a',
            version: '1.0.0',
            dist: {
              tarball: 'https://registry.npmjs.org/pkg-a/-/pkg-a-1.0.0.tgz',
              shasum: 'abc',
            },
            dependencies: {
              'pkg-b': '^1.0.0',
            },
          },
        },
      };

      const manifestB = {
        name: 'pkg-b',
        'dist-tags': { latest: '1.2.0' },
        versions: {
          '1.0.0': {
            name: 'pkg-b',
            version: '1.0.0',
            dist: {
              tarball: 'https://registry.npmjs.org/pkg-b/-/pkg-b-1.0.0.tgz',
              shasum: 'def',
            },
            dependencies: {},
          },
          '1.2.0': {
            name: 'pkg-b',
            version: '1.2.0',
            dist: {
              tarball: 'https://registry.npmjs.org/pkg-b/-/pkg-b-1.2.0.tgz',
              shasum: 'ghi',
            },
            dependencies: {},
          },
        },
      };

      const tarballA = pako.gzip(
        createMinimalTarball({
          'package/package.json': '{"name":"pkg-a","version":"1.0.0"}',
        })
      );

      const tarballB = pako.gzip(
        createMinimalTarball({
          'package/package.json': '{"name":"pkg-b","version":"1.2.0"}',
        })
      );

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const urlStr = url.toString();
        if (urlStr.includes('/pkg-a') && !urlStr.includes('.tgz')) {
          return new Response(JSON.stringify(manifestA), { status: 200 });
        }
        if (urlStr.includes('/pkg-b') && !urlStr.includes('.tgz')) {
          return new Response(JSON.stringify(manifestB), { status: 200 });
        }
        if (urlStr.includes('pkg-a-1.0.0.tgz')) {
          return new Response(tarballA, { status: 200 });
        }
        if (urlStr.includes('pkg-b-1.2.0.tgz')) {
          return new Response(tarballB, { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const result = await pm.install('pkg-a');

      expect(result.installed.size).toBe(2);
      expect(result.installed.has('pkg-a')).toBe(true);
      expect(result.installed.has('pkg-b')).toBe(true);

      // Should install the highest compatible version of pkg-b
      const pkgB = result.installed.get('pkg-b');
      expect(pkgB?.version).toBe('1.2.0');

      expect(vfs.existsSync('/node_modules/pkg-a/package.json')).toBe(true);
      expect(vfs.existsSync('/node_modules/pkg-b/package.json')).toBe(true);
    });

    it('should resolve and install non-optional peer dependencies', async () => {
      const pluginManifest = {
        name: 'plugin-pkg',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            name: 'plugin-pkg',
            version: '1.0.0',
            dist: {
              tarball: 'https://registry.npmjs.org/plugin-pkg/-/plugin-pkg-1.0.0.tgz',
              shasum: 'plugin',
            },
            dependencies: {},
            peerDependencies: {
              '@sinclair/typebox': '^0.34.0',
            },
          },
        },
      };

      const typeboxManifest = {
        name: '@sinclair/typebox',
        'dist-tags': { latest: '0.34.0' },
        versions: {
          '0.34.0': {
            name: '@sinclair/typebox',
            version: '0.34.0',
            dist: {
              tarball: 'https://registry.npmjs.org/@sinclair/typebox/-/typebox-0.34.0.tgz',
              shasum: 'typebox',
            },
            dependencies: {},
          },
        },
      };

      const pluginTarball = pako.gzip(
        createMinimalTarball({
          'package/package.json': '{"name":"plugin-pkg","version":"1.0.0"}',
          'package/index.js': 'module.exports = "plugin";',
        })
      );
      const typeboxTarball = pako.gzip(
        createMinimalTarball({
          'package/package.json': '{"name":"@sinclair/typebox","version":"0.34.0"}',
          'package/index.js': 'module.exports = "typebox";',
        })
      );

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const urlStr = url.toString();
        if (urlStr.includes('/plugin-pkg') && !urlStr.includes('.tgz')) {
          return new Response(JSON.stringify(pluginManifest), { status: 200 });
        }
        if (urlStr.includes('/@sinclair%2ftypebox') && !urlStr.includes('.tgz')) {
          return new Response(JSON.stringify(typeboxManifest), { status: 200 });
        }
        if (urlStr.endsWith('/plugin-pkg-1.0.0.tgz')) {
          return new Response(pluginTarball, { status: 200 });
        }
        if (urlStr.endsWith('/typebox-0.34.0.tgz')) {
          return new Response(typeboxTarball, { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const result = await pm.install('plugin-pkg');
      expect(result.installed.has('plugin-pkg')).toBe(true);
      expect(result.installed.has('@sinclair/typebox')).toBe(true);
      expect(vfs.existsSync('/node_modules/@sinclair/typebox/package.json')).toBe(true);
    });

    it('should install workspace dependencies without registry fetch', async () => {
      vfs.writeFileSync(
        '/package.json',
        JSON.stringify({
          name: 'root',
          private: true,
          workspaces: ['packages/*'],
          dependencies: {
            app: 'workspace:*',
          },
        })
      );
      vfs.writeFileSync(
        '/packages/app/package.json',
        JSON.stringify({
          name: 'app',
          version: '1.0.0',
          dependencies: {
            shared: 'workspace:*',
          },
        })
      );
      vfs.writeFileSync('/packages/app/index.js', 'module.exports = require("shared");');
      vfs.writeFileSync(
        '/packages/shared/package.json',
        JSON.stringify({
          name: 'shared',
          version: '1.0.0',
        })
      );
      vfs.writeFileSync('/packages/shared/index.js', 'module.exports = "shared";');

      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const result = await pm.installFromPackageJson();

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(vfs.existsSync('/node_modules/app/package.json')).toBe(true);
      expect(vfs.existsSync('/node_modules/shared/package.json')).toBe(true);
      expect(vfs.existsSync('/packages/app/node_modules/shared/package.json')).toBe(true);
      expect(result.added).toContain('app');
      expect(result.added).toContain('shared');
    });

    it('resolves workspace dependencies from ancestor monorepo root when cwd is a workspace package', async () => {
      vfs.writeFileSync(
        '/repo/package.json',
        JSON.stringify({
          name: 'modern-monorepo',
          private: true,
          workspaces: ['packages/*', 'tests/integration/*'],
        })
      );
      vfs.writeFileSync(
        '/repo/packages/runtime/package.json',
        JSON.stringify({
          name: '@modern-js/runtime',
          version: '1.0.0',
        })
      );
      vfs.writeFileSync('/repo/packages/runtime/index.js', 'module.exports = "runtime";');
      vfs.writeFileSync(
        '/repo/tests/integration/basic-app/package.json',
        JSON.stringify({
          name: 'basic-app',
          version: '1.0.0',
          dependencies: {
            '@modern-js/runtime': 'workspace:*',
          },
        })
      );
      vfs.writeFileSync('/repo/tests/integration/basic-app/index.js', 'require("@modern-js/runtime");');

      const nestedPm = new PackageManager(vfs, {
        cwd: '/repo/tests/integration/basic-app',
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const result = await nestedPm.installFromPackageJson();

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(vfs.existsSync('/repo/tests/integration/basic-app/node_modules/@modern-js/runtime/package.json')).toBe(true);
      expect(result.added).toContain('@modern-js/runtime');
    });

    it('can use published packages for workspace dependencies when local build output is missing', async () => {
      vfs.writeFileSync(
        '/repo/package.json',
        JSON.stringify({
          name: 'repo',
          private: true,
          workspaces: ['packages/*'],
        })
      );
      vfs.writeFileSync(
        '/repo/packages/app/package.json',
        JSON.stringify({
          name: 'app',
          version: '1.0.0',
          dependencies: {
            shared: 'workspace:*',
          },
        })
      );
      vfs.writeFileSync(
        '/repo/packages/shared/package.json',
        JSON.stringify({
          name: 'shared',
          version: '1.2.3',
          main: './dist/index.js',
        })
      );
      vfs.writeFileSync('/repo/packages/shared/src/index.ts', 'export const value = 1;');

      const sharedManifest = {
        name: 'shared',
        'dist-tags': { latest: '1.2.3' },
        versions: {
          '1.2.3': {
            name: 'shared',
            version: '1.2.3',
            dist: {
              tarball: 'https://registry.npmjs.org/shared/-/shared-1.2.3.tgz',
              shasum: 'abc123',
            },
            dependencies: {},
          },
        },
      };

      const sharedTarball = pako.gzip(
        createMinimalTarball({
          'package/package.json': JSON.stringify({
            name: 'shared',
            version: '1.2.3',
            main: './index.js',
          }),
          'package/index.js': 'module.exports = "shared-registry";',
        })
      );

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const urlStr = url.toString();
        if (urlStr.includes('/shared') && !urlStr.endsWith('.tgz')) {
          return new Response(JSON.stringify(sharedManifest), { status: 200 });
        }
        if (urlStr.endsWith('/shared-1.2.3.tgz')) {
          return new Response(sharedTarball, { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const nestedPm = new PackageManager(vfs, { cwd: '/repo/packages/app' });
      const result = await nestedPm.installFromPackageJson({
        preferPublishedWorkspacePackages: true,
      });

      expect(vfs.existsSync('/repo/packages/app/node_modules/shared/index.js')).toBe(true);
      const installedManifest = JSON.parse(
        vfs.readFileSync('/repo/packages/app/node_modules/shared/package.json', 'utf8')
      );
      expect(installedManifest.version).toBe('1.2.3');
      expect(result.added).toContain('shared');
    });

    it('can use published packages when workspace bin references missing build files', async () => {
      vfs.writeFileSync(
        '/repo/package.json',
        JSON.stringify({
          name: 'repo',
          private: true,
          workspaces: ['packages/*'],
        })
      );
      vfs.writeFileSync(
        '/repo/packages/app/package.json',
        JSON.stringify({
          name: 'app',
          version: '1.0.0',
          dependencies: {
            'tooling-cli': 'workspace:*',
          },
        })
      );
      vfs.writeFileSync(
        '/repo/packages/tooling-cli/package.json',
        JSON.stringify({
          name: 'tooling-cli',
          version: '2.0.0',
          main: './index.js',
          bin: {
            tooling: './bin/tooling.js',
          },
        })
      );
      vfs.writeFileSync('/repo/packages/tooling-cli/index.js', 'module.exports = "local";');
      vfs.writeFileSync(
        '/repo/packages/tooling-cli/bin/tooling.js',
        'require("../dist/cjs/run/index.js");'
      );

      const toolingManifest = {
        name: 'tooling-cli',
        'dist-tags': { latest: '2.0.0' },
        versions: {
          '2.0.0': {
            name: 'tooling-cli',
            version: '2.0.0',
            dist: {
              tarball: 'https://registry.npmjs.org/tooling-cli/-/tooling-cli-2.0.0.tgz',
              shasum: 'abc123',
            },
            dependencies: {},
          },
        },
      };

      const toolingTarball = pako.gzip(
        createMinimalTarball({
          'package/package.json': JSON.stringify({
            name: 'tooling-cli',
            version: '2.0.0',
            bin: {
              tooling: './bin/tooling.js',
            },
          }),
          'package/bin/tooling.js': 'require("../dist/cjs/run/index.js");',
          'package/dist/cjs/run/index.js': 'module.exports = "ok";',
        })
      );

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const urlStr = url.toString();
        if (urlStr.includes('/tooling-cli') && !urlStr.endsWith('.tgz')) {
          return new Response(JSON.stringify(toolingManifest), { status: 200 });
        }
        if (urlStr.endsWith('/tooling-cli-2.0.0.tgz')) {
          return new Response(toolingTarball, { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const nestedPm = new PackageManager(vfs, { cwd: '/repo/packages/app' });
      const result = await nestedPm.installFromPackageJson({
        preferPublishedWorkspacePackages: true,
      });

      expect(vfs.existsSync('/repo/packages/app/node_modules/tooling-cli/dist/cjs/run/index.js')).toBe(true);
      expect(result.added).toContain('tooling-cli');
    });

    it('resolves pnpm-workspace.yaml packages when package.json has no workspaces field', async () => {
      vfs.writeFileSync(
        '/repo/package.json',
        JSON.stringify({
          name: 'pnpm-workspace-root',
          private: true,
        })
      );
      vfs.writeFileSync(
        '/repo/pnpm-workspace.yaml',
        `packages:\n  - packages/*\n  - tests/integration/*\n`
      );
      vfs.writeFileSync(
        '/repo/packages/runtime/package.json',
        JSON.stringify({
          name: '@modern-js/runtime',
          version: '1.0.0',
        })
      );
      vfs.writeFileSync('/repo/packages/runtime/index.js', 'module.exports = "runtime";');
      vfs.writeFileSync(
        '/repo/tests/integration/basic-app/package.json',
        JSON.stringify({
          name: 'basic-app',
          version: '1.0.0',
          dependencies: {
            '@modern-js/runtime': 'workspace:*',
          },
        })
      );

      const nestedPm = new PackageManager(vfs, {
        cwd: '/repo/tests/integration/basic-app',
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const result = await nestedPm.installFromPackageJson();

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(vfs.existsSync('/repo/tests/integration/basic-app/node_modules/@modern-js/runtime/package.json')).toBe(true);
      expect(result.added).toContain('@modern-js/runtime');
    });

    it('does not install every workspace package when cwd is a nested workspace', async () => {
      vfs.writeFileSync(
        '/repo/package.json',
        JSON.stringify({
          name: 'root',
          private: true,
          workspaces: ['packages/*'],
        })
      );
      vfs.writeFileSync(
        '/repo/packages/app/package.json',
        JSON.stringify({
          name: 'app',
          version: '1.0.0',
          dependencies: {
            shared: 'workspace:*',
          },
        })
      );
      vfs.writeFileSync(
        '/repo/packages/shared/package.json',
        JSON.stringify({
          name: 'shared',
          version: '1.0.0',
        })
      );
      vfs.writeFileSync(
        '/repo/packages/unused/package.json',
        JSON.stringify({
          name: 'unused',
          version: '1.0.0',
          dependencies: {
            'left-pad': '^1.3.0',
          },
        })
      );

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        throw new Error('registry fetch should not happen for unrelated workspace package');
      });

      const nestedPm = new PackageManager(vfs, { cwd: '/repo/packages/app' });
      const result = await nestedPm.installFromPackageJson();

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(vfs.existsSync('/repo/packages/app/node_modules/shared/package.json')).toBe(true);
      expect(vfs.existsSync('/repo/packages/app/node_modules/unused/package.json')).toBe(false);
      expect(result.added).toContain('shared');
    });

    it('does not fail on duplicate workspace package names when workspace linking is not needed', async () => {
      vfs.writeFileSync(
        '/repo/package.json',
        JSON.stringify({
          name: 'root',
          private: true,
          workspaces: ['packages/*', 'playground/*'],
        })
      );
      vfs.writeFileSync(
        '/repo/packages/app/package.json',
        JSON.stringify({
          name: 'app',
          version: '1.0.0',
          dependencies: {},
        })
      );
      vfs.writeFileSync(
        '/repo/playground/dup-a/package.json',
        JSON.stringify({
          name: '@scope/dup',
          version: '1.0.0',
        })
      );
      vfs.writeFileSync(
        '/repo/playground/dup-b/package.json',
        JSON.stringify({
          name: '@scope/dup',
          version: '1.0.0',
        })
      );

      const nestedPm = new PackageManager(vfs, { cwd: '/repo/packages/app' });
      const result = await nestedPm.installFromPackageJson();
      expect(result.added).toEqual([]);
    });

    it('should install file: dependencies and their registry dependencies', async () => {
      vfs.writeFileSync(
        '/package.json',
        JSON.stringify({
          name: 'root',
          dependencies: {
            'local-lib': 'file:./vendor/local-lib',
          },
        })
      );
      vfs.writeFileSync(
        '/vendor/local-lib/package.json',
        JSON.stringify({
          name: 'local-lib',
          version: '1.0.0',
          dependencies: {
            'tiny-pkg': '^1.0.0',
          },
        })
      );
      vfs.writeFileSync('/vendor/local-lib/index.js', 'module.exports = require("tiny-pkg");');

      const tinyManifest = {
        name: 'tiny-pkg',
        'dist-tags': { latest: '1.1.0' },
        versions: {
          '1.1.0': {
            name: 'tiny-pkg',
            version: '1.1.0',
            dist: {
              tarball: 'https://registry.npmjs.org/tiny-pkg/-/tiny-pkg-1.1.0.tgz',
              shasum: 'abc123',
            },
            dependencies: {},
          },
        },
      };

      const tinyTarball = pako.gzip(
        createMinimalTarball({
          'package/package.json': '{"name":"tiny-pkg","version":"1.1.0"}',
          'package/index.js': 'module.exports = "tiny";',
        })
      );

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const urlStr = url.toString();
        if (urlStr.includes('registry.npmjs.org/tiny-pkg') && !urlStr.includes('.tgz')) {
          return new Response(JSON.stringify(tinyManifest), { status: 200 });
        }
        if (urlStr.includes('tiny-pkg-1.1.0.tgz')) {
          return new Response(tinyTarball, { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const result = await pm.installFromPackageJson();

      expect(vfs.existsSync('/node_modules/local-lib/package.json')).toBe(true);
      expect(vfs.existsSync('/node_modules/tiny-pkg/package.json')).toBe(true);
      expect(result.installed.get('tiny-pkg')?.version).toBe('1.1.0');
    });

    it('should install npm alias dependencies', async () => {
      vfs.writeFileSync(
        '/package.json',
        JSON.stringify({
          name: 'root',
          dependencies: {
            'alias-pkg': 'npm:real-pkg@1.0.0',
          },
        })
      );

      const realManifest = {
        name: 'real-pkg',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            name: 'real-pkg',
            version: '1.0.0',
            dist: {
              tarball: 'https://registry.npmjs.org/real-pkg/-/real-pkg-1.0.0.tgz',
              shasum: 'real',
            },
            dependencies: {
              dep: '^1.0.0',
            },
          },
        },
      };

      const depManifest = {
        name: 'dep',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            name: 'dep',
            version: '1.0.0',
            dist: {
              tarball: 'https://registry.npmjs.org/dep/-/dep-1.0.0.tgz',
              shasum: 'dep',
            },
            dependencies: {},
          },
        },
      };

      const realTarball = pako.gzip(
        createMinimalTarball({
          'package/package.json': '{"name":"real-pkg","version":"1.0.0"}',
          'package/index.js': 'module.exports = "real";',
        })
      );

      const depTarball = pako.gzip(
        createMinimalTarball({
          'package/package.json': '{"name":"dep","version":"1.0.0"}',
          'package/index.js': 'module.exports = "dep";',
        })
      );

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const urlStr = url.toString();
        if (urlStr.includes('/real-pkg') && !urlStr.includes('.tgz')) {
          return new Response(JSON.stringify(realManifest), { status: 200 });
        }
        if (urlStr.includes('/dep') && !urlStr.includes('.tgz')) {
          return new Response(JSON.stringify(depManifest), { status: 200 });
        }
        if (urlStr.endsWith('/real-pkg-1.0.0.tgz')) {
          return new Response(realTarball, { status: 200 });
        }
        if (urlStr.endsWith('/dep-1.0.0.tgz')) {
          return new Response(depTarball, { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const result = await pm.installFromPackageJson();

      expect(vfs.existsSync('/node_modules/real-pkg/package.json')).toBe(true);
      expect(vfs.existsSync('/node_modules/dep/package.json')).toBe(true);
      expect(vfs.existsSync('/node_modules/alias-pkg/package.json')).toBe(true);
      expect(result.installed.get('alias-pkg')?.version).toBe('1.0.0');
      expect(result.added).toContain('alias-pkg');
    });

    it('should resolve transitive npm alias dependencies from registry package manifests', async () => {
      vfs.writeFileSync(
        '/package.json',
        JSON.stringify({
          name: 'root',
          dependencies: {
            host: '^1.0.0',
          },
        })
      );

      const hostManifest = {
        name: 'host',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            name: 'host',
            version: '1.0.0',
            dist: {
              tarball: 'https://registry.npmjs.org/host/-/host-1.0.0.tgz',
              shasum: 'host',
            },
            dependencies: {
              'h3-v2': 'npm:h3@2.0.1-rc.14',
            },
          },
        },
      };

      const h3Manifest = {
        name: 'h3',
        'dist-tags': { latest: '2.0.1-rc.14' },
        versions: {
          '2.0.1-rc.14': {
            name: 'h3',
            version: '2.0.1-rc.14',
            dist: {
              tarball: 'https://registry.npmjs.org/h3/-/h3-2.0.1-rc.14.tgz',
              shasum: 'h3',
            },
            dependencies: {},
          },
        },
      };

      const hostTarball = pako.gzip(
        createMinimalTarball({
          'package/package.json': '{"name":"host","version":"1.0.0"}',
          'package/index.js': 'module.exports = require("h3-v2");',
        })
      );

      const h3Tarball = pako.gzip(
        createMinimalTarball({
          'package/package.json': '{"name":"h3","version":"2.0.1-rc.14"}',
          'package/index.js': 'module.exports = "h3";',
        })
      );

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const urlStr = url.toString();
        if (urlStr.includes('/host') && !urlStr.includes('.tgz')) {
          return new Response(JSON.stringify(hostManifest), { status: 200 });
        }
        if (urlStr.includes('/h3') && !urlStr.includes('.tgz')) {
          return new Response(JSON.stringify(h3Manifest), { status: 200 });
        }
        if (urlStr.endsWith('/host-1.0.0.tgz')) {
          return new Response(hostTarball, { status: 200 });
        }
        if (urlStr.endsWith('/h3-2.0.1-rc.14.tgz')) {
          return new Response(h3Tarball, { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const result = await pm.installFromPackageJson();

      expect(vfs.existsSync('/node_modules/host/package.json')).toBe(true);
      expect(vfs.existsSync('/node_modules/h3/package.json')).toBe(true);
      expect(vfs.existsSync('/node_modules/h3-v2/package.json')).toBe(true);
      expect(result.installed.get('h3-v2')?.version).toBe('2.0.1-rc.14');
    });

    it('should install github dependencies via codeload archives', async () => {
      vfs.writeFileSync(
        '/package.json',
        JSON.stringify({
          name: 'root',
          dependencies: {
            'gh-lib': 'github:acme/gh-lib#main',
          },
        })
      );

      const ghTarball = pako.gzip(
        createMinimalTarball({
          'package/package.json': '{"name":"gh-lib","version":"0.1.0"}',
          'package/index.js': 'module.exports = "gh";',
        })
      );

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const urlStr = url.toString();
        if (urlStr === 'https://codeload.github.com/acme/gh-lib/tar.gz/main') {
          return new Response(ghTarball, { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      await pm.installFromPackageJson();

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://codeload.github.com/acme/gh-lib/tar.gz/main',
        undefined
      );
      expect(vfs.existsSync('/node_modules/gh-lib/package.json')).toBe(true);
    });

    it('should fail with a clear error for unsupported git protocols', async () => {
      vfs.writeFileSync(
        '/package.json',
        JSON.stringify({
          name: 'root',
          dependencies: {
            legacy: 'git+ssh://github.com/acme/legacy.git',
          },
        })
      );

      await expect(pm.installFromPackageJson()).rejects.toThrow(
        'Unsupported dependency protocol for "legacy"'
      );
    });

    it('should install nested trees from package-lock v1 dependencies', async () => {
      vfs.writeFileSync(
        '/package.json',
        JSON.stringify({
          name: 'root',
          dependencies: {
            app: '^1.0.0',
          },
        })
      );
      vfs.writeFileSync(
        '/package-lock.json',
        JSON.stringify({
          name: 'root',
          lockfileVersion: 1,
          dependencies: {
            app: {
              version: '1.0.0',
              resolved: 'https://registry.npmjs.org/app/-/app-1.0.0.tgz',
              dependencies: {
                shared: {
                  version: '2.0.0',
                  resolved: 'https://registry.npmjs.org/shared/-/shared-2.0.0.tgz',
                },
              },
            },
            shared: {
              version: '1.0.0',
              resolved: 'https://registry.npmjs.org/shared/-/shared-1.0.0.tgz',
            },
          },
        })
      );

      const appTarball = pako.gzip(
        createMinimalTarball({
          'package/package.json': '{"name":"app","version":"1.0.0"}',
        })
      );
      const shared1Tarball = pako.gzip(
        createMinimalTarball({
          'package/package.json': '{"name":"shared","version":"1.0.0"}',
        })
      );
      const shared2Tarball = pako.gzip(
        createMinimalTarball({
          'package/package.json': '{"name":"shared","version":"2.0.0"}',
        })
      );

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const urlStr = url.toString();
        if (urlStr.endsWith('/app-1.0.0.tgz')) {
          return new Response(appTarball, { status: 200 });
        }
        if (urlStr.endsWith('/shared-1.0.0.tgz')) {
          return new Response(shared1Tarball, { status: 200 });
        }
        if (urlStr.endsWith('/shared-2.0.0.tgz')) {
          return new Response(shared2Tarball, { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      await pm.installFromPackageJson();

      expect(vfs.existsSync('/node_modules/app/package.json')).toBe(true);
      expect(vfs.existsSync('/node_modules/shared/package.json')).toBe(true);
      expect(vfs.existsSync('/node_modules/app/node_modules/shared/package.json')).toBe(true);
      const rootShared = JSON.parse(vfs.readFileSync('/node_modules/shared/package.json', 'utf8'));
      const nestedShared = JSON.parse(
        vfs.readFileSync('/node_modules/app/node_modules/shared/package.json', 'utf8')
      );
      expect(rootShared.version).toBe('1.0.0');
      expect(nestedShared.version).toBe('2.0.0');
    });

    it('should fallback to package.json resolution when lockfile has no package entries', async () => {
      vfs.writeFileSync(
        '/package.json',
        JSON.stringify({
          name: 'root',
          dependencies: {
            tiny: '^1.0.0',
          },
        })
      );
      vfs.writeFileSync(
        '/package-lock.json',
        JSON.stringify({
          name: 'root',
          lockfileVersion: 3,
          packages: {
            '': {
              name: 'root',
              dependencies: {
                tiny: '^1.0.0',
              },
            },
          },
        })
      );

      const tinyManifest = {
        name: 'tiny',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            name: 'tiny',
            version: '1.0.0',
            dist: {
              tarball: 'https://registry.npmjs.org/tiny/-/tiny-1.0.0.tgz',
              shasum: 'tiny',
            },
            dependencies: {},
          },
        },
      };
      const tinyTarball = pako.gzip(
        createMinimalTarball({
          'package/package.json': '{"name":"tiny","version":"1.0.0"}',
        })
      );

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const urlStr = url.toString();
        if (urlStr.includes('/tiny') && !urlStr.includes('.tgz')) {
          return new Response(JSON.stringify(tinyManifest), { status: 200 });
        }
        if (urlStr.endsWith('/tiny-1.0.0.tgz')) {
          return new Response(tinyTarball, { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const result = await pm.installFromPackageJson();

      expect(result.installed.get('tiny')?.version).toBe('1.0.0');
      expect(vfs.existsSync('/node_modules/tiny/package.json')).toBe(true);
    });

    it('should prefer package-lock resolved tarballs when lockfile exists', async () => {
      vfs.writeFileSync(
        '/package.json',
        JSON.stringify({
          name: 'root',
          dependencies: {
            'lock-pkg': '^1.0.0',
          },
        })
      );
      vfs.writeFileSync(
        '/package-lock.json',
        JSON.stringify({
          name: 'root',
          lockfileVersion: 3,
          packages: {
            '': {
              name: 'root',
              dependencies: {
                'lock-pkg': '^1.0.0',
              },
            },
            'node_modules/lock-pkg': {
              name: 'lock-pkg',
              version: '1.0.0',
              resolved: 'https://registry.npmjs.org/lock-pkg/-/lock-pkg-1.0.0.tgz',
            },
          },
        })
      );

      const tarball = pako.gzip(
        createMinimalTarball({
          'package/package.json': '{"name":"lock-pkg","version":"1.0.0"}',
          'package/index.js': 'module.exports = "lock";',
        })
      );

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const urlStr = url.toString();
        if (urlStr === 'https://registry.npmjs.org/lock-pkg/-/lock-pkg-1.0.0.tgz') {
          return new Response(tarball, { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const result = await pm.installFromPackageJson();

      expect(result.installed.get('lock-pkg')?.version).toBe('1.0.0');
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://registry.npmjs.org/lock-pkg/-/lock-pkg-1.0.0.tgz',
        undefined
      );
      expect(vfs.existsSync('/node_modules/lock-pkg/package.json')).toBe(true);
    });

    it('should install nested multi-version trees from package-lock paths', async () => {
      vfs.writeFileSync(
        '/package.json',
        JSON.stringify({
          name: 'root',
          dependencies: {
            app: '^1.0.0',
          },
        })
      );
      vfs.writeFileSync(
        '/package-lock.json',
        JSON.stringify({
          name: 'root',
          lockfileVersion: 3,
          packages: {
            '': {
              name: 'root',
              dependencies: {
                app: '^1.0.0',
              },
            },
            'node_modules/app': {
              name: 'app',
              version: '1.0.0',
              resolved: 'https://registry.npmjs.org/app/-/app-1.0.0.tgz',
            },
            'node_modules/shared': {
              name: 'shared',
              version: '1.0.0',
              resolved: 'https://registry.npmjs.org/shared/-/shared-1.0.0.tgz',
            },
            'node_modules/app/node_modules/shared': {
              name: 'shared',
              version: '2.0.0',
              resolved: 'https://registry.npmjs.org/shared/-/shared-2.0.0.tgz',
            },
          },
        })
      );

      const appTarball = pako.gzip(
        createMinimalTarball({
          'package/package.json': '{"name":"app","version":"1.0.0"}',
          'package/index.js': 'module.exports = "app";',
        })
      );
      const shared1Tarball = pako.gzip(
        createMinimalTarball({
          'package/package.json': '{"name":"shared","version":"1.0.0"}',
        })
      );
      const shared2Tarball = pako.gzip(
        createMinimalTarball({
          'package/package.json': '{"name":"shared","version":"2.0.0"}',
        })
      );

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const urlStr = url.toString();
        if (urlStr.endsWith('/app-1.0.0.tgz')) {
          return new Response(appTarball, { status: 200 });
        }
        if (urlStr.endsWith('/shared-1.0.0.tgz')) {
          return new Response(shared1Tarball, { status: 200 });
        }
        if (urlStr.endsWith('/shared-2.0.0.tgz')) {
          return new Response(shared2Tarball, { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      await pm.installFromPackageJson();

      expect(vfs.existsSync('/node_modules/shared/package.json')).toBe(true);
      expect(vfs.existsSync('/node_modules/app/node_modules/shared/package.json')).toBe(true);
      const sharedRoot = JSON.parse(vfs.readFileSync('/node_modules/shared/package.json', 'utf8'));
      const sharedNested = JSON.parse(
        vfs.readFileSync('/node_modules/app/node_modules/shared/package.json', 'utf8')
      );
      expect(sharedRoot.version).toBe('1.0.0');
      expect(sharedNested.version).toBe('2.0.0');
    });

    it('should install lockfile workspace link entries from local paths', async () => {
      vfs.writeFileSync('/package.json', JSON.stringify({ name: 'root', private: true }));
      vfs.writeFileSync(
        '/packages/local-lib/package.json',
        JSON.stringify({ name: 'local-lib', version: '1.0.0' })
      );
      vfs.writeFileSync('/packages/local-lib/index.js', 'module.exports = "local";');
      vfs.writeFileSync(
        '/package-lock.json',
        JSON.stringify({
          name: 'root',
          lockfileVersion: 3,
          packages: {
            '': { name: 'root' },
            'packages/local-lib': { name: 'local-lib', version: '1.0.0' },
            'node_modules/local-lib': {
              resolved: 'packages/local-lib',
              link: true,
            },
          },
        })
      );

      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const result = await pm.installFromPackageJson();

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(vfs.existsSync('/node_modules/local-lib/package.json')).toBe(true);
      expect(result.added).toContain('local-lib');
    });

    it('should install lockfile file: tarball entries from local paths', async () => {
      vfs.writeFileSync('/package.json', JSON.stringify({ name: 'root', private: true }));
      const localTarball = pako.gzip(
        createMinimalTarball({
          'package/package.json': '{"name":"local-file-pkg","version":"1.0.0"}',
          'package/index.js': 'module.exports = "local-file";',
        })
      );
      vfs.writeFileSync('/vendor/local-file-pkg-1.0.0.tgz', localTarball);
      vfs.writeFileSync(
        '/package-lock.json',
        JSON.stringify({
          name: 'root',
          lockfileVersion: 3,
          packages: {
            '': { name: 'root' },
            'node_modules/local-file-pkg': {
              name: 'local-file-pkg',
              version: '1.0.0',
              resolved: 'file:vendor/local-file-pkg-1.0.0.tgz',
            },
          },
        })
      );

      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const result = await pm.installFromPackageJson();

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(vfs.existsSync('/node_modules/local-file-pkg/package.json')).toBe(true);
      expect(result.added).toContain('local-file-pkg');
    });

    it('should install lockfile file: directory entries from local paths', async () => {
      vfs.writeFileSync('/package.json', JSON.stringify({ name: 'root', private: true }));
      vfs.writeFileSync(
        '/vendor/local-dir-pkg/package.json',
        JSON.stringify({ name: 'local-dir-pkg', version: '2.0.0' })
      );
      vfs.writeFileSync('/vendor/local-dir-pkg/index.js', 'module.exports = "local-dir";');
      vfs.writeFileSync(
        '/package-lock.json',
        JSON.stringify({
          name: 'root',
          lockfileVersion: 3,
          packages: {
            '': { name: 'root' },
            'node_modules/local-dir-pkg': {
              name: 'local-dir-pkg',
              version: '2.0.0',
              resolved: 'file:vendor/local-dir-pkg',
            },
          },
        })
      );

      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const result = await pm.installFromPackageJson();

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(vfs.existsSync('/node_modules/local-dir-pkg/package.json')).toBe(true);
      expect(result.added).toContain('local-dir-pkg');
    });

    it('should install dependencies from bun.lock when npm lockfile is absent', async () => {
      vfs.writeFileSync(
        '/package.json',
        JSON.stringify({
          name: 'root',
          dependencies: {
            tiny: '^1.0.0',
          },
        })
      );
      vfs.writeFileSync(
        '/bun.lock',
        `{
          "lockfileVersion": 1,
          "workspaces": {
            "": {
              "name": "root",
              "dependencies": {
                "tiny": "^1.0.0",
              },
            },
          },
          "packages": {
            "tiny": ["tiny@1.0.0", "", {}, "sha512-tiny"],
          },
        }`
      );

      const tinyManifest = {
        name: 'tiny',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            name: 'tiny',
            version: '1.0.0',
            dist: {
              tarball: 'https://registry.npmjs.org/tiny/-/tiny-1.0.0.tgz',
              shasum: 'tiny',
            },
            dependencies: {},
          },
        },
      };
      const tinyTarball = pako.gzip(
        createMinimalTarball({
          'package/package.json': '{"name":"tiny","version":"1.0.0"}',
          'package/index.js': 'module.exports = "tiny";',
        })
      );

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const urlStr = url.toString();
        if (urlStr.includes('/tiny') && !urlStr.includes('.tgz')) {
          return new Response(JSON.stringify(tinyManifest), { status: 200 });
        }
        if (urlStr.endsWith('/tiny-1.0.0.tgz')) {
          return new Response(tinyTarball, { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const result = await pm.installFromPackageJson();

      expect(result.installed.get('tiny')?.version).toBe('1.0.0');
      expect(vfs.existsSync('/node_modules/tiny/package.json')).toBe(true);
    });

    it('should install nested dependency paths encoded in bun.lock package keys', async () => {
      vfs.writeFileSync(
        '/package.json',
        JSON.stringify({
          name: 'root',
          dependencies: {
            parent: '^1.0.0',
          },
        })
      );
      vfs.writeFileSync(
        '/bun.lock',
        `{
          "lockfileVersion": 1,
          "workspaces": {
            "": {
              "name": "root",
              "dependencies": {
                "parent": "^1.0.0",
              },
            },
          },
          "packages": {
            "parent": ["parent@1.0.0", "", { "dependencies": { "child": "1.0.0" } }, "sha512-parent"],
            "parent/child": ["child@1.0.0", "", {}, "sha512-child"],
          },
        }`
      );

      const parentManifest = {
        name: 'parent',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            name: 'parent',
            version: '1.0.0',
            dist: {
              tarball: 'https://registry.npmjs.org/parent/-/parent-1.0.0.tgz',
              shasum: 'parent',
            },
            dependencies: {
              child: '1.0.0',
            },
          },
        },
      };
      const childManifest = {
        name: 'child',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            name: 'child',
            version: '1.0.0',
            dist: {
              tarball: 'https://registry.npmjs.org/child/-/child-1.0.0.tgz',
              shasum: 'child',
            },
            dependencies: {},
          },
        },
      };
      const parentTarball = pako.gzip(
        createMinimalTarball({
          'package/package.json': '{"name":"parent","version":"1.0.0"}',
          'package/index.js': 'module.exports = require("child");',
        })
      );
      const childTarball = pako.gzip(
        createMinimalTarball({
          'package/package.json': '{"name":"child","version":"1.0.0"}',
          'package/index.js': 'module.exports = "child";',
        })
      );

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const urlStr = url.toString();
        if (urlStr.includes('/parent') && !urlStr.includes('.tgz')) {
          return new Response(JSON.stringify(parentManifest), { status: 200 });
        }
        if (urlStr.includes('/child') && !urlStr.includes('.tgz')) {
          return new Response(JSON.stringify(childManifest), { status: 200 });
        }
        if (urlStr.endsWith('/parent-1.0.0.tgz')) {
          return new Response(parentTarball, { status: 200 });
        }
        if (urlStr.endsWith('/child-1.0.0.tgz')) {
          return new Response(childTarball, { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      await pm.installFromPackageJson();

      expect(vfs.existsSync('/node_modules/parent/package.json')).toBe(true);
      expect(vfs.existsSync('/node_modules/parent/node_modules/child/package.json')).toBe(true);
    });

    it('should install required peers from bun.lock and skip optional peers', async () => {
      vfs.writeFileSync(
        '/package.json',
        JSON.stringify({
          name: 'root',
          dependencies: {
            plugin: '^1.0.0',
          },
        })
      );
      vfs.writeFileSync(
        '/bun.lock',
        `{
          "lockfileVersion": 1,
          "workspaces": {
            "": {
              "name": "root",
              "dependencies": {
                "plugin": "^1.0.0",
              },
            },
          },
          "packages": {
            "plugin": ["plugin@1.0.0", "", { "peerDependencies": { "peer-required": "^1.0.0", "peer-optional": "^1.0.0" }, "optionalPeers": ["peer-optional"] }, "sha512-plugin"],
            "peer-required": ["peer-required@1.0.0", "", {}, "sha512-peer-required"],
            "peer-optional": ["peer-optional@1.0.0", "", {}, "sha512-peer-optional"],
          },
        }`
      );

      const pluginManifest = {
        name: 'plugin',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            name: 'plugin',
            version: '1.0.0',
            dist: {
              tarball: 'https://registry.npmjs.org/plugin/-/plugin-1.0.0.tgz',
              shasum: 'plugin',
            },
            dependencies: {},
          },
        },
      };
      const requiredPeerManifest = {
        name: 'peer-required',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            name: 'peer-required',
            version: '1.0.0',
            dist: {
              tarball: 'https://registry.npmjs.org/peer-required/-/peer-required-1.0.0.tgz',
              shasum: 'peer-required',
            },
            dependencies: {},
          },
        },
      };
      const pluginTarball = pako.gzip(
        createMinimalTarball({
          'package/package.json': '{"name":"plugin","version":"1.0.0"}',
        })
      );
      const requiredPeerTarball = pako.gzip(
        createMinimalTarball({
          'package/package.json': '{"name":"peer-required","version":"1.0.0"}',
        })
      );

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const urlStr = url.toString();
        if (urlStr.includes('/plugin') && !urlStr.includes('.tgz')) {
          return new Response(JSON.stringify(pluginManifest), { status: 200 });
        }
        if (urlStr.includes('/peer-required') && !urlStr.includes('.tgz')) {
          return new Response(JSON.stringify(requiredPeerManifest), { status: 200 });
        }
        if (urlStr.endsWith('/plugin-1.0.0.tgz')) {
          return new Response(pluginTarball, { status: 200 });
        }
        if (urlStr.endsWith('/peer-required-1.0.0.tgz')) {
          return new Response(requiredPeerTarball, { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      await pm.installFromPackageJson();

      expect(vfs.existsSync('/node_modules/plugin/package.json')).toBe(true);
      expect(vfs.existsSync('/node_modules/peer-required/package.json')).toBe(true);
      expect(vfs.existsSync('/node_modules/peer-optional/package.json')).toBe(false);
      const calledOptionalPeer = fetchSpy.mock.calls.some((call) =>
        call[0].toString().includes('peer-optional')
      );
      expect(calledOptionalPeer).toBe(false);
    });

    it('should fallback to package.json resolution when bun.lock is invalid', async () => {
      vfs.writeFileSync(
        '/package.json',
        JSON.stringify({
          name: 'root',
          dependencies: {
            tiny: '^1.0.0',
          },
        })
      );
      vfs.writeFileSync(
        '/bun.lock',
        `<<<<<<< HEAD
this is not valid json
>>>>>>> branch`
      );

      const tinyManifest = {
        name: 'tiny',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            name: 'tiny',
            version: '1.0.0',
            dist: {
              tarball: 'https://registry.npmjs.org/tiny/-/tiny-1.0.0.tgz',
              shasum: 'tiny',
            },
            dependencies: {},
          },
        },
      };
      const tinyTarball = pako.gzip(
        createMinimalTarball({
          'package/package.json': '{"name":"tiny","version":"1.0.0"}',
        })
      );

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const urlStr = url.toString();
        if (urlStr.includes('/tiny') && !urlStr.includes('.tgz')) {
          return new Response(JSON.stringify(tinyManifest), { status: 200 });
        }
        if (urlStr.endsWith('/tiny-1.0.0.tgz')) {
          return new Response(tinyTarball, { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const result = await pm.installFromPackageJson();

      expect(result.installed.get('tiny')?.version).toBe('1.0.0');
      expect(vfs.existsSync('/node_modules/tiny/package.json')).toBe(true);
    });

    it('should ignore invalid package-lock.json and use bun.lock when available', async () => {
      vfs.writeFileSync(
        '/package.json',
        JSON.stringify({
          name: 'root',
          dependencies: {
            tiny: '^1.0.0',
          },
        })
      );
      vfs.writeFileSync('/package-lock.json', '{ invalid json');
      vfs.writeFileSync(
        '/bun.lock',
        `{
          "lockfileVersion": 1,
          "workspaces": {
            "": {
              "name": "root",
              "dependencies": {
                "tiny": "^1.0.0",
              },
            },
          },
          "packages": {
            "tiny": ["tiny@1.0.0", "", {}, "sha512-tiny"],
          },
        }`
      );

      const tinyManifest = {
        name: 'tiny',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            name: 'tiny',
            version: '1.0.0',
            dist: {
              tarball: 'https://registry.npmjs.org/tiny/-/tiny-1.0.0.tgz',
              shasum: 'tiny',
            },
            dependencies: {},
          },
        },
      };
      const tinyTarball = pako.gzip(
        createMinimalTarball({
          'package/package.json': '{"name":"tiny","version":"1.0.0"}',
        })
      );

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const urlStr = url.toString();
        if (urlStr.includes('/tiny') && !urlStr.includes('.tgz')) {
          return new Response(JSON.stringify(tinyManifest), { status: 200 });
        }
        if (urlStr.endsWith('/tiny-1.0.0.tgz')) {
          return new Response(tinyTarball, { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const result = await pm.installFromPackageJson();
      expect(result.installed.get('tiny')?.version).toBe('1.0.0');
      expect(vfs.existsSync('/node_modules/tiny/package.json')).toBe(true);
    });

    it('should skip bun.lock devDependencies by default', async () => {
      vfs.writeFileSync(
        '/package.json',
        JSON.stringify({
          name: 'root',
          dependencies: {
            app: '^1.0.0',
          },
        })
      );
      vfs.writeFileSync(
        '/bun.lock',
        `{
          "lockfileVersion": 1,
          "workspaces": {
            "": {
              "name": "root",
              "dependencies": {
                "app": "^1.0.0",
              },
              "devDependencies": {
                "dev-only": "^1.0.0",
              },
            },
          },
          "packages": {
            "app": ["app@1.0.0", "", {}, "sha512-app"],
            "dev-only": ["dev-only@1.0.0", "", {}, "sha512-dev"],
          },
        }`
      );

      const appManifest = {
        name: 'app',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            name: 'app',
            version: '1.0.0',
            dist: {
              tarball: 'https://registry.npmjs.org/app/-/app-1.0.0.tgz',
              shasum: 'app',
            },
            dependencies: {},
          },
        },
      };
      const appTarball = pako.gzip(
        createMinimalTarball({
          'package/package.json': '{"name":"app","version":"1.0.0"}',
        })
      );

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const urlStr = url.toString();
        if (urlStr.includes('/app') && !urlStr.includes('.tgz')) {
          return new Response(JSON.stringify(appManifest), { status: 200 });
        }
        if (urlStr.endsWith('/app-1.0.0.tgz')) {
          return new Response(appTarball, { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      await pm.installFromPackageJson();

      expect(vfs.existsSync('/node_modules/app/package.json')).toBe(true);
      expect(vfs.existsSync('/node_modules/dev-only/package.json')).toBe(false);
      const calledDevOnly = fetchSpy.mock.calls.some((call) => call[0].toString().includes('dev-only'));
      expect(calledDevOnly).toBe(false);
    });
  });
});

/**
 * Create a minimal tar archive for testing
 */
type TarFixtureEntry =
  | string
  | {
    type: 'symlink';
    target: string;
  };

function createMinimalTarball(files: Record<string, TarFixtureEntry>): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];

  for (const [filename, entry] of Object.entries(files)) {
    const isSymlink = typeof entry === 'object' && entry?.type === 'symlink';
    const linkTarget = isSymlink ? entry.target : '';
    const contentBytes = isSymlink
      ? new Uint8Array(0)
      : encoder.encode(typeof entry === 'string' ? entry : '');

    // Create 512-byte header
    const header = new Uint8Array(512);

    // Filename (0-100)
    const nameBytes = encoder.encode(filename);
    header.set(nameBytes.slice(0, 100), 0);

    // File mode (100-108) - octal "0000644\0"
    header.set(encoder.encode('0000644\0'), 100);

    // UID (108-116) - octal "0000000\0"
    header.set(encoder.encode('0000000\0'), 108);

    // GID (116-124) - octal "0000000\0"
    header.set(encoder.encode('0000000\0'), 116);

    // Size (124-136) - octal, 11 digits + space
    const sizeOctal = contentBytes.length.toString(8).padStart(11, '0') + ' ';
    header.set(encoder.encode(sizeOctal), 124);

    // Mtime (136-148) - octal "00000000000\0"
    header.set(encoder.encode('00000000000\0'), 136);

    // Initially set checksum field to spaces for calculation
    header.set(encoder.encode('        '), 148);

    // Type flag (156)
    header[156] = isSymlink ? 50 : 48; // '2' for symlink, '0' for regular file

    // Link name (157-257) for symlinks
    if (isSymlink) {
      header.set(encoder.encode(linkTarget).slice(0, 100), 157);
    }

    // Calculate checksum (sum of all bytes in header)
    let checksum = 0;
    for (let i = 0; i < 512; i++) {
      checksum += header[i];
    }
    // Write checksum as 6 octal digits + null + space
    const checksumStr = checksum.toString(8).padStart(6, '0') + '\0 ';
    header.set(encoder.encode(checksumStr), 148);

    chunks.push(header);

    // Add content padded to 512-byte boundary
    const paddedSize = Math.ceil(contentBytes.length / 512) * 512;
    const paddedContent = new Uint8Array(paddedSize);
    paddedContent.set(contentBytes);
    chunks.push(paddedContent);
  }

  // Add two 512-byte blocks of zeros to mark end of archive
  chunks.push(new Uint8Array(1024));

  // Concatenate all chunks
  const totalSize = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}
