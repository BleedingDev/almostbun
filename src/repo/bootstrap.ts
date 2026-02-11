import { VirtualFS } from '../virtual-fs';
import { PackageManager, InstallOptions, InstallResult } from '../npm';
import {
  importGitHubRepo,
  ImportGitHubRepoOptions,
  ImportGitHubRepoResult,
} from './github';
import { initTransformer, isTransformerReady, transformPackage } from '../transform';
import {
  readBootstrapProjectSnapshotCache,
  writeBootstrapProjectSnapshotCache,
} from './project-snapshot-cache';
import type { ProjectSnapshotCacheMode } from './project-snapshot-cache';

export interface BootstrapGitHubProjectOptions
  extends ImportGitHubRepoOptions,
    Omit<InstallOptions, 'save' | 'saveDev' | 'registry'> {
  /**
   * Skip dependency installation and only import the repository.
   * Default: false
   */
  skipInstall?: boolean;
  /**
   * Transform project source files (including TypeScript) to CJS after install.
   * This improves runtime compatibility for source-based apps.
   * Default: true
   */
  transformProjectSources?: boolean;
  /**
   * Enable project snapshot cache (memory + persistent where available).
   * Default: true
   */
  enableProjectSnapshotCache?: boolean;
  /**
   * Snapshot cache mode.
   * - default: read + write
   * - refresh: skip read, write fresh snapshot
   * - bypass: skip read + write
   * Default: 'default'
   */
  projectSnapshotCacheMode?: ProjectSnapshotCacheMode;
  /**
   * Snapshot cache TTL in milliseconds.
   * Default: 30 minutes
   */
  projectSnapshotCacheTtlMs?: number;
  /**
   * Snapshot cache max entries.
   * Default: 12
   */
  projectSnapshotCacheMaxEntries?: number;
  /**
   * Snapshot cache max total bytes.
   * Default: 768 MiB
   */
  projectSnapshotCacheMaxBytes?: number;
  /**
   * Snapshot cache max per-entry bytes.
   * Default: 256 MiB
   */
  projectSnapshotCacheMaxEntryBytes?: number;
}

export interface BootstrapGitHubProjectResult extends ImportGitHubRepoResult {
  installResult?: InstallResult;
  transformedProjectFiles?: number;
}

/**
 * High-level "URL -> ready project" helper:
 * 1) Imports a GitHub repo archive into VFS
 * 2) Installs dependencies from package.json at detected project path
 */
export async function bootstrapGitHubProject(
  vfs: VirtualFS,
  repoUrl: string,
  options: BootstrapGitHubProjectOptions = {}
): Promise<BootstrapGitHubProjectResult> {
  const cached = await readBootstrapProjectSnapshotCache(vfs, repoUrl, options);
  if (cached) {
    options.onProgress?.(`Restored project from snapshot cache (${cached.source})`);
    return cached.result;
  }

  const importResult = await importGitHubRepo(vfs, repoUrl, {
    destPath: options.destPath,
    onProgress: options.onProgress,
  });

  let finalResult: BootstrapGitHubProjectResult;

  if (options.skipInstall) {
    finalResult = importResult;
  } else {
    const packageJsonPath = `${importResult.projectPath}/package.json`.replace(/\/+/g, '/');
    if (!vfs.existsSync(packageJsonPath)) {
      finalResult = importResult;
    } else {
      const manager = new PackageManager(vfs, { cwd: importResult.projectPath });
      const installResult = await manager.installFromPackageJson({
        includeDev: options.includeDev,
        includeOptional: options.includeOptional,
        includeWorkspaces: options.includeWorkspaces,
        preferPublishedWorkspacePackages: options.preferPublishedWorkspacePackages,
        onProgress: options.onProgress,
        transform: options.transform,
      });

      let transformedProjectFiles = 0;
      const shouldTransformProjectSources =
        options.transformProjectSources !== false && options.transform !== false;

      if (shouldTransformProjectSources) {
        try {
          if (!isTransformerReady()) {
            options.onProgress?.('Initializing source transformer...');
            await initTransformer();
          }
          transformedProjectFiles = await transformPackage(
            vfs,
            importResult.projectPath,
            options.onProgress
          );
          if (transformedProjectFiles > 0) {
            options.onProgress?.(`Transformed ${transformedProjectFiles} project source files`);
          }
        } catch (error) {
          options.onProgress?.(`Warning: project source transform failed: ${error}`);
        }
      }

      finalResult = {
        ...importResult,
        installResult,
        transformedProjectFiles,
      };
    }
  }

  try {
    const persisted = await writeBootstrapProjectSnapshotCache(
      vfs,
      repoUrl,
      options,
      finalResult
    );
    if (persisted) {
      options.onProgress?.('Saved project snapshot cache');
    }
  } catch (error) {
    options.onProgress?.(`Warning: project snapshot cache write failed: ${error}`);
  }

  return finalResult;
}
