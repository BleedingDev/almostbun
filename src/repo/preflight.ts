import * as path from '../shims/path';
import { VirtualFS } from '../virtual-fs';
import { getNativePackageSupport } from '../native-fallbacks';

type PackageJsonLike = {
  name?: string;
  workspaces?: string[] | { packages?: string[] };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  exports?: Record<string, unknown> | string;
};

export type PreflightSeverity = 'info' | 'warning' | 'error';

export interface PreflightIssue {
  code: string;
  severity: PreflightSeverity;
  message: string;
  path?: string;
}

export interface PreflightInstallOverrides {
  includeWorkspaces?: boolean;
  preferPublishedWorkspacePackages?: boolean;
}

export interface RepoPreflightOptions {
  autoFix?: boolean;
  includeWorkspaces?: boolean;
  preferPublishedWorkspacePackages?: boolean;
  onProgress?: (message: string) => void;
}

export interface RepoPreflightResult {
  issues: PreflightIssue[];
  installOverrides: PreflightInstallOverrides;
  hasErrors: boolean;
}

const IMPORT_SPECIFIER_PATTERN =
  /\b(?:import\s+[^'"]*?\s+from\s*|export\s+[^'"]*?\s+from\s*|require\s*\(|import\s*\()\s*['"]([^'"]+)['"]/g;
const SOURCE_FILE_PATTERN = /\.(?:[cm]?[jt]sx?)$/i;
const EFFECT_SUBPATHS = new Set([
  '@modern-js/plugin-bff/effect-client',
  '@modern-js/plugin-bff/effect-server',
]);

function normalizePathLike(input: string): string {
  return input.replace(/\\/g, '/');
}

function hasPath(vfs: VirtualFS, candidatePath: string): boolean {
  try {
    vfs.statSync(candidatePath);
    return true;
  } catch {
    return false;
  }
}

function readPackageJson(vfs: VirtualFS, projectPath: string): PackageJsonLike | null {
  const pkgPath = path.posix.join(projectPath, 'package.json');
  if (!hasPath(vfs, pkgPath)) {
    return null;
  }

  try {
    return JSON.parse(vfs.readFileSync(pkgPath, 'utf8')) as PackageJsonLike;
  } catch {
    return null;
  }
}

function getWorkspacePatterns(pkg: PackageJsonLike | null): string[] {
  if (!pkg) return [];
  if (Array.isArray(pkg.workspaces)) {
    return pkg.workspaces.filter((item): item is string => typeof item === 'string' && item.length > 0);
  }
  if (pkg.workspaces && typeof pkg.workspaces === 'object') {
    const nested = pkg.workspaces.packages;
    if (Array.isArray(nested)) {
      return nested.filter((item): item is string => typeof item === 'string' && item.length > 0);
    }
  }
  return [];
}

function collectDependencySpecs(pkg: PackageJsonLike | null): Array<{ name: string; spec: string }> {
  if (!pkg) return [];
  const out: Array<{ name: string; spec: string }> = [];
  for (const group of [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies, pkg.peerDependencies]) {
    if (!group) continue;
    for (const [name, spec] of Object.entries(group)) {
      out.push({ name, spec });
    }
  }
  return out;
}

function findWorkspaceRoot(vfs: VirtualFS, startPath: string): string | null {
  let current = startPath;
  while (true) {
    const pkg = readPackageJson(vfs, current);
    if (pkg && getWorkspacePatterns(pkg).length > 0) {
      return current;
    }
    if (current === '/') {
      return null;
    }
    current = path.posix.dirname(current);
  }
}

function walkSourceFiles(vfs: VirtualFS, projectPath: string): string[] {
  const files: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: projectPath, depth: 0 }];
  const visited = new Set<string>();
  const maxDepth = 8;
  const maxFiles = 500;

  while (queue.length > 0 && files.length < maxFiles) {
    const current = queue.shift()!;
    if (visited.has(current.dir)) continue;
    visited.add(current.dir);

    let entries: string[] = [];
    try {
      entries = vfs.readdirSync(current.dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === '.next') {
        continue;
      }
      const candidate = path.posix.join(current.dir, entry);
      try {
        const stat = vfs.statSync(candidate);
        if (stat.isFile() && SOURCE_FILE_PATTERN.test(entry)) {
          files.push(candidate);
        } else if (stat.isDirectory() && current.depth < maxDepth) {
          queue.push({ dir: candidate, depth: current.depth + 1 });
        }
      } catch {
        // ignore inaccessible files
      }
      if (files.length >= maxFiles) {
        break;
      }
    }
  }

  return files;
}

function extractImportSpecifiers(source: string): string[] {
  const results: string[] = [];
  IMPORT_SPECIFIER_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null = null;
  while ((match = IMPORT_SPECIFIER_PATTERN.exec(source))) {
    const specifier = match[1]?.trim();
    if (specifier) {
      results.push(specifier);
    }
  }
  return results;
}

function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('node:') && !specifier.startsWith('bun:');
}

