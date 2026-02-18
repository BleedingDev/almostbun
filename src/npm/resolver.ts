/**
 * Dependency Resolver
 * Resolves full dependency tree with semver version constraints
 */

import { Registry, PackageVersion } from './registry';

export interface ResolvedPackage {
  name: string;
  version: string;
  tarballUrl: string;
  dependencies: Record<string, string>;
}

export interface ResolveOptions {
  registry?: Registry;
  includeDev?: boolean;
  includeOptional?: boolean;
  onProgress?: (message: string) => void;
}

interface ResolveContext {
  registry: Registry;
  resolved: Map<string, ResolvedPackage>;
  resolving: Set<string>;
  options: ResolveOptions;
}

function parseNpmAliasSpec(versionRange: string): {
  targetName: string;
  targetRange: string;
} | null {
  const trimmed = versionRange.trim();
  if (!trimmed.startsWith('npm:')) {
    return null;
  }

  const target = trimmed.slice('npm:'.length).trim();
  if (!target) {
    return null;
  }

  // Scoped package aliases: npm:@scope/pkg@1.2.3
  if (target.startsWith('@')) {
    const slashIndex = target.indexOf('/');
    if (slashIndex === -1) {
      return null;
    }
    const versionIndex = target.indexOf('@', slashIndex + 1);
    if (versionIndex === -1) {
      return { targetName: target, targetRange: 'latest' };
    }
    return {
      targetName: target.slice(0, versionIndex),
      targetRange: target.slice(versionIndex + 1) || 'latest',
    };
  }

  // Unscoped package aliases: npm:pkg@1.2.3
  const versionIndex = target.indexOf('@');
  if (versionIndex === -1) {
    return { targetName: target, targetRange: 'latest' };
  }
  return {
    targetName: target.slice(0, versionIndex),
    targetRange: target.slice(versionIndex + 1) || 'latest',
  };
}

/**
 * Parse a semver version string into components
 */
function parseVersion(version: string): {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
} | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!match) return null;

  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4],
  };
}

function parseVersionLoose(version: string): {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
  parts: 1 | 2 | 3;
} | null {
  const match = version.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-(.+))?$/);
  if (!match) return null;

  const parts = (match[3] ? 3 : match[2] ? 2 : 1) as 1 | 2 | 3;
  return {
    major: parseInt(match[1], 10),
    minor: match[2] ? parseInt(match[2], 10) : 0,
    patch: match[3] ? parseInt(match[3], 10) : 0,
    prerelease: match[4],
    parts,
  };
}

function normalizeVersionInput(version: string): string | null {
  const parsed = parseVersionLoose(version.trim());
  if (!parsed) return null;
  return `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.prerelease ? `-${parsed.prerelease}` : ''}`;
}

/**
 * Compare two semver versions
 * Returns: -1 if a < b, 0 if a == b, 1 if a > b
 */
function compareVersions(a: string, b: string): number {
  const parsedA = parseVersion(a);
  const parsedB = parseVersion(b);

  if (!parsedA || !parsedB) {
    return a.localeCompare(b);
  }

  if (parsedA.major !== parsedB.major) {
    return parsedA.major - parsedB.major;
  }
  if (parsedA.minor !== parsedB.minor) {
    return parsedA.minor - parsedB.minor;
  }
  if (parsedA.patch !== parsedB.patch) {
    return parsedA.patch - parsedB.patch;
  }

  // Prerelease versions are lower than release versions
  if (parsedA.prerelease && !parsedB.prerelease) return -1;
  if (!parsedA.prerelease && parsedB.prerelease) return 1;
  if (parsedA.prerelease && parsedB.prerelease) {
    return parsedA.prerelease.localeCompare(parsedB.prerelease);
  }

  return 0;
}

/**
 * Check if a version satisfies a semver range
 */
