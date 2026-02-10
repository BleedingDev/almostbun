/**
 * bun.lock parser utilities.
 *
 * Supports Bun text lockfile (`bun.lock`) format.
 */

import * as path from '../shims/path';
import { VirtualFS } from '../virtual-fs';
import { PackageLockInstallEntry } from './package-lock';

export interface ParsedBunLock {
  source: 'bun.lock';
  lockfileVersion: number;
  entries: PackageLockInstallEntry[];
}

interface BunLockWorkspace {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface BunLockNode {
  rawKey: string;
  chain: string[];
  name: string;
  version: string;
  dependencies: string[];
  optionalDependencies: string[];
  peerDependencies: string[];
  optionalPeers: string[];
  os?: unknown;
  cpu?: unknown;
}

function normalizePathLike(value: string): string {
  return value.replace(/\\/g, '/');
}

function parseLooseJson(text: string): unknown {
  // bun.lock is JSON-like and commonly includes trailing commas.
  const withoutTrailingCommas = text.replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(withoutTrailingCommas);
}

function parseLocator(locator: string): { name: string; version: string } | null {
  const trimmed = locator.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('@')) {
    const slashIndex = trimmed.indexOf('/');
    if (slashIndex < 0) return null;
    const atIndex = trimmed.indexOf('@', slashIndex + 1);
    if (atIndex < 0) return null;
    return {
      name: trimmed.slice(0, atIndex),
      version: trimmed.slice(atIndex + 1),
    };
  }

  const atIndex = trimmed.lastIndexOf('@');
  if (atIndex <= 0) return null;
  return {
    name: trimmed.slice(0, atIndex),
    version: trimmed.slice(atIndex + 1),
  };
}

function splitPackagePath(rawKey: string): string[] {
  const parts = normalizePathLike(rawKey).split('/').filter(Boolean);
  const names: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const current = parts[i];
    if (current.startsWith('@') && i + 1 < parts.length) {
      names.push(`${current}/${parts[i + 1]}`);
      i++;
    } else {
      names.push(current);
    }
  }
  return names;
}

function toNodeModulesKey(chain: string[]): string {
  if (chain.length === 0) {
    return 'node_modules';
  }

  let out = `node_modules/${chain[0]}`;
  for (let i = 1; i < chain.length; i++) {
    out += `/node_modules/${chain[i]}`;
  }
  return out;
}

function dependencyNames(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  return Object.keys(value as Record<string, unknown>);
}

function parseOptionalPeerNames(meta: unknown): string[] {
  const result = new Set<string>();
  if (!meta || typeof meta !== 'object') {
    return [];
  }

  const optionalPeers = (meta as { optionalPeers?: unknown }).optionalPeers;
  if (Array.isArray(optionalPeers)) {
    for (const entry of optionalPeers) {
      if (typeof entry === 'string') {
        result.add(entry);
      }
    }
  }

  const peerDependenciesMeta = (meta as { peerDependenciesMeta?: unknown }).peerDependenciesMeta;
  if (peerDependenciesMeta && typeof peerDependenciesMeta === 'object') {
    for (const [name, peerMeta] of Object.entries(
      peerDependenciesMeta as Record<string, unknown>
    )) {
      if (
        peerMeta &&
        typeof peerMeta === 'object' &&
        (peerMeta as { optional?: unknown }).optional === true
      ) {
        result.add(name);
      }
    }
  }

  return [...result];
}

function normalizeRuleList(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

function matchesRuleSet(rules: string[], current?: string): boolean {
  if (!current || rules.length === 0) {
    return true;
  }

  const negatives = rules.filter((rule) => rule.startsWith('!')).map((rule) => rule.slice(1));
  if (negatives.includes(current)) {
    return false;
  }

  const positives = rules.filter((rule) => !rule.startsWith('!'));
  if (positives.length === 0) {
    return true;
  }

  if (positives.includes('none')) {
    return false;
  }

  return positives.includes(current);
}

function isNodeCompatible(node: BunLockNode): boolean {
  const platform = typeof process !== 'undefined' ? process.platform : undefined;
  const arch = typeof process !== 'undefined' ? process.arch : undefined;

  return (
    matchesRuleSet(normalizeRuleList(node.os), platform) &&
    matchesRuleSet(normalizeRuleList(node.cpu), arch)
  );
}

function sortEntries(entries: PackageLockInstallEntry[]): void {
  entries.sort((a, b) => {
    const depthA = normalizePathLike(a.key).split('/').filter(Boolean).length;
    const depthB = normalizePathLike(b.key).split('/').filter(Boolean).length;
    return depthA - depthB || a.key.localeCompare(b.key);
  });
}

function resolveRootKey(
  depName: string,
  nodes: Map<string, BunLockNode>,
  topLevelByName: Map<string, string>
): string | null {
  if (nodes.has(depName)) {
    return depName;
  }

  if (topLevelByName.has(depName)) {
    return topLevelByName.get(depName)!;
  }

  return null;
}

function resolveChildKey(
  parentRawKey: string,
  depName: string,
  nodes: Map<string, BunLockNode>,
  topLevelByName: Map<string, string>
): string | null {
  const nestedKey = `${parentRawKey}/${depName}`;
  if (nodes.has(nestedKey)) {
    return nestedKey;
  }

  if (nodes.has(depName)) {
    return depName;
  }

  // Bun can flatten some deps at top-level.
  if (topLevelByName.has(depName)) {
    return topLevelByName.get(depName)!;
  }

  // Fallback: choose nearest descendant by suffix.
  let candidate: string | null = null;
  for (const [rawKey, node] of nodes) {
    if (!rawKey.startsWith(`${parentRawKey}/`)) continue;
    if (node.name !== depName) continue;
    if (!candidate || rawKey.length < candidate.length) {
      candidate = rawKey;
    }
  }
  return candidate;
}

function collectReachable(
  rootDependencies: string[],
  nodes: Map<string, BunLockNode>,
  topLevelByName: Map<string, string>
): Set<string> {
  const reachable = new Set<string>();
  const stack: string[] = [];

  for (const dep of rootDependencies) {
    const rootKey = resolveRootKey(dep, nodes, topLevelByName);
    if (rootKey) {
      stack.push(rootKey);
    }
  }

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (reachable.has(current)) continue;

    const node = nodes.get(current);
    if (!node) continue;
    reachable.add(current);

    const requiredPeers = node.peerDependencies.filter(
      (depName) => !node.optionalPeers.includes(depName)
    );
    const nextDeps = [...node.dependencies, ...node.optionalDependencies, ...requiredPeers];

    for (const depName of nextDeps) {
      const child = resolveChildKey(current, depName, nodes, topLevelByName);
      if (child && !reachable.has(child)) {
        stack.push(child);
      }
    }
  }

  return reachable;
}

