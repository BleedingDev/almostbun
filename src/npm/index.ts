/**
 * npm Package Manager
 * Orchestrates package installation into the virtual file system
 */

import { VirtualFS } from '../virtual-fs';
import { Registry, RegistryOptions } from './registry';
import {
  resolveDependencies,
  resolveFromPackageJson,
  ResolvedPackage,
  ResolveOptions,
} from './resolver';
import { downloadAndExtract, extractTarball } from './tarball';
import { PackageLockInstallEntry, readPackageLockFile } from './package-lock';
import { readBunLockFile } from './bun-lock';
import * as path from '../shims/path';
import { initTransformer, transformPackage, isTransformerReady } from '../transform';
import { parseGitHubRepoUrl } from '../repo/github';

/**
 * Normalize a package.json bin field into a consistent Record<string, string>.
 * Handles both string form ("bin": "cli.js") and object form ("bin": {"cmd": "cli.js"}).
 */
function normalizeBin(pkgName: string, bin?: Record<string, string> | string): Record<string, string> {
  if (!bin) return {};
  if (typeof bin === 'string') {
    // String form uses the package name (without scope) as the command name
    const cmdName = pkgName.includes('/') ? pkgName.split('/').pop()! : pkgName;
    return { [cmdName]: bin };
  }
  return bin;
}

export interface InstallOptions {
  registry?: string;
  save?: boolean;
  saveDev?: boolean;
  includeDev?: boolean;
  includeOptional?: boolean;
  /**
   * When installFromPackageJson() is called at a monorepo root,
   * also install dependencies for workspace packages.
   * Default: true
   */
  includeWorkspaces?: boolean;
  /**
   * Prefer npm lockfiles when present (`package-lock.json` / `npm-shrinkwrap.json`).
   * Default: true
   */
  preferLockfile?: boolean;
  /**
   * Prefer published registry packages for workspace dependencies when local
   * workspace sources do not expose runnable build outputs.
   * Useful for importing app subdirectories from large monorepos.
   * Default: false
   */
  preferPublishedWorkspacePackages?: boolean;
  onProgress?: (message: string) => void;
  /** Transform ESM packages to CJS after install (default: true) */
  transform?: boolean;
}

export interface InstallResult {
  installed: Map<string, ResolvedPackage>;
  added: string[];
}

type PackageJsonLike = {
  name?: string;
  version?: string;
  main?: string;
  module?: string;
  exports?: unknown;
  bin?: string | Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
};

type DependencyProtocol =
  | 'registry'
  | 'npm'
  | 'workspace'
  | 'file'
  | 'link'
  | 'tarball'
  | 'github'
  | 'git';

export interface ParsedDependencySpec {
  name: string;
  protocol: DependencyProtocol;
  rawSpec: string;
  versionRange?: string;
  target?: string;
}

interface WorkspacePackage {
  name: string;
  version: string;
  dir: string;
  packageJson: PackageJsonLike;
}

interface ManifestInstallContext {
  options: InstallOptions;
  workspacePackages: Map<string, WorkspacePackage>;
  aggregateResolved: Map<string, ResolvedPackage>;
  aggregateAdded: string[];
  visitedInstalls: Set<string>;
}

type ParsedInstallLockfile = {
  source: string;
  lockfileVersion: number;
  entries: PackageLockInstallEntry[];
};

