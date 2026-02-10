/**
 * GitHub repository import helpers.
 *
 * These helpers download repository archives and extract them into VirtualFS,
 * enabling "paste URL -> run in browser" workflows without a local git binary.
 */

import * as path from '../shims/path';
import { VirtualFS } from '../virtual-fs';
import { extractTarball } from '../npm/tarball';
import { fetchWithRetry } from '../npm/fetch';

export interface ParsedGitHubRepoUrl {
  owner: string;
  repo: string;
  ref: string;
  subdir?: string;
  sourceUrl: string;
  archiveUrl: string;
}

export interface ImportGitHubRepoOptions {
  /**
   * Destination directory in VFS.
   * Default: /project
   */
  destPath?: string;
  onProgress?: (message: string) => void;
}

export interface ImportGitHubRepoResult {
  repo: ParsedGitHubRepoUrl;
  rootPath: string;
  projectPath: string;
  extractedFiles: string[];
}

function normalizePathLike(value: string): string {
  return value.replace(/\\/g, '/');
}

function parseGitHubShorthand(input: string): ParsedGitHubRepoUrl | null {
  if (!input.startsWith('github:')) {
    return null;
  }

  const rest = input.slice('github:'.length).trim();
  if (!rest) {
    throw new Error(`Invalid GitHub shorthand: ${input}`);
  }

  const [repoPartRaw, hashRaw] = rest.split('#', 2);
  const repoPart = repoPartRaw.trim();
  const hash = hashRaw?.trim();
  const segments = repoPart.split('/').filter(Boolean);
  if (segments.length < 2) {
    throw new Error(`Invalid GitHub shorthand: ${input}`);
  }

  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, '');
  const ref = hash || 'HEAD';

  return {
    owner,
    repo,
    ref,
    sourceUrl: `https://github.com/${owner}/${repo}`,
    archiveUrl: `https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeURIComponent(ref)}`,
  };
}