function satisfies(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;

  // Skip prerelease versions unless explicitly requested
  if (parsed.prerelease && !range.includes('-')) {
    return false;
  }

  range = range.trim();

  // Exact version
  if (/^\d+\.\d+\.\d+/.test(range) && !range.includes(' ')) {
    const rangeMatch = range.match(/^(\d+\.\d+\.\d+(?:-[^\s]+)?)/);
    if (rangeMatch) {
      return compareVersions(version, rangeMatch[1]) === 0;
    }
  }

  // Latest or * - any version
  if (range === '*' || range === 'latest' || range === '') {
    return true;
  }

  // Multiple ranges with ||
  if (range.includes('||')) {
    return range.split('||').some((r) => satisfies(version, r.trim()));
  }

  // Range with hyphen: 1.0.0 - 2.0.0
  if (range.includes(' - ')) {
    const [min, max] = range.split(' - ').map((s) => s.trim());
    const minNormalized = normalizeVersionInput(min) ?? min;
    const maxNormalized = normalizeVersionInput(max) ?? max;
    return compareVersions(version, minNormalized) >= 0 && compareVersions(version, maxNormalized) <= 0;
  }

  // Compound ranges with operators: >= 2.1.2 < 3.0.0
  // Parse all operators and versions from the range
  const operatorMatches = range.match(/(>=|<=|>|<|=)?\s*(\d+(?:\.\d+){0,2}(?:-[^\s]*)?)/g);
  if (operatorMatches && operatorMatches.length > 1) {
    return operatorMatches.every((match) => {
      const m = match.match(/^(>=|<=|>|<|=)?\s*(\d+(?:\.\d+){0,2}(?:-[^\s]*)?)$/);
      if (!m) return true;
      const op = m[1] || '=';
      const ver = normalizeVersionInput(m[2]) ?? m[2];
      switch (op) {
        case '>=': return compareVersions(version, ver) >= 0;
        case '<=': return compareVersions(version, ver) <= 0;
        case '>': return compareVersions(version, ver) > 0;
        case '<': return compareVersions(version, ver) < 0;
        case '=': return compareVersions(version, ver) === 0;
        default: return compareVersions(version, ver) === 0;
      }
    });
  }

  // Caret range: ^1.2.3 means >=1.2.3 <2.0.0 (or <1.3.0 if major is 0)
  if (range.startsWith('^')) {
    const baseRaw = range.slice(1).trim();
    const baseParsed = parseVersionLoose(baseRaw);
    if (!baseParsed) return false;
    const base = normalizeVersionInput(baseRaw);
    if (!base) return false;

    if (parsed.major !== baseParsed.major) {
      return false;
    }

    if (baseParsed.major === 0) {
      // ^0.x.y is more restrictive
      if (baseParsed.parts >= 2 && parsed.minor !== baseParsed.minor) {
        return false;
      }
      if (baseParsed.parts >= 2 && baseParsed.minor === 0 && parsed.minor !== 0) {
        return false;
      }
      if (baseParsed.parts === 3 && baseParsed.minor === 0 && parsed.patch < baseParsed.patch) {
        return false;
      }
    }

    return compareVersions(version, base) >= 0;
  }

  // Tilde range: ~1.2.3 means >=1.2.3 <1.3.0
  if (range.startsWith('~')) {
    const baseRaw = range.slice(1).trim();
    const baseParsed = parseVersionLoose(baseRaw);
    if (!baseParsed) return false;
    const base = normalizeVersionInput(baseRaw);
    if (!base) return false;

    if (parsed.major !== baseParsed.major) {
      return false;
    }
    if (baseParsed.parts >= 2 && parsed.minor !== baseParsed.minor) {
      return false;
    }

    return compareVersions(version, base) >= 0;
  }

  // Greater than or equal: >=1.2.3
  if (range.startsWith('>=')) {
    const rawBase = range.slice(2).trim();
    const base = normalizeVersionInput(rawBase) ?? rawBase;
    return compareVersions(version, base) >= 0;
  }

  // Greater than: >1.2.3
  if (range.startsWith('>')) {
    const rawBase = range.slice(1).trim();
    const base = normalizeVersionInput(rawBase) ?? rawBase;
    return compareVersions(version, base) > 0;
  }

  // Less than or equal: <=1.2.3
  if (range.startsWith('<=')) {
    const rawBase = range.slice(2).trim();
    const base = normalizeVersionInput(rawBase) ?? rawBase;
    return compareVersions(version, base) <= 0;
  }

  // Less than: <1.2.3
  if (range.startsWith('<')) {
    const rawBase = range.slice(1).trim();
    const base = normalizeVersionInput(rawBase) ?? rawBase;
    return compareVersions(version, base) < 0;
  }

  // X-ranges: 1.x, 1.2.x, 1, 1.2
  if (range.includes('x') || range.includes('X') || /^\d+$/.test(range) || /^\d+\.\d+$/.test(range)) {
    const parts = range.replace(/[xX]/g, '').split('.').filter(Boolean);

    if (parts.length === 1) {
      return parsed.major === parseInt(parts[0], 10);
    }
    if (parts.length === 2) {
      return (
        parsed.major === parseInt(parts[0], 10) &&
        parsed.minor === parseInt(parts[1], 10)
      );
    }
  }

  // Multiple conditions with space (AND) - handle simple cases
  if (range.includes(' ')) {
    const conditions = range.split(/\s+/).filter(Boolean);
    return conditions.every((r) => satisfies(version, r));
  }

  // Fallback: try exact match
  const normalizedFallback = normalizeVersionInput(range);
  return compareVersions(version, normalizedFallback ?? range) === 0;
}

/**
 * Find the best matching version from available versions
 */
function findBestVersion(versions: string[], range: string): string | null {
  // Sort versions in descending order
  const sorted = [...versions].sort((a, b) => compareVersions(b, a));

  // Find the first version that satisfies the range
  for (const version of sorted) {
    if (satisfies(version, range)) {
      return version;
    }
  }

  return null;
}

/**
 * Resolve all dependencies for a package
 */
export async function resolveDependencies(
  packageName: string,
  versionRange: string = 'latest',
  options: ResolveOptions = {}
): Promise<Map<string, ResolvedPackage>> {
  const registry = options.registry || new Registry();
  const context: ResolveContext = {
    registry,
    resolved: new Map(),
    resolving: new Set(),
    options,
  };

  await resolvePackage(packageName, versionRange, context, true);

  return context.resolved;
}