export function parseBunLockObject(
  lockfile: unknown,
  cwd: string
): ParsedBunLock | null {
  if (!lockfile || typeof lockfile !== 'object') {
    return null;
  }

  const data = lockfile as {
    lockfileVersion?: unknown;
    workspaces?: unknown;
    packages?: unknown;
  };

  const packages = data.packages;
  if (!packages || typeof packages !== 'object') {
    return null;
  }

  const nodes = new Map<string, BunLockNode>();
  const topLevelByName = new Map<string, string>();

  for (const [rawKey, rawValue] of Object.entries(packages as Record<string, unknown>)) {
    if (!Array.isArray(rawValue) || rawValue.length === 0) {
      continue;
    }

    const locator = typeof rawValue[0] === 'string' ? rawValue[0] : null;
    if (!locator) continue;
    const parsedLocator = parseLocator(locator);
    if (!parsedLocator) continue;

    const meta = rawValue[2];
    const keyChain = splitPackagePath(rawKey);
    const chain = keyChain.length > 0 ? keyChain : [parsedLocator.name];
    if (chain[chain.length - 1] !== parsedLocator.name) {
      chain.push(parsedLocator.name);
    }

    const node: BunLockNode = {
      rawKey,
      chain,
      name: parsedLocator.name,
      version: parsedLocator.version || '0.0.0',
      dependencies: dependencyNames((meta as { dependencies?: unknown })?.dependencies),
      optionalDependencies: dependencyNames(
        (meta as { optionalDependencies?: unknown })?.optionalDependencies
      ),
      peerDependencies: dependencyNames(
        (meta as { peerDependencies?: unknown })?.peerDependencies
      ),
      optionalPeers: parseOptionalPeerNames(meta),
      os: (meta as { os?: unknown })?.os,
      cpu: (meta as { cpu?: unknown })?.cpu,
    };

    nodes.set(rawKey, node);
    if (chain.length === 1) {
      topLevelByName.set(node.name, rawKey);
    }
  }

  if (nodes.size === 0) {
    return {
      source: 'bun.lock',
      lockfileVersion: typeof data.lockfileVersion === 'number' ? data.lockfileVersion : 0,
      entries: [],
    };
  }

  const workspaces = (data.workspaces && typeof data.workspaces === 'object')
    ? (data.workspaces as Record<string, BunLockWorkspace>)
    : {};
  const rootWorkspace = workspaces[''] || {};
  const rootProdDeps = Object.keys(rootWorkspace.dependencies || {});
  const rootDevDeps = Object.keys(rootWorkspace.devDependencies || {});

  const prodReachable = collectReachable(rootProdDeps, nodes, topLevelByName);
  const devReachable = collectReachable(rootDevDeps, nodes, topLevelByName);
  const included = new Set<string>([...prodReachable, ...devReachable]);

  if (included.size === 0) {
    for (const key of nodes.keys()) {
      included.add(key);
    }
  }

  const entries: PackageLockInstallEntry[] = [];

  for (const rawKey of included) {
    const node = nodes.get(rawKey);
    if (!node) continue;

    const key = toNodeModulesKey(node.chain);
    entries.push({
      key,
      installPath: path.join(cwd, key),
      name: node.name,
      version: node.version,
      dev: devReachable.has(rawKey) && !prodReachable.has(rawKey),
      optional: !isNodeCompatible(node),
      link: false,
    });
  }

  sortEntries(entries);

  return {
    source: 'bun.lock',
    lockfileVersion: typeof data.lockfileVersion === 'number' ? data.lockfileVersion : 0,
    entries,
  };
}

export function readBunLockFile(
  vfs: VirtualFS,
  cwd: string
): ParsedBunLock | null {
  const lockPath = path.join(cwd, 'bun.lock');
  if (!vfs.existsSync(lockPath)) {
    return null;
  }

  try {
    const raw = vfs.readFileSync(lockPath, 'utf8');
    const parsed = parseLooseJson(raw);
    return parseBunLockObject(parsed, cwd);
  } catch {
    // Invalid bun.lock should not block install; callers can fall back to package.json.
    return null;
  }
}