function isBrowserRuntime(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function getBrowserCorsProxyCandidates(): string[] {
  if (!isBrowserRuntime()) {
    return [];
  }

  const candidates: string[] = [];
  try {
    if (typeof location !== 'undefined' && location.origin) {
      candidates.push(`${location.origin}/__proxy__?url=`);
    }
  } catch {
    // Ignore location access errors
  }

  try {
    const localOverride = localStorage.getItem('__corsProxyUrl');
    if (localOverride) {
      candidates.push(localOverride);
    }
  } catch {
    // Ignore storage access errors
  }

  // Default public proxies for "no-backend" browser workflows.
  candidates.push('https://cors.isomorphic-git.org/');
  candidates.push('https://corsproxy.io/?');

  return [...new Set(candidates)];
}

function buildProxyUrl(proxyBase: string, targetUrl: string): string {
  if (proxyBase.includes('{url}')) {
    return proxyBase.replace('{url}', encodeURIComponent(targetUrl));
  }
  return `${proxyBase}${encodeURIComponent(targetUrl)}`;
}

function formatRetryReason(reason: string): string {
  const normalized = reason.trim();
  if (!normalized) {
    return 'transient network issue';
  }
  return normalized.replace(/failed to fetch/gi, 'network request blocked');
}

interface GitHubTreeResponse {
  tree?: Array<{
    path?: string;
    type?: string;
  }>;
  truncated?: boolean;
}

interface GitHubContentsResponse {
  content?: string;
  encoding?: string;
  download_url?: string;
}

function decodeBase64ToBytes(content: string): Uint8Array {
  const normalized = content.replace(/\s+/g, '');
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function fetchRawFileWithFallback(
  rawUrl: string,
  relativePath: string,
  options: ImportGitHubRepoOptions
): Promise<Response> {
  let response: Response | null = null;
  let directError: unknown;

  try {
    response = await fetchWithRetry(rawUrl, undefined, {
      onRetry: (attempt, reason) => {
        options.onProgress?.(
          `Retrying raw file download (${relativePath}) [${attempt}] due to ${formatRetryReason(reason)}`
        );
      },
    });
    if (response.ok) {
      return response;
    }
  } catch (error) {
    directError = error;
  }

  if (isBrowserRuntime()) {
    const proxyCandidates = getBrowserCorsProxyCandidates();
    for (const proxyBase of proxyCandidates) {
      const proxiedUrl = buildProxyUrl(proxyBase, rawUrl);
      options.onProgress?.(`Retrying file via CORS proxy (${relativePath}): ${proxyBase}`);
      try {
        const proxiedResponse = await fetchWithRetry(proxiedUrl);
        if (proxiedResponse.ok) {
          return proxiedResponse;
        }
        response = proxiedResponse;
      } catch (error) {
        directError ??= error;
      }
    }
  }

  if (response) {
    return response;
  }

  throw directError instanceof Error
    ? directError
    : new Error(`Failed to fetch ${rawUrl}`);
}

async function fetchFileViaContentsApi(
  repo: ParsedGitHubRepoUrl,
  encodedPath: string,
  relativePath: string,
  options: ImportGitHubRepoOptions
): Promise<Uint8Array | null> {
  const contentsUrl =
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${encodedPath}?ref=${encodeURIComponent(repo.ref)}`;

  let contentsResponse: Response;
  try {
    contentsResponse = await fetchWithRetry(contentsUrl);
  } catch {
    return null;
  }

  if (!contentsResponse.ok) {
    return null;
  }

  let payload: GitHubContentsResponse;
  try {
    payload = await contentsResponse.json() as GitHubContentsResponse;
  } catch {
    return null;
  }

  if (payload.encoding === 'base64' && typeof payload.content === 'string') {
    return decodeBase64ToBytes(payload.content);
  }

  if (payload.download_url) {
    try {
      const fallbackRawResponse = await fetchRawFileWithFallback(payload.download_url, relativePath, options);
      if (fallbackRawResponse.ok) {
        return new Uint8Array(await fallbackRawResponse.arrayBuffer());
      }
    } catch {
      // ignore and return null below
    }
  }

  return null;
}

async function importGitHubRepoViaApi(
  vfs: VirtualFS,
  repo: ParsedGitHubRepoUrl,
  destPath: string,
  options: ImportGitHubRepoOptions
): Promise<string[]> {
  const treeUrl =
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/git/trees/${encodeURIComponent(repo.ref)}?recursive=1`;
  options.onProgress?.('Archive download unavailable, using GitHub API fallback...');
  const treeResponse = await fetchWithRetry(treeUrl);
  if (!treeResponse.ok) {
    throw new Error(`GitHub API tree fetch failed: ${treeResponse.status}`);
  }

  const treeJson = await treeResponse.json() as GitHubTreeResponse;
  const allBlobs = (treeJson.tree || []).filter(
    (entry): entry is { path: string; type: string } =>
      Boolean(entry.path && entry.type === 'blob')
  );

  const subdirPrefix = repo.subdir
    ? normalizePathLike(repo.subdir).replace(/^\/+|\/+$/g, '')
    : null;

  const selectedBlobs = subdirPrefix
    ? allBlobs.filter((entry) => entry.path === subdirPrefix || entry.path.startsWith(`${subdirPrefix}/`))
    : allBlobs;

  if (selectedBlobs.length === 0) {
    throw new Error(`GitHub API fallback found no files for ${repo.owner}/${repo.repo}@${repo.ref}`);
  }

  if (treeJson.truncated) {
    options.onProgress?.('Warning: GitHub tree response is truncated; large repository may be incomplete.');
  }

  const extractedFiles: string[] = [];
  const encodedRef = repo.ref
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
  for (let i = 0; i < selectedBlobs.length; i++) {
    const entry = selectedBlobs[i];
    const relativePath = normalizePathLike(entry.path).replace(/^\/+/, '');
    if (!relativePath || relativePath.includes('..')) {
      continue;
    }

    const encodedPath = relativePath
      .split('/')
      .map(segment => encodeURIComponent(segment))
      .join('/');
    const rawUrl = `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${encodedRef}/${encodedPath}`;

    const filePath = path.join(destPath, relativePath);
    const dirPath = path.dirname(filePath);
    vfs.mkdirSync(dirPath, { recursive: true });

    let rawBytes: Uint8Array | null = null;
    let rawFailure: unknown;
    let rawStatus: number | null = null;

    try {
      const rawResponse = await fetchRawFileWithFallback(rawUrl, relativePath, options);
      rawStatus = rawResponse.status;
      if (rawResponse.ok) {
        rawBytes = new Uint8Array(await rawResponse.arrayBuffer());
      }
    } catch (error) {
      rawFailure = error;
    }

    if (!rawBytes) {
      const apiBytes = await fetchFileViaContentsApi(repo, encodedPath, relativePath, options);
      if (apiBytes) {
        rawBytes = apiBytes;
      }
    }

    if (!rawBytes) {
      const detail = rawFailure instanceof Error
        ? rawFailure.message
        : (rawStatus ? `HTTP ${rawStatus}` : 'unknown fetch error');
      throw new Error(`GitHub raw file fetch failed (${relativePath}): ${detail}`);
    }

    vfs.writeFileSync(filePath, rawBytes);
    extractedFiles.push(filePath);

    if (i % 25 === 0 || i === selectedBlobs.length - 1) {
      options.onProgress?.(`Imported ${i + 1}/${selectedBlobs.length} files from GitHub API`);
    }
  }

  return extractedFiles;
}

/**
 * Parse a GitHub URL into owner/repo/ref/subdir data.
 *
 * Supported examples:
 * - https://github.com/owner/repo
 * - https://github.com/owner/repo.git
 * - https://github.com/owner/repo/tree/main
 * - https://github.com/owner/repo/tree/main/examples/demo
 * - git+https://github.com/owner/repo.git#main
 * - github:owner/repo#main
 */
export function parseGitHubRepoUrl(input: string): ParsedGitHubRepoUrl {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('GitHub URL is empty');
  }

  const shorthand = parseGitHubShorthand(trimmed);
  if (shorthand) {
    return shorthand;
  }

  const normalizedInput = trimmed.startsWith('git+')
    ? trimmed.slice('git+'.length)
    : trimmed;

  let url: URL;
  try {
    url = new URL(normalizedInput);
  } catch {
    throw new Error(`Invalid GitHub URL: ${input}`);
  }

  const host = url.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') {
    throw new Error(`Unsupported host: ${url.hostname}. Only github.com is supported`);
  }

  const pathSegments = normalizePathLike(url.pathname)
    .split('/')
    .filter(Boolean);
  if (pathSegments.length < 2) {
    throw new Error(`Invalid GitHub repository URL: ${input}`);
  }

  const owner = pathSegments[0];
  const repo = pathSegments[1].replace(/\.git$/i, '');

  let ref = url.hash ? decodeURIComponent(url.hash.slice(1)) : 'HEAD';
  let subdir: string | undefined;

  if (pathSegments[2] === 'tree' && pathSegments[3]) {
    ref = decodeURIComponent(pathSegments[3]);
    if (pathSegments.length > 4) {
      subdir = pathSegments.slice(4).map(decodeURIComponent).join('/');
    }
  }

  return {
    owner,
    repo,
    ref,
    subdir,
    sourceUrl: `https://github.com/${owner}/${repo}`,
    archiveUrl: `https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeURIComponent(ref)}`,
  };
}