/**
 * Resolve dependencies from a package.json
 */
export async function resolveFromPackageJson(
  packageJson: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  },
  options: ResolveOptions = {}
): Promise<Map<string, ResolvedPackage>> {
  const registry = options.registry || new Registry();
  const context: ResolveContext = {
    registry,
    resolved: new Map(),
    resolving: new Set(),
    options,
  };

  const deps = { ...packageJson.dependencies };

  if (options.includeDev && packageJson.devDependencies) {
    Object.assign(deps, packageJson.devDependencies);
  }

  for (const [name, range] of Object.entries(deps)) {
    await resolvePackage(name, range, context, true);
  }

  return context.resolved;
}

/**
 * Recursively resolve a single package and its dependencies
 */
async function resolvePackage(
  packageName: string,
  versionRange: string,
  context: ResolveContext,
  isRootDependency: boolean = false
): Promise<void> {
  const { registry, resolved, resolving, options } = context;

  // Create a key for this package request
  const key = `${packageName}@${versionRange}`;

  // Check if we're already resolving this (circular dependency)
  if (resolving.has(key)) {
    return;
  }

  // Check if we've already resolved a compatible version
  if (resolved.has(packageName)) {
    const existing = resolved.get(packageName)!;
    if (satisfies(existing.version, versionRange)) {
      return;
    }
    // Let explicit root dependencies override previously resolved transitive versions.
    if (isRootDependency) {
      options.onProgress?.(
        `Overriding ${packageName}@${existing.version} with root requirement ${versionRange}`
      );
      resolved.delete(packageName);
    } else {
      // Flat node_modules fallback for transitive conflicts.
      return;
    }
  }

  resolving.add(key);

  try {
    options.onProgress?.(`Resolving ${packageName}@${versionRange}`);

    const alias = parseNpmAliasSpec(versionRange);
    if (alias) {
      await resolvePackage(alias.targetName, alias.targetRange, context, isRootDependency);
      const targetResolved = resolved.get(alias.targetName);
      if (!targetResolved) {
        throw new Error(
          `npm alias target "${alias.targetName}@${alias.targetRange}" for "${packageName}" was not resolved`
        );
      }

      resolved.set(packageName, {
        ...targetResolved,
        name: packageName,
      });
      return;
    }

    // Fetch package manifest
    const manifest = await registry.getPackageManifest(packageName);

    // Find best matching version
    const versions = Object.keys(manifest.versions);
    let targetVersion: string;

    if (versionRange === 'latest' || versionRange === '*') {
      targetVersion = manifest['dist-tags'].latest;
    } else if (manifest['dist-tags'][versionRange]) {
      targetVersion = manifest['dist-tags'][versionRange];
    } else {
      const best = findBestVersion(versions, versionRange);
      if (!best) {
        throw new Error(
          `No matching version found for ${packageName}@${versionRange}`
        );
      }
      targetVersion = best;
    }

    // Get version metadata
    const versionData = manifest.versions[targetVersion];

    // Store resolved package
    const resolvedPackage: ResolvedPackage = {
      name: packageName,
      version: targetVersion,
      tarballUrl: versionData.dist.tarball,
      dependencies: versionData.dependencies || {},
    };

    resolved.set(packageName, resolvedPackage);

    // Resolve dependencies in parallel
    // Include non-optional peerDependencies (npm v7+ behavior).
    // Peer deps marked optional in peerDependenciesMeta are skipped.
    const deps: Record<string, string> = {};

    if (versionData.peerDependencies) {
      const meta = versionData.peerDependenciesMeta || {};
      for (const [name, range] of Object.entries(versionData.peerDependencies)) {
        if (!meta[name]?.optional) {
          deps[name] = range;
        }
      }
    }

    // Regular dependencies override peer deps
    Object.assign(deps, versionData.dependencies);

    if (versionData.peerDependencies) {
      for (const [peerName, peerRange] of Object.entries(versionData.peerDependencies)) {
        const isOptionalPeer =
          versionData.peerDependenciesMeta?.[peerName]?.optional === true;
        if (!isOptionalPeer) {
          deps[peerName] = peerRange;
        }
      }
    }

    if (options.includeOptional && versionData.optionalDependencies) {
      Object.assign(deps, versionData.optionalDependencies);
    }

    const depEntries = Object.entries(deps);
    if (depEntries.length > 0) {
      // Resolve dependencies in parallel batches
      const CONCURRENCY = 8;
      for (let i = 0; i < depEntries.length; i += CONCURRENCY) {
        const batch = depEntries.slice(i, i + CONCURRENCY);
        await Promise.all(
          batch.map(([depName, depRange]) => resolvePackage(depName, depRange, context, false))
        );
      }
    }
  } finally {
    resolving.delete(key);
  }
}

// Export utilities for testing
export { parseVersion, compareVersions, satisfies, findBestVersion };
