/**
 * package-lock parser utilities.
 *
 * Supports:
 * - npm lockfile v2/v3 `packages` map
 * - npm lockfile v1 `dependencies` tree
 * - npm-shrinkwrap equivalents
 */

import * as path from '../shims/path';
import { VirtualFS } from '../virtual-fs';

export interface PackageLockInstallEntry {
  key: string;
  installPath: string;
  name: string;
  version: string;
  resolved?: string;
  integrity?: string;
  dev: boolean;
  optional: boolean;
  link: boolean;
  localPath?: string;
}

export interface ParsedPackageLock {
  source: 'package-lock.json' | 'npm-shrinkwrap.json';
  lockfileVersion: number;
  entries: PackageLockInstallEntry[];
}

function normalizePathLike(value: string): string {
  return value.replace(/\\/g, '/');
}

function inferPackageNameFromPath(key: string): string | null {
  const segments = normalizePathLike(key).split('/').filter(Boolean);
  const nodeModulesIndex = segments.lastIndexOf('node_modules');
  if (nodeModulesIndex < 0 || nodeModulesIndex + 1 >= segments.length) {
    return null;
  }

  const first = segments[nodeModulesIndex + 1];
  if (first.startsWith('@') && nodeModulesIndex + 2 < segments.length) {
    return `${first}/${segments[nodeModulesIndex + 2]}`;
  }

  return first;
}

function isLikelyRemoteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function sortEntries(entries: PackageLockInstallEntry[]): void {
  entries.sort((a, b) => {
    const depthA = normalizePathLike(a.key).split('/').filter(Boolean).length;
    const depthB = normalizePathLike(b.key).split('/').filter(Boolean).length;
    return depthA - depthB || a.key.localeCompare(b.key);
  });
}

function parseV2V3Packages(
  packages: Record<string, unknown>,
  cwd: string
): PackageLockInstallEntry[] {
  const entries: PackageLockInstallEntry[] = [];

  for (const [rawKey, rawPkg] of Object.entries(packages)) {
    const key = normalizePathLike(rawKey);
    if (!key || key === '' || !key.includes('node_modules')) {
      continue;
    }

    if (!rawPkg || typeof rawPkg !== 'object') {
      continue;
    }

    const pkg = rawPkg as {
      name?: unknown;
      version?: unknown;
      resolved?: unknown;
      integrity?: unknown;
      dev?: unknown;
      optional?: unknown;
      link?: unknown;
    };

    const nameFromPath = inferPackageNameFromPath(key);
    const name = typeof pkg.name === 'string' ? pkg.name : nameFromPath;
    if (!name) {
      continue;
    }

    const resolved = typeof pkg.resolved === 'string' ? pkg.resolved : undefined;
    const link = pkg.link === true;
    const localResolved = resolved?.replace(/^file:/, '');
    const localPath = link && localResolved && !isLikelyRemoteUrl(localResolved)
      ? path.join(cwd, normalizePathLike(localResolved))
      : undefined;

    entries.push({
      key,
      installPath: path.join(cwd, key),
      name,
      version: typeof pkg.version === 'string' ? pkg.version : '0.0.0',
      resolved,
      integrity: typeof pkg.integrity === 'string' ? pkg.integrity : undefined,
      dev: pkg.dev === true,
      optional: pkg.optional === true,
      link,
      localPath,
    });
  }

  return entries;
}

interface LockfileV1DependencyNode {
  version?: unknown;
  resolved?: unknown;
  integrity?: unknown;
  dev?: unknown;
  optional?: unknown;
  dependencies?: unknown;
}

function collectV1Dependencies(
  deps: Record<string, unknown>,
  cwd: string,
  entries: PackageLockInstallEntry[],
  parentKey?: string
): void {
  for (const [depName, rawNode] of Object.entries(deps)) {
    if (!rawNode || typeof rawNode !== 'object') {
      continue;
    }

    const node = rawNode as LockfileV1DependencyNode;
    const key = parentKey
      ? `${parentKey}/node_modules/${depName}`
      : `node_modules/${depName}`;

    entries.push({
      key,
      installPath: path.join(cwd, key),
      name: depName,
      version: typeof node.version === 'string' ? node.version : '0.0.0',
      resolved: typeof node.resolved === 'string' ? node.resolved : undefined,
      integrity: typeof node.integrity === 'string' ? node.integrity : undefined,
      dev: node.dev === true,
      optional: node.optional === true,
      link: false,
    });

    if (node.dependencies && typeof node.dependencies === 'object') {
      collectV1Dependencies(
        node.dependencies as Record<string, unknown>,
        cwd,
        entries,
        key
      );
    }
  }
}

function parseV1Dependencies(
  dependencies: Record<string, unknown>,
  cwd: string
): PackageLockInstallEntry[] {
  const entries: PackageLockInstallEntry[] = [];
  collectV1Dependencies(dependencies, cwd, entries);
  return entries;
}

export function parsePackageLockObject(
  lockfile: unknown,
  cwd: string,
  source: ParsedPackageLock['source']
): ParsedPackageLock | null {
  if (!lockfile || typeof lockfile !== 'object') {
    return null;
  }

  const data = lockfile as {
    lockfileVersion?: unknown;
    packages?: unknown;
    dependencies?: unknown;
  };
  const lockfileVersion = typeof data.lockfileVersion === 'number'
    ? data.lockfileVersion
    : 0;

  let entries: PackageLockInstallEntry[] = [];
  if (data.packages && typeof data.packages === 'object') {
    entries = parseV2V3Packages(data.packages as Record<string, unknown>, cwd);
  } else if (data.dependencies && typeof data.dependencies === 'object') {
    entries = parseV1Dependencies(data.dependencies as Record<string, unknown>, cwd);
  } else {
    return null;
  }

  sortEntries(entries);

  return {
    source,
    lockfileVersion: lockfileVersion || (data.dependencies ? 1 : 0),
    entries,
  };
}

export function readPackageLockFile(
  vfs: VirtualFS,
  cwd: string
): ParsedPackageLock | null {
  const candidates: Array<ParsedPackageLock['source']> = [
    'package-lock.json',
    'npm-shrinkwrap.json',
  ];

  for (const filename of candidates) {
    const fullPath = path.join(cwd, filename);
    if (!vfs.existsSync(fullPath)) {
      continue;
    }

    try {
      const raw = vfs.readFileSync(fullPath, 'utf8');
      const parsed = JSON.parse(raw);
      const lockfile = parsePackageLockObject(parsed, cwd, filename);
      if (lockfile) {
        return lockfile;
      }
    } catch {
      // Invalid lockfile JSON should not block install; fall through to next lock candidate.
      continue;
    }
  }

  return null;
}