function normalizePathLike(value: string): string {
  return value.replace(/\\/g, '/');
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Parse dependency value from package.json into protocol-aware structure.
 */
export function parseDependencySpec(name: string, spec: string): ParsedDependencySpec {
  const trimmed = (spec || '').trim();
  if (!trimmed) {
    return { name, protocol: 'registry', rawSpec: '*', versionRange: '*' };
  }

  if (trimmed.startsWith('workspace:')) {
    return {
      name,
      protocol: 'workspace',
      rawSpec: trimmed,
      target: trimmed.slice('workspace:'.length).trim() || '*',
    };
  }

  if (trimmed.startsWith('npm:')) {
    const aliasTarget = trimmed.slice('npm:'.length).trim();
    return {
      name,
      protocol: 'npm',
      rawSpec: trimmed,
      target: aliasTarget,
    };
  }

  if (trimmed.startsWith('file:')) {
    return {
      name,
      protocol: 'file',
      rawSpec: trimmed,
      target: trimmed.slice('file:'.length).trim(),
    };
  }

  if (trimmed.startsWith('link:')) {
    return {
      name,
      protocol: 'link',
      rawSpec: trimmed,
      target: trimmed.slice('link:'.length).trim(),
    };
  }

  if (
    trimmed.startsWith('github:') ||
    /^(?:git\+)?https?:\/\/(?:www\.)?github\.com\//i.test(trimmed)
  ) {
    return {
      name,
      protocol: 'github',
      rawSpec: trimmed,
      target: trimmed,
    };
  }

  if (/^https?:\/\/.+\.(?:tgz|tar\.gz)(?:[?#].*)?$/i.test(trimmed)) {
    return {
      name,
      protocol: 'tarball',
      rawSpec: trimmed,
      target: trimmed,
    };
  }

  if (
    trimmed.startsWith('git+') ||
    trimmed.startsWith('git:') ||
    trimmed.startsWith('ssh://') ||
    /^git@/i.test(trimmed)
  ) {
    return {
      name,
      protocol: 'git',
      rawSpec: trimmed,
      target: trimmed,
    };
  }

  return {
    name,
    protocol: 'registry',
    rawSpec: trimmed,
    versionRange: trimmed,
  };
}

/**
 * npm Package Manager for VirtualFS
 */
export class PackageManager {
  private vfs: VirtualFS;
  private registry: Registry;
  private cwd: string;

  constructor(vfs: VirtualFS, options: { cwd?: string } & RegistryOptions = {}) {
    this.vfs = vfs;
    this.registry = new Registry(options);
    this.cwd = options.cwd || '/';
  }

  /**
   * Install a package and its dependencies
   */
  async install(
    packageSpec: string,
    options: InstallOptions = {}
  ): Promise<InstallResult> {
    const { onProgress } = options;

    // Parse package spec (name@version)
    const { name, version } = parsePackageSpec(packageSpec);

    onProgress?.(`Resolving ${name}@${version || 'latest'}...`);

    // Resolve dependencies
    const resolved = await resolveDependencies(name, version || 'latest', {
      registry: this.registry,
      includeDev: options.includeDev,
      includeOptional: options.includeOptional,
      onProgress,
    });

    // Install all resolved packages
    const added = await this.installResolved(resolved, options);

    // Update package.json if save option is set
    if (options.save || options.saveDev) {
      const pkgToAdd = resolved.get(name);
      if (pkgToAdd) {
        await this.updatePackageJson(
          name,
          `^${pkgToAdd.version}`,
          options.saveDev || false
        );
      }
    }

    onProgress?.(`Installed ${resolved.size} packages`);

    return { installed: resolved, added };
  }

  /**
   * Install all dependencies from package.json
   */
  async installFromPackageJson(options: InstallOptions = {}): Promise<InstallResult> {
    const { onProgress } = options;

    const pkgJsonPath = path.join(this.cwd, 'package.json');

    if (!this.vfs.existsSync(pkgJsonPath)) {
      throw new Error('No package.json found');
    }

    const pkgJson = JSON.parse(this.vfs.readFileSync(pkgJsonPath, 'utf8'));
    const lockfile = options.preferLockfile !== false
      ? this.readPreferredLockfile()
      : null;
    if (lockfile && lockfile.entries.length > 0) {
      onProgress?.(`Installing from ${lockfile.source} (lockfile v${lockfile.lockfileVersion})...`);
      return this.installFromPackageLock(lockfile, options);
    }
    if (lockfile && lockfile.entries.length === 0) {
      onProgress?.(
        `${lockfile.source} had no installable entries; falling back to package.json resolution`
      );
    }

    const includeWorkspaces = options.includeWorkspaces !== false;
    const workspaceRoot = includeWorkspaces
      ? this.findWorkspaceRoot(this.cwd)
      : null;
    const workspaceRootDir = workspaceRoot?.dir || this.cwd;
    const workspaceRootJson = workspaceRoot?.packageJson || (pkgJson as PackageJsonLike);
    const needsWorkspacePackages =
      includeWorkspaces &&
      (
        workspaceRootDir === this.cwd ||
        this.hasWorkspaceProtocolDependencies(
          pkgJson as PackageJsonLike,
          !!options.includeDev,
          !!options.includeOptional
        )
      );
    const workspacePackages = needsWorkspacePackages
      ? this.collectWorkspacePackages(workspaceRootJson, workspaceRootDir)
      : new Map<string, WorkspacePackage>();

    if (workspaceRoot && workspaceRoot.dir !== this.cwd) {
      onProgress?.(`Resolved workspace root at ${workspaceRoot.dir}`);
    }

    const context: ManifestInstallContext = {
      options,
      workspacePackages,
      aggregateResolved: new Map<string, ResolvedPackage>(),
      aggregateAdded: [],
      visitedInstalls: new Set<string>(),
    };

    onProgress?.('Resolving dependencies...');

    await this.installManifestDependencies(
      pkgJson as PackageJsonLike,
      this.cwd,
      this.cwd,
      !!options.includeDev,
      context
    );

    const installAllWorkspacePackages =
      includeWorkspaces && workspacePackages.size > 0 && workspaceRootDir === this.cwd;

    if (installAllWorkspacePackages) {
      onProgress?.(`Installing workspace packages (${workspacePackages.size})...`);
      for (const workspace of workspacePackages.values()) {
        await this.installManifestDependencies(
          workspace.packageJson,
          workspace.dir,
          workspace.dir,
          !!options.includeDev,
          context
        );
      }
    }

    const dedupedAdded = [...new Set(context.aggregateAdded)];
    onProgress?.(`Installed ${context.aggregateResolved.size} packages`);

    return {
      installed: context.aggregateResolved,
      added: dedupedAdded,
    };
  }

  private async installFromPackageLock(
    lockfile: ParsedInstallLockfile,
    options: InstallOptions
  ): Promise<InstallResult> {
    const installed = new Map<string, ResolvedPackage>();
    const added = new Set<string>();

    // Ensure node_modules exists in root project
    this.vfs.mkdirSync(path.join(this.cwd, 'node_modules'), { recursive: true });

    for (const entry of lockfile.entries) {
      if (!options.includeDev && entry.dev) {
        continue;
      }
      if (!options.includeOptional && entry.optional) {
        continue;
      }

      if (entry.link) {
        if (!entry.localPath) {
          throw new Error(
            `Lockfile link entry for "${entry.name}" is missing a local path`
          );
        }
        if (!this.vfs.existsSync(entry.localPath)) {
          throw new Error(
            `Lockfile link target for "${entry.name}" does not exist: ${entry.localPath}`
          );
        }

        options.onProgress?.(`  Linking ${entry.name} from ${entry.localPath}`);
        this.removePathRecursive(entry.installPath);
        this.copyDirectoryRecursive(entry.localPath, entry.installPath);
      } else {
        let tarballUrl = entry.resolved;

        if (tarballUrl?.startsWith('file:')) {
          const localTarget = this.resolveLocalPath(this.cwd, tarballUrl.slice('file:'.length));
          this.removePathRecursive(entry.installPath);
          await this.installLocalResolvedLockEntry(localTarget, entry.installPath, entry.name);
          await this.transformInstalledPackage(entry.installPath, options);
          const manifest = this.readPackageJson(path.join(entry.installPath, 'package.json'));
          const name = manifest.name || entry.name;
          const version = manifest.version || entry.version;
          const dependencies = manifest.dependencies || {};
          let key = name;
          if (installed.has(key) && installed.get(key)!.version !== version) {
            const rel = normalizePathLike(path.relative(this.cwd, entry.installPath) || entry.installPath);
            key = `${name}@${rel}`;
          }
          installed.set(key, {
            name,
            version,
            tarballUrl,
            dependencies,
          });
          added.add(name);
          continue;
        }

        // Some lockfiles omit resolved URLs. Fallback to registry metadata by name+version.
        if (!tarballUrl || !/^https?:\/\//i.test(tarballUrl)) {
          const version = await this.registry.getPackageVersion(entry.name, entry.version);
          tarballUrl = version.dist.tarball;
        }

        options.onProgress?.(`  Downloading ${entry.name}@${entry.version}...`);
        this.removePathRecursive(entry.installPath);
        await downloadAndExtract(tarballUrl, this.vfs, entry.installPath, {
          stripComponents: 1,
          onProgress: options.onProgress,
        });
      }

      await this.transformInstalledPackage(entry.installPath, options);
      const manifest = this.readPackageJson(path.join(entry.installPath, 'package.json'));
      const name = manifest.name || entry.name;
      const version = manifest.version || entry.version;
      const dependencies = manifest.dependencies || {};
      const resolvedUrl = entry.resolved || '';

      let key = name;
      if (installed.has(key) && installed.get(key)!.version !== version) {
        const rel = normalizePathLike(path.relative(this.cwd, entry.installPath) || entry.installPath);
        key = `${name}@${rel}`;
      }

      installed.set(key, {
        name,
        version,
        tarballUrl: resolvedUrl,
        dependencies,
      });
      added.add(name);
    }

    // Keep internal lock snapshot updated for tools relying on .package-lock.json
    await this.writeLockfile(installed, this.cwd);

    return {
      installed,
      added: [...added],
    };
  }

  private readPreferredLockfile(): ParsedInstallLockfile | null {
    const npmLock = readPackageLockFile(this.vfs, this.cwd);
    if (npmLock) {
      return npmLock;
    }

    const bunLock = readBunLockFile(this.vfs, this.cwd);
    if (bunLock) {
      return bunLock;
    }

    return null;
  }

  private async installManifestDependencies(
    manifest: PackageJsonLike,
    manifestCwd: string,
    projectCwd: string,
    includeDev: boolean,
    context: ManifestInstallContext
  ): Promise<void> {
    const installKey = `${projectCwd}::${manifestCwd}::${includeDev ? 'dev' : 'prod'}`;
    if (context.visitedInstalls.has(installKey)) {
      return;
    }
    context.visitedInstalls.add(installKey);

    const deps: Record<string, string> = {
      ...(manifest.dependencies || {}),
    };
    if (includeDev && manifest.devDependencies) {
      Object.assign(deps, manifest.devDependencies);
    }

    if (Object.keys(deps).length === 0) {
      return;
    }

    const registryOnly: Record<string, string> = {};
    const nonRegistry: ParsedDependencySpec[] = [];

    for (const [depName, depSpec] of Object.entries(deps)) {
      const parsed = parseDependencySpec(depName, depSpec);
      if (parsed.protocol === 'registry') {
        registryOnly[depName] = parsed.versionRange || 'latest';
      } else {
        nonRegistry.push(parsed);
      }
    }

    if (Object.keys(registryOnly).length > 0) {
      const resolved = await resolveFromPackageJson(
        {
          dependencies: registryOnly,
        },
        {
          registry: this.registry,
          includeOptional: context.options.includeOptional,
          onProgress: context.options.onProgress,
        }
      );

      const added = await this.installResolved(resolved, context.options, projectCwd);
      context.aggregateAdded.push(...added);

      for (const [name, pkg] of resolved) {
        context.aggregateResolved.set(name, pkg);
      }
    }

    for (const dependency of nonRegistry) {
      await this.installNonRegistryDependency(
        dependency,
        manifestCwd,
        projectCwd,
        context
      );
    }
  }

  private async installNonRegistryDependency(
    dependency: ParsedDependencySpec,
    manifestCwd: string,
    projectCwd: string,
    context: ManifestInstallContext
  ): Promise<void> {
    const { options, workspacePackages } = context;
    const { name, protocol } = dependency;

    switch (protocol) {
      case 'workspace': {
        const workspace = workspacePackages.get(name);
        if (!workspace) {
          const target = dependency.target || '*';
          if (target.startsWith('.') || target.startsWith('/')) {
            const localPath = this.resolveLocalPath(manifestCwd, target);
            await this.installLocalDirectoryDependency(name, localPath, projectCwd, options);
            context.aggregateAdded.push(name);
            const localManifest = this.readPackageJson(path.join(localPath, 'package.json'));
            await this.installManifestDependencies(
              localManifest,
              localPath,
              projectCwd,
              false,
              context
            );
            return;
          }
          if (options.preferPublishedWorkspacePackages) {
            const fallbackRange = this.toRegistryRangeFromWorkspaceTarget(target);
            options.onProgress?.(
              `Workspace dependency "${name}" not found locally; trying published ${name}@${fallbackRange}`
            );
            await this.installRegistryDependency(name, fallbackRange, projectCwd, context);
            return;
          }
          throw new Error(
            `workspace dependency "${name}" was not found in configured workspaces`
          );
        }

        if (options.preferPublishedWorkspacePackages) {
          const fallbackRange = this.toRegistryRangeFromWorkspaceTarget(
            dependency.target,
            workspace.version
          );
          const shouldPreferPublished = this.shouldPreferPublishedWorkspacePackage(workspace);
          options.onProgress?.(
            shouldPreferPublished
              ? `Workspace package "${name}" has no runtime build output; using published ${name}@${fallbackRange}`
              : `Trying published workspace package ${name}@${fallbackRange} for runtime compatibility`
          );
          try {
            await this.installRegistryDependency(name, fallbackRange, projectCwd, context);
            return;
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            options.onProgress?.(
              `Warning: published fallback for "${name}" failed (${detail}); using local workspace package`
            );
          }
        }

        await this.installLocalDirectoryDependency(name, workspace.dir, projectCwd, options);
        context.aggregateAdded.push(name);
        await this.installManifestDependencies(
          workspace.packageJson,
          workspace.dir,
          projectCwd,
          false,
          context
        );
        return;
      }

      case 'npm': {
        const target = dependency.target?.trim();
        if (!target) {
          throw new Error(`npm alias dependency "${name}" is missing an alias target`);
        }

        await this.installNpmAliasDependency(name, target, projectCwd, context);
        return;
      }

      case 'file':
      case 'link': {
        const target = dependency.target;
        if (!target) {
          throw new Error(`${protocol}: dependency "${name}" is missing a target path`);
        }
        const localPath = this.resolveLocalPath(manifestCwd, target);

        if (!this.vfs.existsSync(localPath)) {
          throw new Error(`${protocol}: target "${target}" for "${name}" does not exist`);
        }

        const stat = this.vfs.statSync(localPath);
        if (stat.isDirectory()) {
          await this.installLocalDirectoryDependency(name, localPath, projectCwd, options);
          context.aggregateAdded.push(name);
          const localManifest = this.readPackageJson(path.join(localPath, 'package.json'));
          await this.installManifestDependencies(
            localManifest,
            localPath,
            projectCwd,
            false,
            context
          );
          return;
        }

        if (stat.isFile() && /\.(tgz|tar\.gz)$/i.test(localPath)) {
          const tarball = this.vfs.readFileSync(localPath) as Uint8Array;
          const packagePath = path.join(projectCwd, 'node_modules', name);
          this.removePathRecursive(packagePath);
          this.vfs.mkdirSync(path.dirname(packagePath), { recursive: true });
          extractTarball(tarball, this.vfs, packagePath, { stripComponents: 1 });
          await this.transformInstalledPackage(packagePath, options);
          context.aggregateAdded.push(name);

          const localManifest = this.readPackageJson(path.join(packagePath, 'package.json'));
          await this.installManifestDependencies(
            localManifest,
            packagePath,
            projectCwd,
            false,
            context
          );
          return;
        }

        throw new Error(
          `${protocol}: target "${target}" for "${name}" must be a directory or .tgz archive`
        );
      }

      case 'tarball': {
        const tarballUrl = dependency.target!;
        const packagePath = await this.installRemoteArchiveDependency(
          name,
          tarballUrl,
          projectCwd,
          options
        );
        context.aggregateAdded.push(name);
        const archiveManifest = this.readPackageJson(path.join(packagePath, 'package.json'));
        await this.installManifestDependencies(
          archiveManifest,
          packagePath,
          projectCwd,
          false,
          context
        );
        return;
      }

      case 'github': {
        const parsed = parseGitHubRepoUrl(dependency.target!);
        const packagePath = await this.installRemoteArchiveDependency(
          name,
          parsed.archiveUrl,
          projectCwd,
          options
        );
        context.aggregateAdded.push(name);
        const githubManifest = this.readPackageJson(path.join(packagePath, 'package.json'));
        await this.installManifestDependencies(
          githubManifest,
          packagePath,
          projectCwd,
          false,
          context
        );
        return;
      }

      case 'git': {
        throw new Error(
          `Unsupported dependency protocol for "${name}": ${dependency.rawSpec}. ` +
          'Use npm:, github:, https://...tgz, file:, link:, workspace:, or registry versions.'
        );
      }

      default: {
        throw new Error(`Unsupported dependency protocol "${protocol}" for "${name}"`);
      }
    }
  }

  private async installRegistryDependency(
    name: string,
    versionRange: string,
    projectCwd: string,
    context: ManifestInstallContext
  ): Promise<void> {
    const resolved = await resolveFromPackageJson(
      {
        dependencies: {
          [name]: versionRange,
        },
      },
      {
        registry: this.registry,
        includeOptional: context.options.includeOptional,
        onProgress: context.options.onProgress,
      }
    );

    const added = await this.installResolved(resolved, context.options, projectCwd);
    context.aggregateAdded.push(...added);
    for (const [depName, pkg] of resolved) {
      context.aggregateResolved.set(depName, pkg);
    }
  }

  private toRegistryRangeFromWorkspaceTarget(target?: string, versionHint?: string): string {
    const normalized = (target || '').trim();
    if (!normalized || normalized === '*') {
      return versionHint || 'latest';
    }

    if ((normalized === '^' || normalized === '~') && versionHint) {
      return `${normalized}${versionHint}`;
    }

    return normalized;
  }

  private shouldPreferPublishedWorkspacePackage(workspace: WorkspacePackage): boolean {
    let preferPublished = false;

    const runtimeEntries = this.getManifestEntryCandidates(workspace.packageJson, false);
    if (runtimeEntries.length > 0) {
      preferPublished = preferPublished || !this.manifestHasAnyEntryFile(workspace.dir, runtimeEntries);
    }

    const binEntries = this.getManifestBinEntryCandidates(workspace.packageJson);
    if (binEntries.length > 0) {
      if (!this.manifestHasAnyEntryFile(workspace.dir, binEntries)) {
        preferPublished = true;
      }
      if (this.hasBrokenBinRuntimeReferences(workspace.dir, binEntries)) {
        preferPublished = true;
      }
    }

    return preferPublished;
  }

  private getManifestEntryCandidates(manifest: PackageJsonLike, includeBin: boolean): string[] {
    const candidates = new Set<string>();

    if (typeof manifest.main === 'string') {
      candidates.add(manifest.main);
    }
    if (typeof manifest.module === 'string') {
      candidates.add(manifest.module);
    }
    if (includeBin) {
      for (const entry of this.getManifestBinEntryCandidates(manifest)) {
        candidates.add(entry);
      }
    }

    const walkExports = (value: unknown): void => {
      if (!value) return;
      if (typeof value === 'string') {
        candidates.add(value);
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          walkExports(item);
        }
        return;
      }
      if (typeof value === 'object') {
        for (const nested of Object.values(value as Record<string, unknown>)) {
          walkExports(nested);
        }
      }
    };

    walkExports(manifest.exports);

    return [...candidates]
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .filter((value) => !value.startsWith('#'))
      .filter((value) => !/^https?:\/\//i.test(value))
      .filter((value) => !value.includes('*'))
      .map((value) => value.startsWith('file:') ? value.slice('file:'.length) : value)
      .map((value) => value.replace(/^\.\/+/, '').replace(/^\/+/, ''))
      .filter((value) => value.length > 0);
  }

  private getManifestBinEntryCandidates(manifest: PackageJsonLike): string[] {
    const candidates = new Set<string>();
    if (typeof manifest.bin === 'string') {
      candidates.add(manifest.bin);
    } else if (manifest.bin && typeof manifest.bin === 'object') {
      for (const value of Object.values(manifest.bin)) {
        if (typeof value === 'string') {
          candidates.add(value);
        }
      }
    }

    return [...candidates]
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .map((value) => value.replace(/^\.\/+/, '').replace(/^\/+/, ''));
  }

  private manifestHasAnyEntryFile(packageDir: string, candidates: string[]): boolean {
    for (const candidate of candidates) {
      const fullPath = path.join(packageDir, candidate);
      if (this.hasResolvableFile(fullPath)) {
        return true;
      }
    }

    return false;
  }

  private hasBrokenBinRuntimeReferences(packageDir: string, binEntries: string[]): boolean {
    const refPatterns = [
      /require\((['"])(\.[^'"]+)\1\)/g,
      /import\((['"])(\.[^'"]+)\1\)/g,
      /\bfrom\s+(['"])(\.[^'"]+)\1/g,
    ];

    for (const entry of binEntries) {
      const binPath = path.join(packageDir, entry);
      if (!this.vfs.existsSync(binPath) || !this.vfs.statSync(binPath).isFile()) {
        continue;
      }

      let source = '';
      try {
        source = this.vfs.readFileSync(binPath, 'utf8');
      } catch {
        continue;
      }

      for (const pattern of refPatterns) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(source)) !== null) {
          const ref = match[2];
          if (!ref || !ref.startsWith('.')) {
            continue;
          }
          const resolvedRef = path.join(path.dirname(binPath), ref);
          if (!this.hasResolvableFile(resolvedRef)) {
            return true;
          }
        }
      }
    }

    return false;
  }

  private hasResolvableFile(basePath: string): boolean {
    const extensionCandidates = ['.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.json'];

    if (this.vfs.existsSync(basePath)) {
      const stat = this.vfs.statSync(basePath);
      if (stat.isFile()) {
        return true;
      }
      if (stat.isDirectory()) {
        if (this.vfs.existsSync(path.join(basePath, 'package.json'))) {
          return true;
        }
        for (const ext of extensionCandidates) {
          if (this.vfs.existsSync(path.join(basePath, `index${ext}`))) {
            return true;
          }
        }
      }
    }

    for (const ext of extensionCandidates) {
      if (this.vfs.existsSync(`${basePath}${ext}`)) {
        return true;
      }
    }

    return false;
  }

  private resolveLocalPath(baseDir: string, target: string): string {
    const normalized = normalizePathLike(target.trim());
    if (!normalized) {
      return baseDir;
    }
    return normalized.startsWith('/')
      ? normalized
      : path.join(baseDir, normalized);
  }

  private async installLocalDirectoryDependency(
    dependencyName: string,
    sourceDir: string,
    projectCwd: string,
    options: InstallOptions
  ): Promise<string> {
    const packagePath = path.join(projectCwd, 'node_modules', dependencyName);
    this.removePathRecursive(packagePath);
    this.copyDirectoryRecursive(sourceDir, packagePath);
    await this.transformInstalledPackage(packagePath, options);
    return packagePath;
  }

  private async installNpmAliasDependency(
    aliasName: string,
    aliasTarget: string,
    projectCwd: string,
    context: ManifestInstallContext
  ): Promise<void> {
    const { options } = context;
    const parsedTarget = parsePackageSpec(aliasTarget);
    const targetName = parsedTarget.name;
    const targetRange = parsedTarget.version || 'latest';

    if (!targetName) {
      throw new Error(`npm alias dependency "${aliasName}" has an invalid target: "${aliasTarget}"`);
    }

    const resolved = await resolveDependencies(targetName, targetRange, {
      registry: this.registry,
      includeOptional: options.includeOptional,
      onProgress: options.onProgress,
    });

    const added = await this.installResolved(resolved, options, projectCwd);
    context.aggregateAdded.push(...added);
    for (const [resolvedName, pkg] of resolved) {
      context.aggregateResolved.set(resolvedName, pkg);
    }

    const targetPkg = resolved.get(targetName);
    if (!targetPkg) {
      throw new Error(
        `npm alias target "${targetName}" for "${aliasName}" was not resolved`
      );
    }

    if (aliasName === targetName) {
      return;
    }

    const sourcePath = path.join(projectCwd, 'node_modules', targetName);
    const aliasPath = path.join(projectCwd, 'node_modules', aliasName);
    this.removePathRecursive(aliasPath);
    this.copyDirectoryRecursive(sourcePath, aliasPath);
    context.aggregateAdded.push(aliasName);
    context.aggregateResolved.set(aliasName, {
      ...targetPkg,
      name: aliasName,
    });
  }

  private async installLocalResolvedLockEntry(
    localTargetPath: string,
    installPath: string,
    packageName: string
  ): Promise<void> {
    if (!this.vfs.existsSync(localTargetPath)) {
      throw new Error(
        `Lockfile local file target for "${packageName}" does not exist: ${localTargetPath}`
      );
    }

    const targetStat = this.vfs.statSync(localTargetPath);
    if (targetStat.isDirectory()) {
      this.copyDirectoryRecursive(localTargetPath, installPath);
      return;
    }

    if (targetStat.isFile()) {
      if (!/\.(?:tgz|tar\.gz)$/i.test(localTargetPath)) {
        throw new Error(
          `Lockfile local file target for "${packageName}" must be a directory or .tgz archive`
        );
      }
      const tarball = this.vfs.readFileSync(localTargetPath) as Uint8Array;
      this.vfs.mkdirSync(path.dirname(installPath), { recursive: true });
      extractTarball(tarball, this.vfs, installPath, { stripComponents: 1 });
      return;
    }

    throw new Error(
      `Lockfile local file target for "${packageName}" is not a regular file or directory`
    );
  }

  private async installRemoteArchiveDependency(
    dependencyName: string,
    archiveUrl: string,
    projectCwd: string,
    options: InstallOptions
  ): Promise<string> {
    const packagePath = path.join(projectCwd, 'node_modules', dependencyName);
    this.removePathRecursive(packagePath);
    await downloadAndExtract(archiveUrl, this.vfs, packagePath, {
      stripComponents: 1,
      onProgress: options.onProgress,
    });
    await this.transformInstalledPackage(packagePath, options);
    return packagePath;
  }

  private async transformInstalledPackage(
    packagePath: string,
    options: InstallOptions
  ): Promise<void> {
    const shouldTransform = options.transform !== false;
    if (!shouldTransform) {
      return;
    }

    if (!isTransformerReady()) {
      options.onProgress?.('Initializing ESM transformer...');
      await initTransformer();
    }

    try {
      const count = await transformPackage(this.vfs, packagePath, options.onProgress);
      if (count > 0) {
        options.onProgress?.(`  Transformed ${count} files in ${packagePath}`);
      }
    } catch (transformError) {
      options.onProgress?.(`  Warning: Transform failed for ${packagePath}: ${transformError}`);
    }
  }

  private copyDirectoryRecursive(source: string, destination: string): void {
    if (!this.vfs.existsSync(source)) {
      throw new Error(`Source directory does not exist: ${source}`);
    }

    const sourceStats = this.vfs.statSync(source);
    if (!sourceStats.isDirectory()) {
      throw new Error(`Source path is not a directory: ${source}`);
    }

    this.vfs.mkdirSync(destination, { recursive: true });
    const entries = this.vfs.readdirSync(source);

    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git') {
        continue;
      }

      const sourceEntry = path.join(source, entry);
      const destinationEntry = path.join(destination, entry);
      const stat = this.vfs.statSync(sourceEntry);

      if (stat.isDirectory()) {
        this.copyDirectoryRecursive(sourceEntry, destinationEntry);
        continue;
      }

      const content = this.vfs.readFileSync(sourceEntry) as Uint8Array;
      this.vfs.mkdirSync(path.dirname(destinationEntry), { recursive: true });
      this.vfs.writeFileSync(destinationEntry, content);
    }
  }

  private removePathRecursive(targetPath: string): void {
    if (!this.vfs.existsSync(targetPath)) {
      return;
    }

    const stat = this.vfs.statSync(targetPath);
    if (stat.isDirectory()) {
      for (const entry of this.vfs.readdirSync(targetPath)) {
        this.removePathRecursive(path.join(targetPath, entry));
      }
      this.vfs.rmdirSync(targetPath);
      return;
    }

    this.vfs.unlinkSync(targetPath);
  }

  private readPackageJson(filePath: string): PackageJsonLike {
    if (!this.vfs.existsSync(filePath)) {
      throw new Error(`Missing package.json at ${filePath}`);
    }

    const content = this.vfs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`Invalid package.json at ${filePath}`);
    }
    return parsed as PackageJsonLike;
  }

  private collectWorkspacePackages(
    rootPackageJson: PackageJsonLike,
    workspaceRootDir: string = this.cwd
  ): Map<string, WorkspacePackage> {
    const patterns = [
      ...this.getWorkspacePatterns(rootPackageJson),
      ...this.getPnpmWorkspacePatterns(workspaceRootDir),
    ];
    if (patterns.length === 0) {
      return new Map();
    }

    const packageDirs = this.resolveWorkspaceDirectories(patterns, workspaceRootDir);
    const workspaces = new Map<string, WorkspacePackage>();

    for (const dir of packageDirs) {
      const pkgJsonPath = path.join(dir, 'package.json');
      if (!this.vfs.existsSync(pkgJsonPath)) {
        continue;
      }

      const workspaceJson = this.readPackageJson(pkgJsonPath);
      const workspaceName = workspaceJson.name;
      if (!workspaceName) {
        continue;
      }

      if (workspaces.has(workspaceName)) {
        continue;
      }

      workspaces.set(workspaceName, {
        name: workspaceName,
        version: workspaceJson.version || '0.0.0',
        dir,
        packageJson: workspaceJson,
      });
    }

    return workspaces;
  }

  private hasWorkspaceProtocolDependencies(
    pkg: PackageJsonLike,
    includeDev: boolean,
    includeOptional: boolean
  ): boolean {
    const groups: Array<Record<string, string> | undefined> = [
      pkg.dependencies,
      includeDev ? pkg.devDependencies : undefined,
      includeOptional ? pkg.optionalDependencies : undefined,
    ];

    for (const group of groups) {
      if (!group) continue;
      for (const spec of Object.values(group)) {
        if (typeof spec === 'string' && spec.trim().startsWith('workspace:')) {
          return true;
        }
      }
    }

    return false;
  }

  private getWorkspacePatterns(rootPackageJson: PackageJsonLike): string[] {
    const workspaces = rootPackageJson.workspaces;
    if (!workspaces) {
      return [];
    }

    if (Array.isArray(workspaces)) {
      return workspaces.filter((item): item is string => typeof item === 'string');
    }

    if (workspaces && typeof workspaces === 'object' && Array.isArray(workspaces.packages)) {
      return workspaces.packages.filter((item): item is string => typeof item === 'string');
    }

    return [];
  }

  private resolveWorkspaceDirectories(patterns: string[], workspaceRootDir: string = this.cwd): string[] {
    const matches = new Set<string>();

    for (const rawPattern of patterns) {
      const pattern = normalizePathLike(rawPattern.trim())
        .replace(/^\.\//, '')
        .replace(/\/+$/, '');
      if (!pattern) {
        continue;
      }

      if (!pattern.includes('*')) {
        const direct = path.join(workspaceRootDir, pattern);
        if (this.vfs.existsSync(path.join(direct, 'package.json'))) {
          matches.add(direct);
        }
        continue;
      }

      const wildcardIndex = pattern.indexOf('*');
      const searchBaseRel = pattern.slice(0, wildcardIndex).replace(/\/+$/, '');
      const searchBase = path.join(workspaceRootDir, searchBaseRel || '.');
      if (!this.vfs.existsSync(searchBase) || !this.vfs.statSync(searchBase).isDirectory()) {
        continue;
      }

      const matcher = globToRegExp(pattern);
      const dirsToVisit: string[] = [searchBase];
      while (dirsToVisit.length > 0) {
        const current = dirsToVisit.pop()!;
        const rel = normalizePathLike(path.relative(workspaceRootDir, current)).replace(/^\.\//, '');
        if (rel && matcher.test(rel) && this.vfs.existsSync(path.join(current, 'package.json'))) {
          matches.add(current);
        }

        for (const entry of this.vfs.readdirSync(current)) {
          if (entry === 'node_modules' || entry === '.git') {
            continue;
          }

          const child = path.join(current, entry);
          if (this.vfs.statSync(child).isDirectory()) {
            dirsToVisit.push(child);
          }
        }
      }
    }

    return [...matches];
  }

  private getPnpmWorkspacePatterns(workspaceRootDir: string): string[] {
    const filePath = path.join(workspaceRootDir, 'pnpm-workspace.yaml');
    if (!this.vfs.existsSync(filePath)) {
      return [];
    }

    const content = this.vfs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    const patterns: string[] = [];
    let inPackages = false;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) {
        continue;
      }

      if (/^packages\s*:/.test(line)) {
        inPackages = true;
        continue;
      }

      if (!inPackages) {
        continue;
      }

      if (/^[a-zA-Z0-9_-]+\s*:/.test(line)) {
        inPackages = false;
        continue;
      }

      const itemMatch = line.match(/^-\s*(.+)$/);
      if (!itemMatch) {
        continue;
      }

      const value = itemMatch[1]
        .trim()
        .replace(/^['"]/, '')
        .replace(/['"]$/, '');
      if (value) {
        patterns.push(value);
      }
    }

    return patterns;
  }

  private findWorkspaceRoot(startDir: string): { dir: string; packageJson: PackageJsonLike } | null {
    let current = startDir;

    while (true) {
      const pkgPath = path.join(current, 'package.json');
      const pkgJson = this.vfs.existsSync(pkgPath)
        ? this.readPackageJson(pkgPath)
        : {} as PackageJsonLike;
      const patterns = [
        ...this.getWorkspacePatterns(pkgJson),
        ...this.getPnpmWorkspacePatterns(current),
      ];

      if (patterns.length > 0) {
        const workspaceDirs = this.resolveWorkspaceDirectories(patterns, current);
        const matchesCurrentProject = workspaceDirs.some((dir) =>
          startDir === dir || startDir.startsWith(`${dir}/`)
        );
        if (matchesCurrentProject || current === startDir) {
          return { dir: current, packageJson: pkgJson };
        }
      }

      if (current === '/') {
        break;
      }
      const parent = path.dirname(current);
      if (!parent || parent === current) {
        break;
      }
      current = parent;
    }

    return null;
  }

  /**
   * Install resolved packages to node_modules
   */
  private async installResolved(
    resolved: Map<string, ResolvedPackage>,
    options: InstallOptions,
    installCwd: string = this.cwd
  ): Promise<string[]> {
    const { onProgress } = options;
    const added: string[] = [];

    // Ensure node_modules exists
    const nodeModulesPath = path.join(installCwd, 'node_modules');
    this.vfs.mkdirSync(nodeModulesPath, { recursive: true });

    // Filter packages that need to be installed
    const toInstall: Array<{ name: string; pkg: ResolvedPackage; pkgPath: string }> = [];

    for (const [name, pkg] of resolved) {
      const pkgPath = path.join(nodeModulesPath, name);

      // Skip if already installed with same version
      const existingPkgJson = path.join(pkgPath, 'package.json');
      if (this.vfs.existsSync(existingPkgJson)) {
        try {
          const existing = JSON.parse(
            this.vfs.readFileSync(existingPkgJson, 'utf8')
          );
          if (existing.version === pkg.version) {
            onProgress?.(`Skipping ${name}@${pkg.version} (already installed)`);
            continue;
          }
        } catch {
          // Continue with installation if package.json is invalid
        }
      }

      toInstall.push({ name, pkg, pkgPath });
    }

    // Initialize transformer if transform option is enabled (default: true)
    const shouldTransform = options.transform !== false;
    if (shouldTransform && !isTransformerReady()) {
      onProgress?.('Initializing ESM transformer...');
      await initTransformer();
    }

    // Install packages in parallel (limit concurrency to avoid overwhelming the browser)
    const CONCURRENCY = 6;
    onProgress?.(`Installing ${toInstall.length} packages...`);

    for (let i = 0; i < toInstall.length; i += CONCURRENCY) {
      const batch = toInstall.slice(i, i + CONCURRENCY);

      await Promise.all(
        batch.map(async ({ name, pkg, pkgPath }) => {
          onProgress?.(`  Downloading ${name}@${pkg.version}...`);

          // Download and extract tarball
          await downloadAndExtract(pkg.tarballUrl, this.vfs, pkgPath, {
            stripComponents: 1, // Strip "package/" prefix
          });

          // Transform ESM to CJS
          if (shouldTransform) {
            try {
              const count = await transformPackage(this.vfs, pkgPath, onProgress);
              if (count > 0) {
                onProgress?.(`  Transformed ${count} files in ${name}`);
              }
            } catch (transformError) {
              onProgress?.(`  Warning: Transform failed for ${name}: ${transformError}`);
            }
          }

          // Create bin stubs in /node_modules/.bin/
          try {
            const pkgJsonPath = path.join(pkgPath, 'package.json');
            if (this.vfs.existsSync(pkgJsonPath)) {
              const pkgJson = JSON.parse(this.vfs.readFileSync(pkgJsonPath, 'utf8'));
              const binEntries = normalizeBin(name, pkgJson.bin);
              const binDir = path.join(nodeModulesPath, '.bin');
              for (const [cmdName, entryPath] of Object.entries(binEntries)) {
                this.vfs.mkdirSync(binDir, { recursive: true });
                const targetPath = path.join(pkgPath, entryPath);
                this.vfs.writeFileSync(
                  path.join(binDir, cmdName),
                  `node "${targetPath}" "$@"\n`
                );
              }
            }
          } catch {
            // Non-critical — skip if bin stub creation fails
          }

          added.push(name);
        })
      );
    }

    // Create .package-lock.json for tracking
    await this.writeLockfile(resolved, installCwd);

    return added;
  }

  /**
   * Write lockfile with resolved versions
   */
  private async writeLockfile(
    resolved: Map<string, ResolvedPackage>,
    cwd: string
  ): Promise<void> {
    const lockfile: Record<string, { version: string; resolved: string }> = {};

    for (const [name, pkg] of resolved) {
      lockfile[name] = {
        version: pkg.version,
        resolved: pkg.tarballUrl,
      };
    }

    const lockfilePath = path.join(cwd, 'node_modules', '.package-lock.json');
    this.vfs.writeFileSync(lockfilePath, JSON.stringify(lockfile, null, 2));
  }

  /**
   * Update package.json with new dependency
   */
  private async updatePackageJson(
    packageName: string,
    version: string,
    isDev: boolean
  ): Promise<void> {
    const pkgJsonPath = path.join(this.cwd, 'package.json');

    let pkgJson: Record<string, unknown> = {};

    if (this.vfs.existsSync(pkgJsonPath)) {
      pkgJson = JSON.parse(this.vfs.readFileSync(pkgJsonPath, 'utf8'));
    }

    const field = isDev ? 'devDependencies' : 'dependencies';

    if (!pkgJson[field]) {
      pkgJson[field] = {};
    }

    (pkgJson[field] as Record<string, string>)[packageName] = version;

    this.vfs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2));
  }

  /**
   * List installed packages
   */
  list(): Record<string, string> {
    const nodeModulesPath = path.join(this.cwd, 'node_modules');

    if (!this.vfs.existsSync(nodeModulesPath)) {
      return {};
    }

    const packages: Record<string, string> = {};
    const entries = this.vfs.readdirSync(nodeModulesPath);

    for (const entry of entries) {
      // Skip hidden files and non-package entries
      if (entry.startsWith('.')) continue;

      // Handle scoped packages (@org/pkg)
      if (entry.startsWith('@')) {
        const scopePath = path.join(nodeModulesPath, entry);
        const scopedPkgs = this.vfs.readdirSync(scopePath);

        for (const scopedPkg of scopedPkgs) {
          const pkgJsonPath = path.join(scopePath, scopedPkg, 'package.json');
          if (this.vfs.existsSync(pkgJsonPath)) {
            const pkgJson = JSON.parse(this.vfs.readFileSync(pkgJsonPath, 'utf8'));
            packages[`${entry}/${scopedPkg}`] = pkgJson.version;
          }
        }
      } else {
        const pkgJsonPath = path.join(nodeModulesPath, entry, 'package.json');
        if (this.vfs.existsSync(pkgJsonPath)) {
          const pkgJson = JSON.parse(this.vfs.readFileSync(pkgJsonPath, 'utf8'));
          packages[entry] = pkgJson.version;
        }
      }
    }

    return packages;
  }
}

/**
 * Parse a package specifier into name and version
 * Examples: "express", "express@4.18.2", "@types/node@18"
 */
function parsePackageSpec(spec: string): { name: string; version?: string } {
  // Handle scoped packages
  if (spec.startsWith('@')) {
    const slashIndex = spec.indexOf('/');
    if (slashIndex === -1) {
      throw new Error(`Invalid package spec: ${spec}`);
    }

    const afterSlash = spec.slice(slashIndex + 1);
    const atIndex = afterSlash.indexOf('@');

    if (atIndex === -1) {
      return { name: spec };
    }

    return {
      name: spec.slice(0, slashIndex + 1 + atIndex),
      version: afterSlash.slice(atIndex + 1),
    };
  }

  // Regular packages
  const atIndex = spec.indexOf('@');
  if (atIndex === -1) {
    return { name: spec };
  }

  return {
    name: spec.slice(0, atIndex),
    version: spec.slice(atIndex + 1),
  };
}

// Convenience function for quick installs
export async function install(
  packageSpec: string,
  vfs: VirtualFS,
  options?: InstallOptions
): Promise<InstallResult> {
  const pm = new PackageManager(vfs);
  return pm.install(packageSpec, options);
}

// Re-export types and modules
export { Registry } from './registry';
export type { RegistryOptions, PackageVersion, PackageManifest } from './registry';
export type { ResolvedPackage, ResolveOptions } from './resolver';
export type { ExtractOptions } from './tarball';
export type { ParsedPackageLock, PackageLockInstallEntry } from './package-lock';
export { parsePackageLockObject, readPackageLockFile } from './package-lock';
export type { ParsedBunLock } from './bun-lock';
export { parseBunLockObject, readBunLockFile } from './bun-lock';
export { parsePackageSpec };
