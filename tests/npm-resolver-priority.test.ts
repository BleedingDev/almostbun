import { describe, expect, it } from 'vitest';
import { resolveFromPackageJson } from '../src/npm/resolver';
import type { Registry } from '../src/npm/registry';

type MockVersion = {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

function createManifest(
  versions: Record<string, MockVersion>,
  latest: string
): {
  versions: Record<string, {
    dist: { tarball: string };
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  }>;
  'dist-tags': { latest: string };
} {
  const mapped: Record<string, {
    dist: { tarball: string };
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  }> = {};

  for (const [version, meta] of Object.entries(versions)) {
    mapped[version] = {
      dist: {
        tarball: `https://registry.npmjs.org/mock/-/mock-${version}.tgz`,
      },
      dependencies: meta.dependencies,
      optionalDependencies: meta.optionalDependencies,
      peerDependencies: meta.peerDependencies,
      peerDependenciesMeta: meta.peerDependenciesMeta,
    };
  }

  return {
    versions: mapped,
    'dist-tags': {
      latest,
    },
  };
}

describe('npm resolver root dependency priority', () => {
  it('lets direct dependencies override conflicting transitive picks', async () => {
    const manifests = new Map<string, ReturnType<typeof createManifest>>([
      ['plugin-a', createManifest({
        '1.0.0': {
          dependencies: {
            'react-dom': '>=17.0.0',
          },
        },
      }, '1.0.0')],
      ['react-dom', createManifest({
        '18.2.0': {},
        '19.2.4': {},
      }, '19.2.4')],
    ]);

    const registry = {
      async getPackageManifest(name: string) {
        const manifest = manifests.get(name);
        if (!manifest) {
          throw new Error(`Unknown package in mock registry: ${name}`);
        }
        return manifest;
      },
    } as unknown as Registry;

    const resolved = await resolveFromPackageJson(
      {
        dependencies: {
          'plugin-a': '1.0.0',
          'react-dom': '~18.2.0',
        },
      },
      {
        registry,
      }
    );

    expect(resolved.get('plugin-a')?.version).toBe('1.0.0');
    expect(resolved.get('react-dom')?.version).toBe('18.2.0');
  });
});
