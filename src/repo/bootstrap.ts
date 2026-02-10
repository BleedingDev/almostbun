import { VirtualFS } from '../virtual-fs';
import { PackageManager, InstallOptions, InstallResult } from '../npm';
import {
  importGitHubRepo,
  ImportGitHubRepoOptions,
  ImportGitHubRepoResult,
} from './github';
import { initTransformer, isTransformerReady, transformPackage } from '../transform';

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
  const importResult = await importGitHubRepo(vfs, repoUrl, {
    destPath: options.destPath,
    onProgress: options.onProgress,
  });

  if (options.skipInstall) {
    return importResult;
  }

  const packageJsonPath = `${importResult.projectPath}/package.json`.replace(/\/+/g, '/');
  if (!vfs.existsSync(packageJsonPath)) {
    return importResult;
  }

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

  return {
    ...importResult,
    installResult,
    transformedProjectFiles,
  };
}