/**
 * Import a GitHub repository archive into VirtualFS.
 *
 * Uses GitHub's codeload tarball endpoint and extracts into `destPath`.
 * The top-level archive folder is stripped, so files land directly under destPath.
 */
export async function importGitHubRepo(
  vfs: VirtualFS,
  repoUrl: string,
  options: ImportGitHubRepoOptions = {}
): Promise<ImportGitHubRepoResult> {
  const repo = parseGitHubRepoUrl(repoUrl);
  const destPath = options.destPath || '/project';
  const projectPath = repo.subdir ? path.join(destPath, repo.subdir) : destPath;

  const fetchArchive = async (archiveUrl: string): Promise<Response> => {
    return fetchWithRetry(
      archiveUrl,
      undefined,
      {
        onRetry: (attempt, reason) => {
          options.onProgress?.(
            `Retrying GitHub archive download (${attempt}) due to ${formatRetryReason(reason)}`
          );
        },
      }
    );
  };

  options.onProgress?.(`Downloading ${repo.owner}/${repo.repo}@${repo.ref}...`);

  let response: Response | null = null;
  let directError: unknown;
  try {
    response = await fetchArchive(repo.archiveUrl);
  } catch (error) {
    directError = error;
  }

  if ((!response || !response.ok) && isBrowserRuntime()) {
    const proxyCandidates = getBrowserCorsProxyCandidates();
    for (const proxyBase of proxyCandidates) {
      const proxiedUrl = buildProxyUrl(proxyBase, repo.archiveUrl);
      options.onProgress?.(`Retrying via CORS proxy: ${proxyBase}`);
      try {
        response = await fetchArchive(proxiedUrl);
      } catch {
        continue;
      }
      if (response.ok) {
        break;
      }
    }
  }

  if (!response) {
    throw directError instanceof Error
      ? directError
      : new Error(`Failed to download GitHub archive: ${repo.archiveUrl}`);
  }

  let extractedFiles: string[] = [];

  if (response.ok) {
    const archive = await response.arrayBuffer();
    options.onProgress?.('Extracting archive...');
    extractedFiles = extractTarball(archive, vfs, destPath, {
      stripComponents: 1,
      onProgress: options.onProgress,
    });
  } else if (isBrowserRuntime()) {
    extractedFiles = await importGitHubRepoViaApi(vfs, repo, destPath, options);
  } else {
    throw new Error(`Failed to download GitHub archive: ${response.status}`);
  }

  if (repo.subdir && !vfs.existsSync(projectPath)) {
    throw new Error(
      `Subdirectory "${repo.subdir}" not found in ${repo.owner}/${repo.repo}@${repo.ref}`
    );
  }

  options.onProgress?.(`Imported ${extractedFiles.length} files to ${destPath}`);

  return {
    repo,
    rootPath: destPath,
    projectPath,
    extractedFiles,
  };
}