function getPackageNameFromSpecifier(specifier: string): string {
  const normalized = normalizePathLike(specifier);
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return '';
  if (parts[0].startsWith('@') && parts.length > 1) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

function hasExportForSubpath(exportsField: PackageJsonLike['exports'], subPath: string): boolean {
  if (!exportsField) {
    return true;
  }
  if (typeof exportsField === 'string') {
    return subPath === '.';
  }
  if (typeof exportsField !== 'object') {
    return false;
  }

  const entries = Object.entries(exportsField);
  const hasExplicitSubpathKeys = entries.some(([key]) => key.startsWith('.'));
  if (!hasExplicitSubpathKeys) {
    return subPath === '.';
  }

  for (const [key] of entries) {
    if (key === subPath) {
      return true;
    }
    if (key.includes('*')) {
      const pattern = key
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');
      if (new RegExp(`^${pattern}$`).test(subPath)) {
        return true;
      }
    }
  }

  return false;
}

export function runRepoPreflight(
  vfs: VirtualFS,
  projectPath: string,
  options: RepoPreflightOptions = {}
): RepoPreflightResult {
  const normalizedProjectPath = normalizePathLike(projectPath);
  const issues: PreflightIssue[] = [];
  const installOverrides: PreflightInstallOverrides = {};
  const pkg = readPackageJson(vfs, normalizedProjectPath);

  if (!pkg) {
    return {
      issues: [
        {
          code: 'preflight.package-json.missing',
          severity: 'warning',
          message: `No package.json found at ${normalizedProjectPath}; dependency preflight skipped`,
          path: path.posix.join(normalizedProjectPath, 'package.json'),
        },
      ],
      installOverrides,
      hasErrors: false,
    };
  }

  const dependencySpecs = collectDependencySpecs(pkg);
  const reportedNativePackages = new Set<string>();
  for (const dependency of dependencySpecs) {
    if (reportedNativePackages.has(dependency.name)) {
      continue;
    }
    reportedNativePackages.add(dependency.name);

    const nativeSupport = getNativePackageSupport(dependency.name);
    if (!nativeSupport) {
      continue;
    }

    if (nativeSupport.kind === 'fallback') {
      issues.push({
        code: 'preflight.native.fallback-available',
        severity: 'info',
        message:
          `Native package "${dependency.name}" will use browser fallback "${nativeSupport.fallbackModuleId}". ${nativeSupport.note}`,
        path: path.posix.join(normalizedProjectPath, 'package.json'),
      });
      continue;
    }

    issues.push({
      code: 'preflight.native.unsupported',
      severity: 'warning',
      message:
        `Native package "${dependency.name}" is likely unsupported in browser runtime. ${nativeSupport.note}`,
      path: path.posix.join(normalizedProjectPath, 'package.json'),
    });
  }

  const workspaceDeps = dependencySpecs.filter((entry) => entry.spec.startsWith('workspace:'));
  const workspaceRoot = findWorkspaceRoot(vfs, normalizedProjectPath);
  if (workspaceDeps.length > 0 && !workspaceRoot) {
    issues.push({
      code: 'preflight.workspace.root-missing',
      severity: 'error',
      message:
        `Detected workspace:* dependencies (${workspaceDeps.slice(0, 5).map(entry => entry.name).join(', ')}) but no workspace root was found above ${normalizedProjectPath}`,
      path: path.posix.join(normalizedProjectPath, 'package.json'),
    });

    if (options.autoFix !== false && options.preferPublishedWorkspacePackages === undefined) {
      installOverrides.preferPublishedWorkspacePackages = true;
      installOverrides.includeWorkspaces = options.includeWorkspaces ?? true;
      options.onProgress?.(
        'Preflight auto-fix: enabled preferPublishedWorkspacePackages for unresolved workspace:* dependencies'
      );
    }
  }

  const sourceFiles = walkSourceFiles(vfs, normalizedProjectPath);
  const allSpecifiers = new Set<string>();
  for (const filePath of sourceFiles) {
    let content = '';
    try {
      content = vfs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    for (const specifier of extractImportSpecifiers(content)) {
      allSpecifiers.add(specifier);
    }
  }

  const declaredDependencyNames = new Set(
    dependencySpecs.map((entry) => entry.name)
  );
  for (const specifier of allSpecifiers) {
    if (!EFFECT_SUBPATHS.has(specifier)) continue;
    if (!declaredDependencyNames.has('@modern-js/plugin-bff')) {
      issues.push({
        code: 'preflight.modernjs.effect.missing-plugin-bff',
        severity: 'error',
        message:
          `Project imports ${specifier} but @modern-js/plugin-bff is not declared in dependencies`,
      });
    }
  }

  for (const specifier of allSpecifiers) {
    if (!isBareSpecifier(specifier) || !specifier.includes('/')) {
      continue;
    }
    const packageName = getPackageNameFromSpecifier(specifier);
    if (!packageName || packageName === specifier) {
      continue;
    }
    const subPath = `./${normalizePathLike(specifier).slice(packageName.length + 1)}`;
    const pkgPath = path.posix.join(normalizedProjectPath, 'node_modules', packageName, 'package.json');
    if (!hasPath(vfs, pkgPath)) {
      continue;
    }
    const resolvedPkg = readPackageJson(vfs, path.posix.dirname(pkgPath));
    if (!resolvedPkg || !resolvedPkg.exports) {
      continue;
    }
    if (!hasExportForSubpath(resolvedPkg.exports, subPath)) {
      issues.push({
        code: 'preflight.exports.subpath-missing',
        severity: 'warning',
        message: `Specifier "${specifier}" does not appear in exports map of ${packageName}`,
        path: pkgPath,
      });
    }
  }

  return {
    issues,
    installOverrides,
    hasErrors: issues.some((issue) => issue.severity === 'error'),
  };
}
