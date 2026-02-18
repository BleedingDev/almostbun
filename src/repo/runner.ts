import * as path from '../shims/path';
import { Buffer } from '../shims/stream';
import { Runtime } from '../runtime';
import { DevServer, ResponseData } from '../dev-server';
import { ViteDevServer } from '../frameworks/vite-dev-server';
import { NextDevServer } from '../frameworks/next-dev-server';
import { ModernJsDistServer } from '../frameworks/modernjs-dist-server';
import { getServerBridge, type IVirtualServer, type ServerBridge } from '../server-bridge';
import { getServer } from '../shims/http';
import { VirtualFS } from '../virtual-fs';
import {
  bootstrapGitHubProject,
  type BootstrapGitHubProjectOptions,
  type BootstrapGitHubProjectResult,
} from './bootstrap';
import { runRepoPreflight, type RepoPreflightResult } from './preflight';
import { buildRepoFailureDiagnostic, RepoRunError } from './failure-diagnostics';

type PackageJsonLike = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  main?: string;
};

const DEFAULT_PORTS: Record<RunnableProjectKind, number> = {
  vite: 5173,
  next: 3000,
  'modernjs-dist': 8080,
  static: 8080,
  'node-script': 3000,
};

export type RunnableProjectKind =
  | 'vite'
  | 'next'
  | 'modernjs-dist'
  | 'static'
  | 'node-script';

export interface DetectRunnableProjectOptions {
  /**
   * Root directory in VFS to inspect.
   * @default '/'
   */
  projectPath?: string;
  /**
   * Search depth for fallback package discovery when root has no runnable markers.
   * @default 3
   */
  fallbackSearchDepth?: number;
}

export interface DetectedRunnableProject {
  kind: RunnableProjectKind;
  /**
   * Project root directory (contains package.json when available).
   */
  projectPath: string;
  /**
   * Server root for static/dist servers.
   */
  serverRoot: string;
  /**
   * Human-readable detection reason.
   */
  reason: string;
  /**
   * Entry file for node-script mode.
   */
  entryPath?: string;
  /**
   * Optional argv payload for node-script entry execution.
   */
  entryArgs?: string[];
}

export interface StartDetectedProjectOptions {
  /**
   * Preferred port. If occupied by another virtual server, next free port is used.
   */
  port?: number;
  /**
   * Additional environment variables passed to runtime-backed servers.
   */
  env?: Record<string, string>;
  /**
   * Optional logger callback.
   */
  log?: (message: string) => void;
  /**
   * Existing ServerBridge instance.
   */
  bridge?: ServerBridge;
  /**
   * Initialize Service Worker bridge before starting.
   * @default true in browser, false in non-browser environments
   */
  initServiceWorker?: boolean;
  /**
   * Timeout waiting for a script-started HTTP server.
   * @default 2000
   */
  serverReadyTimeoutMs?: number;
  /**
   * Disable Vite HTML/HMR injection for compatibility with certain templates.
   * @default false
   */
  disableViteHmrInjection?: boolean;
  /**
   * Structured trace callback for deterministic diagnostics.
   */
  onTraceEvent?: (event: RepoRunTraceEvent) => void;
}

export interface RunningProject {
  kind: RunnableProjectKind;
  projectPath: string;
  serverRoot: string;
  port: number;
  url: string;
  stop: () => void;
  runtime?: Runtime;
}

export interface BootstrapAndRunOptions
  extends Omit<BootstrapGitHubProjectOptions, 'destPath'>,
    StartDetectedProjectOptions {
  /**
   * Destination directory where the repo will be extracted.
   * @default '/project'
   */
  destPath?: string;
  /**
   * Preflight validation mode.
   * - off: skip preflight checks
   * - warn: log issues and continue
   * - strict: throw when preflight finds errors
   * @default warn
   */
  preflightMode?: 'off' | 'warn' | 'strict';
  /**
   * Optional SLO budgets (milliseconds) for observability-only reporting.
   * Runs never fail solely because a budget is exceeded.
   */
  performanceBudgetsMs?: Partial<RepoRunSloBudgetsMs>;
}

export interface BootstrapAndRunResult {
  vfs: VirtualFS;
  bootstrap: BootstrapGitHubProjectResult;
  preflight: RepoPreflightResult;
  detected: DetectedRunnableProject;
  running: RunningProject;
  trace: RepoRunTraceEvent[];
  observability?: RepoRunObservability;
}

export interface RepoRunTraceEvent {
  sequence: number;
  atMs: number;
  phase: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface RepoRunPhaseDurationsMs {
  bootstrapMs: number;
  preflightMs: number;
  detectMs: number;
  startMs: number;
  totalMs: number;
}

export interface RepoRunSloBudgetsMs {
  bootstrapMs: number;
  startMs: number;
  totalMs: number;
}

export interface RepoRunSloBreach {
  metric: keyof RepoRunSloBudgetsMs;
  actualMs: number;
  budgetMs: number;
}

export interface RepoRunSloStatus {
  passed: boolean;
  breaches: RepoRunSloBreach[];
}

export interface RepoRunCacheObservability {
  snapshotReadSource: 'none' | 'memory' | 'persistent';
  snapshotWritten: boolean;
  archiveSource?: string;
}

export interface RepoRunObservability {
  durationsMs: RepoRunPhaseDurationsMs;
  sloBudgetsMs: RepoRunSloBudgetsMs;
  slo: RepoRunSloStatus;
  cache: RepoRunCacheObservability;
}

interface ModernJsSiblingDistProject {
  projectPath: string;
  serverRoot: string;
  port: number;
}

const SCRIPT_PRIORITY = ['bun', 'dev', 'start', 'serve', 'preview'] as const;
const SCRIPT_ENTRY_FALLBACKS = ['server', 'server.ts', 'server.js', 'index', 'index.ts', 'index.js', 'app.ts', 'app.js'];
const SCRIPT_EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx'];
const NEXT_PAGE_EXTENSIONS = ['.jsx', '.tsx', '.js', '.ts'] as const;
const NEXT_PAGES_DIR_CANDIDATES = ['pages', 'src/pages'] as const;
const NEXT_APP_DIR_CANDIDATES = ['app', 'src/app'] as const;
const MODERN_CONFIG_CANDIDATES = [
  'modern.config.ts',
  'modern.config.mts',
  'modern.config.js',
  'modern.config.mjs',
  'modern.config.cjs',
] as const;
const TANSTACK_START_CONFIG_FILES = [
  'app.config.ts',
  'app.config.mts',
  'app.config.js',
  'app.config.mjs',
] as const;
const TANSTACK_START_CLIENT_CANDIDATES = [
  'src/client.tsx',
  'src/client.ts',
  'src/client.jsx',
  'src/client.js',
  'client.tsx',
  'client.ts',
  'client.jsx',
  'client.js',
] as const;
const DEFAULT_REPO_RUN_SLO_BUDGETS_MS: RepoRunSloBudgetsMs = {
  bootstrapMs: 120_000,
  startMs: 30_000,
  totalMs: 180_000,
};

function toNonNegativeFiniteInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, Math.floor(parsed));
}

export function resolveRepoRunSloBudgets(
  overrides: Partial<RepoRunSloBudgetsMs> | undefined
): RepoRunSloBudgetsMs {
  return {
    bootstrapMs: toNonNegativeFiniteInt(
      overrides?.bootstrapMs,
      DEFAULT_REPO_RUN_SLO_BUDGETS_MS.bootstrapMs
    ),
    startMs: toNonNegativeFiniteInt(
      overrides?.startMs,
      DEFAULT_REPO_RUN_SLO_BUDGETS_MS.startMs
    ),
    totalMs: toNonNegativeFiniteInt(
      overrides?.totalMs,
      DEFAULT_REPO_RUN_SLO_BUDGETS_MS.totalMs
    ),
  };
}

export function evaluateRepoRunSlo(
  durations: RepoRunPhaseDurationsMs,
  budgets: RepoRunSloBudgetsMs
): RepoRunSloStatus {
  const checks: Array<keyof RepoRunSloBudgetsMs> = ['bootstrapMs', 'startMs', 'totalMs'];
  const breaches: RepoRunSloBreach[] = [];
  for (const metric of checks) {
    const actualMs = durations[metric];
    const budgetMs = budgets[metric];
    if (actualMs > budgetMs) {
      breaches.push({
        metric,
        actualMs,
        budgetMs,
      });
    }
  }

  return {
    passed: breaches.length === 0,
    breaches,
  };
}

function summarizeRepoRunCache(
  bootstrap: BootstrapGitHubProjectResult
): RepoRunCacheObservability {
  return {
    snapshotReadSource: bootstrap.cache?.snapshotReadSource || 'none',
    snapshotWritten: bootstrap.cache?.snapshotWritten === true,
    archiveSource: bootstrap.cache?.archiveSource,
  };
}

class StaticFileServer extends DevServer {
  startWatching(): void {
    // Static server; no-op
  }

  async handleRequest(
    _method: string,
    url: string,
    _headers: Record<string, string>,
    _body?: Buffer
  ): Promise<ResponseData> {
    const urlObj = new URL(url, `http://localhost:${this.port}`);
    const pathname = urlObj.pathname || '/';

    const directCandidate = pathname === '/' ? '/index.html' : pathname;
    const directPath = this.resolvePath(directCandidate);
    if (this.exists(directPath)) {
      if (this.isDirectory(directPath)) {
        const indexCandidate = path.posix.join(directCandidate, 'index.html');
        const indexPath = this.resolvePath(indexCandidate);
        if (this.exists(indexPath)) {
          return this.serveFile(indexCandidate);
        }
      } else {
        return this.serveFile(directCandidate);
      }
    }

    if (!/\.[a-zA-Z0-9]+$/.test(pathname)) {
      const htmlCandidate = `${pathname}.html`;
      const htmlPath = this.resolvePath(htmlCandidate);
      if (this.exists(htmlPath)) {
        return this.serveFile(htmlCandidate);
      }
    }

    const spaFallback = this.resolvePath('/index.html');
    if (this.exists(spaFallback)) {
      return this.serveFile('/index.html');
    }

    return this.notFound(pathname);
  }
}

function normalizeAbsolutePath(input: string): string {
  const normalized = input.replace(/\\/g, '/');
  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return withLeadingSlash.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

function hasPath(vfs: VirtualFS, filePath: string): boolean {
  try {
    vfs.statSync(filePath);
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
    const raw = vfs.readFileSync(pkgPath, 'utf8');
    return JSON.parse(raw) as PackageJsonLike;
  } catch {
    return null;
  }
}

function collectDependencyNames(pkg: PackageJsonLike | null): Set<string> {
  const names = new Set<string>();
  if (!pkg) {
    return names;
  }

  const groups = [
    pkg.dependencies,
    pkg.devDependencies,
    pkg.optionalDependencies,
    pkg.peerDependencies,
  ];

  for (const group of groups) {
    if (!group) continue;
    for (const name of Object.keys(group)) {
      names.add(name.toLowerCase());
    }
  }

  return names;
}

function isFile(vfs: VirtualFS, filePath: string): boolean {
  try {
    return vfs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function hasModernJsDistOutput(vfs: VirtualFS, projectPath: string): boolean {
  return (
    hasPath(vfs, path.posix.join(projectPath, 'dist/route.json')) ||
    hasPath(vfs, path.posix.join(projectPath, 'dist/api')) ||
    hasPath(vfs, path.posix.join(projectPath, 'dist/html'))
  );
}

function hasDirectory(vfs: VirtualFS, dirPath: string): boolean {
  try {
    return vfs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function resolveExistingDirectory(
  vfs: VirtualFS,
  projectPath: string,
  candidates: readonly string[]
): string | null {
  for (const relative of candidates) {
    const fullPath = path.posix.join(projectPath, relative);
    if (hasDirectory(vfs, fullPath)) {
      return fullPath;
    }
  }
  return null;
}

function hasNextSourceDirectories(vfs: VirtualFS, projectPath: string): boolean {
  return Boolean(
    resolveExistingDirectory(vfs, projectPath, NEXT_PAGES_DIR_CANDIDATES) ||
      resolveExistingDirectory(vfs, projectPath, NEXT_APP_DIR_CANDIDATES)
  );
}

function hasRootPageRouteInPagesDir(vfs: VirtualFS, pagesDir: string): boolean {
  for (const ext of NEXT_PAGE_EXTENSIONS) {
    if (hasPath(vfs, `${pagesDir}/index${ext}`)) {
      return true;
    }
  }
  return false;
}

function hasRootPageRouteInAppDir(vfs: VirtualFS, appDir: string): boolean {
  for (const ext of NEXT_PAGE_EXTENSIONS) {
    if (hasPath(vfs, `${appDir}/page${ext}`)) {
      return true;
    }
  }

  let entries: string[] = [];
  try {
    entries = vfs.readdirSync(appDir);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!/^\([^)]+\)$/.test(entry)) {
      continue;
    }
    const groupDir = `${appDir}/${entry}`;
    if (!hasDirectory(vfs, groupDir)) {
      continue;
    }
    for (const ext of NEXT_PAGE_EXTENSIONS) {
      if (hasPath(vfs, `${groupDir}/page${ext}`)) {
        return true;
      }
    }
  }

  return false;
}

function hasNextRootPageRoute(vfs: VirtualFS, projectPath: string): boolean {
  for (const relative of NEXT_PAGES_DIR_CANDIDATES) {
    const pagesDir = path.posix.join(projectPath, relative);
    if (hasDirectory(vfs, pagesDir) && hasRootPageRouteInPagesDir(vfs, pagesDir)) {
      return true;
    }
  }

  for (const relative of NEXT_APP_DIR_CANDIDATES) {
    const appDir = path.posix.join(projectPath, relative);
    if (hasDirectory(vfs, appDir) && hasRootPageRouteInAppDir(vfs, appDir)) {
      return true;
    }
  }

  return false;
}

function projectKindRank(kind: RunnableProjectKind): number {
  if (kind === 'modernjs-dist') return 5;
  if (kind === 'next') return 4;
  if (kind === 'vite') return 3;
  if (kind === 'node-script') return 2;
  return 1;
}

function detectedProjectScore(vfs: VirtualFS, detected: DetectedRunnableProject): number {
  let score = projectKindRank(detected.kind) * 1000;
  score -= detected.projectPath.split('/').filter(Boolean).length;

  if (detected.kind === 'next') {
    if (hasNextSourceDirectories(vfs, detected.projectPath)) {
      score += 50;
    }
    if (hasNextRootPageRoute(vfs, detected.projectPath)) {
      score += 200;
    }
  }

  return score;
}

function parseModernJsServerPortFromConfig(vfs: VirtualFS, projectPath: string): number | null {
  for (const configFile of MODERN_CONFIG_CANDIDATES) {
    const configPath = path.posix.join(projectPath, configFile);
    if (!isFile(vfs, configPath)) {
      continue;
    }

    let content = '';
    try {
      content = vfs.readFileSync(configPath, 'utf8');
    } catch {
      continue;
    }

    const match = content.match(/server\s*:\s*\{[\s\S]*?\bport\s*:\s*(\d{2,5})\b/m);
    if (!match) {
      continue;
    }

    const parsed = Number(match[1]);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
      continue;
    }

    return parsed;
  }

  return null;
}

function discoverSiblingModernJsDistProjects(
  vfs: VirtualFS,
  projectPath: string,
  hostPort: number,
  usedPorts: Set<number>
): ModernJsSiblingDistProject[] {
  const parentPath = path.posix.dirname(projectPath);
  if (!parentPath || parentPath === projectPath) {
    return [];
  }

  let entries: string[] = [];
  try {
    entries = vfs.readdirSync(parentPath);
  } catch {
    return [];
  }

  const discovered: ModernJsSiblingDistProject[] = [];
  for (const entry of entries) {
    const siblingProjectPath = path.posix.join(parentPath, entry);
    if (siblingProjectPath === projectPath) {
      continue;
    }

    let stat: ReturnType<VirtualFS['statSync']>;
    try {
      stat = vfs.statSync(siblingProjectPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) {
      continue;
    }

    if (!hasModernJsDistOutput(vfs, siblingProjectPath)) {
      continue;
    }

    const siblingPort = parseModernJsServerPortFromConfig(vfs, siblingProjectPath);
    if (!siblingPort || siblingPort === hostPort || usedPorts.has(siblingPort)) {
      continue;
    }

    discovered.push({
      projectPath: siblingProjectPath,
      serverRoot: path.posix.join(siblingProjectPath, 'dist'),
      port: siblingPort,
    });
    usedPorts.add(siblingPort);
  }

  return discovered.sort((a, b) => a.port - b.port);
}

function tokenizeCommand(command: string): string[] {
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  if (!tokens) return [];
  return tokens.map(token => token.replace(/^['"]|['"]$/g, ''));
}

function looksLikeFileReference(token: string): boolean {
  if (!token) return false;
  if (token.startsWith('./') || token.startsWith('../') || token.startsWith('/')) {
    return true;
  }
  if (token === '.' || token === '..') {
    return true;
  }
  return /\.(m?[jt]sx?|cjs|cts|mts)$/i.test(token);
}

interface ScriptEntryDetection {
  entryPath: string;
  args: string[];
}

function resolvePackageBinEntry(
  vfs: VirtualFS,
  projectPath: string,
  binCommand: string
): string | null {
  const resolveFromPackageDir = (packageDir: string, allowLooseFallback = false): string | null => {
    const packageJsonPath = path.posix.join(packageDir, 'package.json');
    if (!hasPath(vfs, packageJsonPath)) {
      return null;
    }

    try {
      const pkg = JSON.parse(vfs.readFileSync(packageJsonPath, 'utf8')) as {
        name?: string;
        bin?: string | Record<string, string>;
      };

      let binTarget: string | null = null;
      if (typeof pkg.bin === 'string') {
        if (pkg.name === binCommand || allowLooseFallback) {
          binTarget = pkg.bin;
        }
      } else if (pkg.bin && typeof pkg.bin === 'object') {
        const direct = pkg.bin[binCommand];
        const byPackageName = pkg.name ? pkg.bin[pkg.name] : undefined;
        if (direct) {
          binTarget = direct;
        } else if (pkg.name === binCommand && byPackageName) {
          binTarget = byPackageName;
        } else if (allowLooseFallback && pkg.name === binCommand) {
          binTarget = Object.values(pkg.bin)[0] || null;
        }
      }

      if (!binTarget) {
        return null;
      }

      return resolveEntryCandidate(vfs, packageDir, binTarget);
    } catch {
      return null;
    }
  };

  const directPackageDir = path.posix.join(projectPath, 'node_modules', binCommand);
  const direct = resolveFromPackageDir(directPackageDir, true);
  if (direct) {
    return direct;
  }

  const nodeModulesDir = path.posix.join(projectPath, 'node_modules');
  if (!hasPath(vfs, nodeModulesDir)) {
    return null;
  }

  let entries: string[] = [];
  try {
    entries = vfs.readdirSync(nodeModulesDir);
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (entry === '.bin') {
      continue;
    }
    const entryPath = path.posix.join(nodeModulesDir, entry);
    try {
      const stat = vfs.statSync(entryPath);
      if (!stat.isDirectory()) {
        continue;
      }

      if (entry.startsWith('@')) {
        let scopedEntries: string[] = [];
        try {
          scopedEntries = vfs.readdirSync(entryPath);
        } catch {
          continue;
        }
        for (const scoped of scopedEntries) {
          const scopedPackageDir = path.posix.join(entryPath, scoped);
          const resolved = resolveFromPackageDir(scopedPackageDir);
          if (resolved) {
            return resolved;
          }
        }
        continue;
      }

      const resolved = resolveFromPackageDir(entryPath);
      if (resolved) {
        return resolved;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function resolveEntryCandidate(vfs: VirtualFS, projectPath: string, candidate: string): string | null {
  const normalizedCandidate = candidate.replace(/\\/g, '/');
  const absoluteBase = normalizedCandidate.startsWith('/')
    ? normalizedCandidate
    : path.posix.join(projectPath, normalizedCandidate);
  const extension = path.posix.extname(absoluteBase);
  const candidates = extension ? [absoluteBase] : SCRIPT_EXTENSIONS.map(ext => `${absoluteBase}${ext}`);

  for (const filePath of candidates) {
    if (hasPath(vfs, filePath)) {
      try {
        if (vfs.statSync(filePath).isFile()) {
          return filePath;
        }
      } catch {
        // ignore
      }
    }
  }

  return null;
}

function resolveEntryFromScriptCommand(
  vfs: VirtualFS,
  projectPath: string,
  command: string
): ScriptEntryDetection | null {
  const firstCommand = command.split(/\s*(?:&&|\|\||;)\s*/)[0]?.trim();
  if (!firstCommand) return null;

  const tokens = tokenizeCommand(firstCommand);
  if (tokens.length === 0) return null;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.includes('=') && !token.startsWith('./') && !token.startsWith('../')) {
      continue;
    }

    if (token === 'node' || token === 'bun' || token === 'tsx' || token === 'ts-node') {
      let cursor = i + 1;

      if (token === 'bun' && tokens[cursor] === 'run') {
        cursor += 1;
      }

      while (cursor < tokens.length) {
        const next = tokens[cursor];
        if (!next) break;

        if (next === 'watch' || next === '--watch') {
          cursor += 1;
          continue;
        }

        if (next.startsWith('-')) {
          // Known flags that consume an extra value.
          if (next === '-r' || next === '--require' || next === '--loader' || next === '--import') {
            cursor += 2;
          } else {
            cursor += 1;
          }
          continue;
        }

        if (looksLikeFileReference(next)) {
          const resolved = resolveEntryCandidate(vfs, projectPath, next);
          if (resolved) {
            return {
              entryPath: resolved,
              args: tokens.slice(cursor + 1),
            };
          }
          return null;
        }

        // bun run start/dev indicates another script, not a file entry.
        return null;
      }
    }

    if (i === 0 && looksLikeFileReference(token)) {
      const resolved = resolveEntryCandidate(vfs, projectPath, token);
      if (resolved) {
        return {
          entryPath: resolved,
          args: tokens.slice(i + 1),
        };
      }
      return null;
    }

    if (i === 0 && !token.startsWith('-')) {
      const binEntry = resolvePackageBinEntry(vfs, projectPath, token);
      if (binEntry) {
        return {
          entryPath: binEntry,
          args: tokens.slice(i + 1),
        };
      }
    }
  }

  return null;
}

function resolveEntryFromScriptReference(
  vfs: VirtualFS,
  projectPath: string,
  scripts: Record<string, string>,
  scriptName: string,
  visited: Set<string> = new Set()
): ScriptEntryDetection | null {
  if (visited.has(scriptName)) {
    return null;
  }
  visited.add(scriptName);

  const command = scripts[scriptName];
  if (!command) {
    return null;
  }

  const direct = resolveEntryFromScriptCommand(vfs, projectPath, command);
  if (direct) {
    return direct;
  }

  const firstCommand = command.split(/\s*(?:&&|\|\||;)\s*/)[0]?.trim();
  if (!firstCommand) {
    return null;
  }

  const tokens = tokenizeCommand(firstCommand);
  if (tokens.length < 2) {
    return null;
  }

  const resolveNestedScript = (nestedScriptName: string | undefined): ScriptEntryDetection | null => {
    if (!nestedScriptName || looksLikeFileReference(nestedScriptName)) {
      return null;
    }
    return resolveEntryFromScriptReference(vfs, projectPath, scripts, nestedScriptName, visited);
  };

  if (tokens[0] === 'bun' && tokens[1] === 'run') {
    return resolveNestedScript(tokens[2]);
  }
  if ((tokens[0] === 'npm' || tokens[0] === 'pnpm') && tokens[1] === 'run') {
    return resolveNestedScript(tokens[2]);
  }
  if (tokens[0] === 'yarn') {
    return resolveNestedScript(tokens[1]);
  }

  return null;
}

function resolveNodeScriptEntry(vfs: VirtualFS, projectPath: string, pkg: PackageJsonLike | null): {
  entryPath: string;
  entryArgs: string[];
  source: string;
} | null {
  const scripts = pkg?.scripts || {};

  for (const key of SCRIPT_PRIORITY) {
    const scriptCommand = scripts[key];
    if (!scriptCommand) continue;
    const entryFromScript =
      resolveEntryFromScriptCommand(vfs, projectPath, scriptCommand) ||
      resolveEntryFromScriptReference(vfs, projectPath, scripts, key);
    if (entryFromScript) {
      return {
        entryPath: entryFromScript.entryPath,
        entryArgs: entryFromScript.args,
        source: `scripts.${key}`,
      };
    }
  }

  if (pkg?.main) {
    const mainEntry = resolveEntryCandidate(vfs, projectPath, pkg.main);
    if (mainEntry) {
      return {
        entryPath: mainEntry,
        entryArgs: [],
        source: 'package.main',
      };
    }
  }

  for (const fallback of SCRIPT_ENTRY_FALLBACKS) {
    const fallbackEntry = resolveEntryCandidate(vfs, projectPath, fallback);
    if (fallbackEntry) {
      return {
        entryPath: fallbackEntry,
        entryArgs: [],
        source: `fallback:${fallback}`,
      };
    }
  }

  return null;
}

function extractCommandCandidates(command: string): string[] {
  const out = new Set<string>();
  const add = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (trimmed) {
      out.add(trimmed);
    }
  };

  add(command);
  command.split(/\s*(?:&&|\|\||;)\s*/).forEach(add);

  const quoted = command.matchAll(/"([^"]+)"|'([^']+)'/g);
  for (const match of quoted) {
    add(match[1] || match[2]);
  }

  return Array.from(out);
}

function isLikelyBackendEntry(entryPath: string): boolean {
  const normalized = entryPath.toLowerCase();
  if (normalized.includes('/node_modules/')) {
    return false;
  }
  if (normalized.includes('/server/')) {
    return true;
  }
  if (normalized.includes('/api/')) {
    return true;
  }
  return /\/(?:server|backend|api)\.(?:m?[jt]sx?|cjs|cts|mts)$/.test(normalized);
}

function detectViteApiSidecarEntry(
  vfs: VirtualFS,
  projectPath: string,
  pkg: PackageJsonLike | null
): {
  entryPath: string;
  entryArgs: string[];
  source: string;
} | null {
  if (!pkg) {
    return null;
  }

  const deps = collectDependencyNames(pkg);
  const likelyBackendStack =
    deps.has('elysia') ||
    deps.has('express') ||
    deps.has('fastify') ||
    deps.has('hono') ||
    deps.has('koa');

  const scripts = pkg.scripts || {};
  const priorityScripts = ['start', 'server', 'backend', 'api', 'dev', 'bun'] as const;
  for (const scriptName of priorityScripts) {
    const command = scripts[scriptName];
    if (!command) continue;

    for (const candidate of extractCommandCandidates(command)) {
      const resolved = resolveEntryFromScriptCommand(vfs, projectPath, candidate);
      if (!resolved) continue;
      if (isLikelyBackendEntry(resolved.entryPath)) {
        return {
          entryPath: resolved.entryPath,
          entryArgs: resolved.args,
          source: `scripts.${scriptName}`,
        };
      }
    }
  }

  if (!likelyBackendStack) {
    return null;
  }

  const fallbackCandidates = [
    'src/server/index.ts',
    'src/server/index.tsx',
    'src/server/index.js',
    'src/server.ts',
    'src/server.js',
    'server.ts',
    'server.js',
  ];

  for (const candidate of fallbackCandidates) {
    const resolved = resolveEntryCandidate(vfs, projectPath, candidate);
    if (resolved) {
      return {
        entryPath: resolved,
        entryArgs: [],
        source: `fallback:${candidate}`,
      };
    }
  }

  return null;
}

function findViteServerRoot(vfs: VirtualFS, projectPath: string): string {
  const rootIndex = path.posix.join(projectPath, 'index.html');
  if (isFile(vfs, rootIndex)) {
    return projectPath;
  }

  const priorityDirs = [
    'src/client',
    'client',
    'web',
    'app',
    'src',
  ];

  for (const relativeDir of priorityDirs) {
    const candidateDir = path.posix.join(projectPath, relativeDir);
    const candidateIndex = path.posix.join(candidateDir, 'index.html');
    if (isFile(vfs, candidateIndex)) {
      return candidateDir;
    }
  }

  const maxDepth = 4;
  const queue: Array<{ dir: string; depth: number }> = [{ dir: projectPath, depth: 0 }];
  const visited = new Set<string>();
  const candidates: string[] = [];

  while (queue.length > 0) {
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
      if (entry === 'node_modules' || entry === '.git') {
        continue;
      }
      const fullPath = path.posix.join(current.dir, entry);
      try {
        const stat = vfs.statSync(fullPath);
        if (stat.isFile() && entry === 'index.html') {
          candidates.push(fullPath);
          continue;
        }
        if (stat.isDirectory() && current.depth < maxDepth) {
          queue.push({ dir: fullPath, depth: current.depth + 1 });
        }
      } catch {
        // ignore
      }
    }
  }

  if (candidates.length === 0) {
    return projectPath;
  }

  const scored = candidates
    .map((candidate) => {
      const relative = path.posix.relative(projectPath, candidate);
      const depth = relative.split('/').length;
      let score = 0;

      if (relative === 'src/client/index.html') score += 120;
      if (relative === 'client/index.html') score += 100;
      if (relative === 'web/index.html') score += 90;
      if (relative === 'src/index.html') score += 80;
      if (relative.endsWith('/index.html')) score += 20;
      if (relative.includes('/dist/')) score -= 80;
      if (relative.includes('/build/')) score -= 60;
      if (relative.includes('/public/')) score -= 40;
      score -= depth;

      return { candidate, score };
    })
    .sort((a, b) => b.score - a.score);

  return path.posix.dirname(scored[0]!.candidate);
}

function detectInProjectRoot(vfs: VirtualFS, projectPath: string): DetectedRunnableProject | null {
  const pkg = readPackageJson(vfs, projectPath);
  const deps = collectDependencyNames(pkg);
  const scripts = Object.values(pkg?.scripts || {}).join('\n');

  const hasViteConfig = [
    'vite.config.ts',
    'vite.config.js',
    'vite.config.mjs',
    'vite.config.mts',
    'vite.config.cjs',
    'vite.config.cts',
  ].some(file => hasPath(vfs, path.posix.join(projectPath, file)));

  const hasNextConfig = [
    'next.config.ts',
    'next.config.js',
    'next.config.mjs',
    'next.config.cjs',
  ].some(file => hasPath(vfs, path.posix.join(projectPath, file)));

  const hasDistRouteJson = hasPath(vfs, path.posix.join(projectPath, 'dist/route.json'));
  const hasDistApi = hasPath(vfs, path.posix.join(projectPath, 'dist/api'));
  const hasDistHtml = hasPath(vfs, path.posix.join(projectPath, 'dist/html'));

  if (hasDistRouteJson || hasDistApi || hasDistHtml) {
    const reasons = [
      hasDistRouteJson ? 'dist/route.json' : '',
      hasDistApi ? 'dist/api' : '',
      hasDistHtml ? 'dist/html' : '',
    ].filter(Boolean);
    return {
      kind: 'modernjs-dist',
      projectPath,
      serverRoot: path.posix.join(projectPath, 'dist'),
      reason: `Detected Modern.js dist output (${reasons.join(', ')})`,
    };
  }

  const hasNextDirs = hasNextSourceDirectories(vfs, projectPath);
  const hasNextDep = deps.has('next');
  const hasNextScript = /\bnext(?:\s|$)/.test(scripts);

  if (hasNextDep || hasNextConfig || hasNextDirs || hasNextScript) {
    const reasons = [
      hasNextDep ? 'dependency:next' : '',
      hasNextConfig ? 'next.config.*' : '',
      hasNextDirs ? 'pages/app directory' : '',
      hasNextScript ? 'script uses next' : '',
    ].filter(Boolean);
    return {
      kind: 'next',
      projectPath,
      serverRoot: projectPath,
      reason: `Detected Next.js app (${reasons.join(', ')})`,
    };
  }

  const hasViteDep = deps.has('vite') || deps.has('@vitejs/plugin-react');
  const hasViteScript = /\bvite(?:\s|$)/.test(scripts);
  const hasIndexHtml = hasPath(vfs, path.posix.join(projectPath, 'index.html'));
  const hasViteSignals = hasViteConfig || hasViteScript || (hasViteDep && hasIndexHtml);

  if (hasViteSignals) {
    const viteServerRoot = findViteServerRoot(vfs, projectPath);
    const reasons = [
      hasViteConfig ? 'vite.config.*' : '',
      hasViteDep ? 'dependency:vite' : '',
      hasViteScript ? 'script uses vite' : '',
      hasIndexHtml ? 'index.html' : '',
      viteServerRoot !== projectPath ? `vite root:${path.posix.relative(projectPath, viteServerRoot) || '.'}` : '',
    ].filter(Boolean);
    return {
      kind: 'vite',
      projectPath,
      serverRoot: viteServerRoot,
      reason: `Detected Vite app (${reasons.join(', ')})`,
    };
  }

  const hasTanStackStartDep = deps.has('@tanstack/react-start') || deps.has('@tanstack/start');
  const hasTanStackConfig = TANSTACK_START_CONFIG_FILES
    .some(file => hasPath(vfs, path.posix.join(projectPath, file)));
  const tanStackClientEntry = TANSTACK_START_CLIENT_CANDIDATES
    .find(file => hasPath(vfs, path.posix.join(projectPath, file)));

  if ((hasTanStackStartDep || hasTanStackConfig) && tanStackClientEntry) {
    const reasons = [
      hasTanStackStartDep ? 'dependency:@tanstack/react-start|@tanstack/start' : '',
      hasTanStackConfig ? 'app.config.*' : '',
      `client entry:${tanStackClientEntry}`,
    ].filter(Boolean);

    return {
      kind: 'vite',
      projectPath,
      serverRoot: projectPath,
      reason: `Detected TanStack Start app (${reasons.join(', ')})`,
    };
  }

  const nodeEntry = resolveNodeScriptEntry(vfs, projectPath, pkg);
  if (nodeEntry) {
    return {
      kind: 'node-script',
      projectPath,
      serverRoot: projectPath,
      entryPath: nodeEntry.entryPath,
      entryArgs: nodeEntry.entryArgs,
      reason: `Detected runtime script entry via ${nodeEntry.source}: ${nodeEntry.entryPath}`,
    };
  }

  if (hasIndexHtml) {
    return {
      kind: 'static',
      projectPath,
      serverRoot: projectPath,
      reason: 'Detected static site via index.html',
    };
  }

  if (hasPath(vfs, path.posix.join(projectPath, 'dist/index.html'))) {
    return {
      kind: 'static',
      projectPath,
      serverRoot: path.posix.join(projectPath, 'dist'),
      reason: 'Detected static dist output via dist/index.html',
    };
  }

  return null;
}

function discoverPackageRoots(vfs: VirtualFS, root: string, maxDepth: number): string[] {
  const out: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.dir)) continue;
    visited.add(current.dir);

    if (hasPath(vfs, path.posix.join(current.dir, 'package.json'))) {
      out.push(current.dir);
    }

    if (current.depth >= maxDepth) {
      continue;
    }

    let entries: string[] = [];
    try {
      entries = vfs.readdirSync(current.dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git' || entry === '.turbo' || entry === 'dist') {
        continue;
      }
      const fullPath = path.posix.join(current.dir, entry);
      try {
        if (vfs.statSync(fullPath).isDirectory()) {
          queue.push({ dir: fullPath, depth: current.depth + 1 });
        }
      } catch {
        // ignore
      }
    }
  }

  return out;
}

function choosePort(bridge: ServerBridge, preferredPort: number): number {
  let candidate = preferredPort;
  const usedPorts = new Set(bridge.getServerPorts());
  while (usedPorts.has(candidate)) {
    candidate += 1;
  }
  return candidate;
}

function createVirtualServerWrapper(server: DevServer): IVirtualServer {
  return {
    listening: true,
    address: () => ({ port: server.getPort(), address: '0.0.0.0', family: 'IPv4' }),
    async handleRequest(
      method: string,
      url: string,
      headers: Record<string, string>,
      body?: Buffer | string
    ) {
      const normalizedBody = typeof body === 'string' ? Buffer.from(body) : body;
      return server.handleRequest(method, url, headers, normalizedBody);
    },
  };
}

async function ensureServiceWorker(bridge: ServerBridge, shouldInit: boolean, log?: (message: string) => void): Promise<void> {
  if (!shouldInit) {
    return;
  }

  if (typeof window === 'undefined' || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return;
  }

  try {
    await bridge.initServiceWorker();
    log?.('Service Worker ready');
  } catch (error) {
    log?.(`Warning: Service Worker initialization failed: ${String(error)}`);
  }
}

function waitForScriptServerPort(
  bridge: ServerBridge,
  existingPorts: Set<number>,
  timeoutMs: number
): Promise<number | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      bridge.off('server-ready', onServerReady);
      resolve(null);
    }, timeoutMs);

    const onServerReady = (port: unknown) => {
      if (typeof port !== 'number') {
        return;
      }
      if (existingPorts.has(port)) {
        return;
      }
      clearTimeout(timeout);
      bridge.off('server-ready', onServerReady);
      resolve(port);
    };

    bridge.on('server-ready', onServerReady);
  });
}

function createTraceCollector(
  callback?: (event: RepoRunTraceEvent) => void
): {
  events: RepoRunTraceEvent[];
  emit: (phase: string, message: string, data?: Record<string, unknown>) => void;
} {
  const events: RepoRunTraceEvent[] = [];
  const startedAt = Date.now();
  let sequence = 0;
  return {
    events,
    emit: (phase, message, data) => {
      const event: RepoRunTraceEvent = {
        sequence: sequence++,
        atMs: Date.now() - startedAt,
        phase,
        message,
        data,
      };
      events.push(event);
      callback?.(event);
    },
  };
}

/**
 * Detect runnable project type for a VFS path.
 */
export function detectRunnableProject(
  vfs: VirtualFS,
  options: DetectRunnableProjectOptions = {}
): DetectedRunnableProject {
  const projectPath = normalizeAbsolutePath(options.projectPath || '/');
  const directDetection = detectInProjectRoot(vfs, projectPath);
  if (directDetection) {
    return directDetection;
  }

  const fallbackDepth = Math.max(1, options.fallbackSearchDepth ?? 3);
  const candidateRoots = discoverPackageRoots(vfs, projectPath, fallbackDepth)
    .filter(candidate => candidate !== projectPath);

  let firstDetected: DetectedRunnableProject | null = null;
  let firstScore = Number.NEGATIVE_INFINITY;
  for (const candidate of candidateRoots) {
    const detected = detectInProjectRoot(vfs, candidate);
    if (!detected) continue;
    const score = detectedProjectScore(vfs, detected);
    if (!firstDetected) {
      firstDetected = detected;
      firstScore = score;
      continue;
    }
    if (score > firstScore) {
      firstDetected = detected;
      firstScore = score;
    }
  }

  if (firstDetected) {
    return firstDetected;
  }

  throw new Error(
    `Could not detect a runnable app under ${projectPath}. ` +
    'Expected one of: Vite, Next.js, Modern.js dist, static index.html, or a script entry file.'
  );
}

/**
 * Start a detected project and register it in ServerBridge.
 */
export async function startDetectedProject(
  vfs: VirtualFS,
  detected: DetectedRunnableProject,
  options: StartDetectedProjectOptions = {}
): Promise<RunningProject> {
  const localTrace = createTraceCollector(options.onTraceEvent);
  const emitTrace = localTrace.emit;
  const bridge = options.bridge || getServerBridge();
  const log = options.log;
  emitTrace('start', 'Starting detected project', {
    kind: detected.kind,
    projectPath: detected.projectPath,
  });
  const shouldInitServiceWorker = options.initServiceWorker ?? (typeof window !== 'undefined');
  await ensureServiceWorker(bridge, shouldInitServiceWorker, log);

  const preferredPort = options.port ?? DEFAULT_PORTS[detected.kind];
  const selectedPort = choosePort(bridge, preferredPort);
  emitTrace('port', 'Selected project port', {
    preferredPort,
    selectedPort,
  });

  if (detected.kind === 'node-script') {
    if (!detected.entryPath) {
      throw new Error('Detected node-script project has no entryPath');
    }

    const timeoutMs = Math.max(500, options.serverReadyTimeoutMs ?? 2000);
    const beforePorts = new Set(bridge.getServerPorts());
    const env = {
      NODE_ENV: 'development',
      PORT: String(selectedPort),
      BUN_PORT: String(selectedPort),
      ...options.env,
    };
    const argv = ['node', detected.entryPath, ...(detected.entryArgs || [])];

    const runtime = new Runtime(vfs, {
      cwd: detected.projectPath,
      env,
      argv,
      onTrace: (event) => {
        emitTrace('runtime', event.type, {
          id: event.id,
          reason: event.reason,
          resolvedPath: event.resolvedPath,
        });
      },
      onConsole: (method, args) => {
        const rendered = args.map(arg => {
          if (typeof arg === 'string') return arg;
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        }).join(' ');
        log?.(`[runtime:${method}] ${rendered}`);
      },
    });

    const pendingPort = waitForScriptServerPort(bridge, beforePorts, timeoutMs);
    runtime.runFile(detected.entryPath);
    const runtimePort = await pendingPort;

    const newlyRegistered = bridge.getServerPorts().find(port => !beforePorts.has(port));
    const finalPort = runtimePort ?? newlyRegistered;
    if (!finalPort) {
      emitTrace('node-script', 'No HTTP server registered by entry script', {
        entryPath: detected.entryPath,
        timeoutMs,
      });
      throw new Error(
        `Entry script ran (${detected.entryPath}) but no HTTP server was registered. ` +
        'The script must call server.listen(...) during startup.'
      );
    }

    const url = `${bridge.getServerUrl(finalPort)}/`;
    emitTrace('node-script', 'Node script server started', {
      finalPort,
      url,
      entryPath: detected.entryPath,
    });
    return {
      kind: detected.kind,
      projectPath: detected.projectPath,
      serverRoot: detected.serverRoot,
      port: finalPort,
      url,
      runtime,
      stop: () => {
        const server = getServer(finalPort);
        if (server) {
          try {
            server.close();
            return;
          } catch {
            // fall through to explicit unregister
          }
        }
        bridge.unregisterServer(finalPort);
      },
    };
  }

  let server: DevServer;
  const auxiliaryPorts: number[] = [];
  const auxiliaryServers: Array<{ port: number; server: DevServer }> = [];
  let auxiliaryRuntime: Runtime | undefined;
  if (detected.kind === 'vite') {
    const pkg = readPackageJson(vfs, detected.projectPath);
    const sidecarEntry = detectViteApiSidecarEntry(vfs, detected.projectPath, pkg);
    let apiProxyPort: number | undefined;

    if (sidecarEntry) {
      const timeoutMs = Math.max(500, options.serverReadyTimeoutMs ?? 2500);
      const preferredApiPort = selectedPort === 3000 ? 3001 : 3000;
      const sidecarPortCandidate = choosePort(bridge, preferredApiPort);
      const beforePorts = new Set(bridge.getServerPorts());
      const env = {
        NODE_ENV: 'development',
        PORT: String(sidecarPortCandidate),
        BUN_PORT: String(sidecarPortCandidate),
        ...options.env,
      };
      const argv = ['node', sidecarEntry.entryPath, ...(sidecarEntry.entryArgs || [])];

      const runtime = new Runtime(vfs, {
        cwd: detected.projectPath,
        env,
        argv,
        onTrace: (event) => {
          emitTrace('runtime-api', event.type, {
            id: event.id,
            reason: event.reason,
            resolvedPath: event.resolvedPath,
          });
        },
        onConsole: (method, args) => {
          const rendered = args.map(arg => {
            if (typeof arg === 'string') return arg;
            try {
              return JSON.stringify(arg);
            } catch {
              return String(arg);
            }
          }).join(' ');
          log?.(`[runtime-api:${method}] ${rendered}`);
        },
      });

      try {
        const pendingPort = waitForScriptServerPort(bridge, beforePorts, timeoutMs);
        runtime.runFile(sidecarEntry.entryPath);
        const runtimePort = await pendingPort;
        const newlyRegistered = bridge.getServerPorts().find(port => !beforePorts.has(port));
        const finalSidecarPort = runtimePort ?? newlyRegistered;

        if (finalSidecarPort) {
          apiProxyPort = finalSidecarPort;
          auxiliaryRuntime = runtime;
          auxiliaryPorts.push(finalSidecarPort);
          emitTrace('vite-sidecar', 'API sidecar started', {
            source: sidecarEntry.source,
            entryPath: sidecarEntry.entryPath,
            port: finalSidecarPort,
          });
          log?.(
            `Started API sidecar via ${sidecarEntry.source}: ${sidecarEntry.entryPath} -> ${bridge.getServerUrl(finalSidecarPort)}/`
          );
        } else {
          emitTrace('vite-sidecar', 'API sidecar did not register HTTP server', {
            entryPath: sidecarEntry.entryPath,
            timeoutMs,
          });
          log?.(
            `API sidecar entry (${sidecarEntry.entryPath}) did not register an HTTP server within ${timeoutMs}ms; continuing without /api proxy`
          );
        }
      } catch (error) {
        emitTrace('vite-sidecar', 'API sidecar failed', {
          entryPath: sidecarEntry.entryPath,
          error: String(error),
        });
        log?.(
          `API sidecar failed (${sidecarEntry.entryPath}): ${String(error)}; continuing without /api proxy`
        );
      }
    }

    server = new ViteDevServer(vfs, {
      port: selectedPort,
      root: detected.serverRoot,
      disableHmrInjection: options.disableViteHmrInjection ?? false,
      apiProxyPort,
    });
  } else if (detected.kind === 'next') {
    const pagesDir = resolveExistingDirectory(vfs, detected.projectPath, NEXT_PAGES_DIR_CANDIDATES)
      || path.posix.join(detected.projectPath, 'pages');
    const appDir = resolveExistingDirectory(vfs, detected.projectPath, NEXT_APP_DIR_CANDIDATES)
      || path.posix.join(detected.projectPath, 'app');
    server = new NextDevServer(vfs, {
      port: selectedPort,
      root: detected.projectPath,
      pagesDir,
      appDir,
      publicDir: path.posix.join(detected.projectPath, 'public'),
      env: options.env,
    });
  } else if (detected.kind === 'modernjs-dist') {
    server = new ModernJsDistServer(vfs, {
      port: selectedPort,
      root: detected.serverRoot,
      env: options.env,
    });
  } else {
    server = new StaticFileServer(vfs, {
      port: selectedPort,
      root: detected.serverRoot,
    });
  }

  bridge.registerServer(createVirtualServerWrapper(server), selectedPort);
  server.start();

  if (detected.kind === 'modernjs-dist') {
    const usedPorts = new Set(bridge.getServerPorts());
    usedPorts.add(selectedPort);
    const siblingDistProjects = discoverSiblingModernJsDistProjects(
      vfs,
      detected.projectPath,
      selectedPort,
      usedPorts
    );

    for (const sibling of siblingDistProjects) {
      try {
        const siblingServer = new ModernJsDistServer(vfs, {
          port: sibling.port,
          root: sibling.serverRoot,
          env: options.env,
        });
        bridge.registerServer(createVirtualServerWrapper(siblingServer), sibling.port);
        siblingServer.start();
        auxiliaryServers.push({
          port: sibling.port,
          server: siblingServer,
        });
        auxiliaryPorts.push(sibling.port);
        emitTrace('modernjs-sibling', 'Started sibling server', {
          projectPath: sibling.projectPath,
          port: sibling.port,
        });
        log?.(`Started sibling modernjs-dist server at ${bridge.getServerUrl(sibling.port)}/`);
      } catch (error) {
        emitTrace('modernjs-sibling', 'Failed to start sibling server', {
          projectPath: sibling.projectPath,
          error: String(error),
        });
        log?.(`Failed to start sibling modernjs-dist server (${sibling.projectPath}): ${String(error)}`);
      }
    }
  }

  const url = `${bridge.getServerUrl(selectedPort)}/`;
  emitTrace('server', 'Server started', {
    kind: detected.kind,
    selectedPort,
    url,
  });
  log?.(`Started ${detected.kind} server at ${url}`);

  return {
    kind: detected.kind,
    projectPath: detected.projectPath,
    serverRoot: detected.serverRoot,
    port: selectedPort,
    url,
    stop: () => {
      server.stop();
      bridge.unregisterServer(selectedPort);
      const managedAuxiliaryPorts = new Set<number>();
      for (const auxiliary of auxiliaryServers) {
        managedAuxiliaryPorts.add(auxiliary.port);
        try {
          auxiliary.server.stop();
        } catch {
          // ignore and continue unregister
        }
        bridge.unregisterServer(auxiliary.port);
      }
      for (const port of auxiliaryPorts) {
        if (managedAuxiliaryPorts.has(port)) {
          continue;
        }
        const auxServer = getServer(port);
        if (auxServer) {
          try {
            auxServer.close();
            continue;
          } catch {
            // continue with explicit unregister
          }
        }
        bridge.unregisterServer(port);
      }
      auxiliaryRuntime = undefined;
    },
    runtime: auxiliaryRuntime,
  };
}

/**
 * High-level helper:
 * GitHub URL -> import -> install -> detect -> run.
 */
export async function bootstrapAndRunGitHubProject(
  repoUrl: string,
  options: BootstrapAndRunOptions = {}
): Promise<BootstrapAndRunResult> {
  const trace = createTraceCollector(options.onTraceEvent);
  const vfs = new VirtualFS();
  const runStartedAt = Date.now();
  const durationsMs: RepoRunPhaseDurationsMs = {
    bootstrapMs: 0,
    preflightMs: 0,
    detectMs: 0,
    startMs: 0,
    totalMs: 0,
  };
  let preflight: RepoPreflightResult = {
    issues: [],
    installOverrides: {},
    hasErrors: false,
  };

  try {
    trace.emit('bootstrap', 'Starting bootstrap and run flow', { repoUrl });
    trace.emit('bootstrap', 'Initialized virtual filesystem');

    const bootstrapStartedAt = Date.now();
    const bootstrap = await bootstrapGitHubProject(vfs, repoUrl, {
      ...options,
      destPath: options.destPath || '/project',
    });
    durationsMs.bootstrapMs = Date.now() - bootstrapStartedAt;

    trace.emit('bootstrap', 'Repository bootstrap complete', {
      projectPath: bootstrap.projectPath,
      extractedFiles: bootstrap.extractedFiles.length,
      transformedProjectFiles: bootstrap.transformedProjectFiles || 0,
      archiveSource: bootstrap.cache?.archiveSource,
      snapshotReadSource: bootstrap.cache?.snapshotReadSource || 'none',
      snapshotWritten: bootstrap.cache?.snapshotWritten === true,
    });

    const preflightStartedAt = Date.now();
    const preflightMode = options.preflightMode ?? 'warn';
    preflight = preflightMode === 'off'
      ? { issues: [], installOverrides: {}, hasErrors: false }
      : runRepoPreflight(vfs, bootstrap.projectPath, {
        autoFix: false,
      });
    durationsMs.preflightMs = Date.now() - preflightStartedAt;

    if (preflightMode !== 'off') {
      for (const issue of preflight.issues) {
        trace.emit('preflight', issue.message, {
          code: issue.code,
          severity: issue.severity,
          path: issue.path,
        });
        options.log?.(`[preflight:${issue.severity}] ${issue.message}${issue.path ? ` (${issue.path})` : ''}`);
      }
      if (preflightMode === 'strict' && preflight.hasErrors) {
        const blocking = preflight.issues
          .filter(issue => issue.severity === 'error')
          .map(issue => `${issue.code}: ${issue.message}${issue.path ? ` (${issue.path})` : ''}`)
          .join('\n');
        trace.emit('preflight', 'Strict preflight failed', {
          blockingIssues: preflight.issues.filter(issue => issue.severity === 'error').length,
        });
        throw new Error(`Strict preflight failed:\n${blocking}`);
      }
    }

    const detectStartedAt = Date.now();
    const detected = detectRunnableProject(vfs, {
      projectPath: bootstrap.projectPath,
    });
    durationsMs.detectMs = Date.now() - detectStartedAt;

    trace.emit('detect', 'Detected runnable project', {
      kind: detected.kind,
      reason: detected.reason,
      projectPath: detected.projectPath,
      serverRoot: detected.serverRoot,
    });

    const externalTraceHandler = options.onTraceEvent;
    const startStartedAt = Date.now();
    const running = await startDetectedProject(vfs, detected, {
      ...options,
      onTraceEvent: (event) => {
        trace.emit(`start:${event.phase}`, event.message, event.data);
        externalTraceHandler?.(event);
      },
    });
    durationsMs.startMs = Date.now() - startStartedAt;
    durationsMs.totalMs = Date.now() - runStartedAt;

    const sloBudgetsMs = resolveRepoRunSloBudgets(options.performanceBudgetsMs);
    const slo = evaluateRepoRunSlo(durationsMs, sloBudgetsMs);
    const cache = summarizeRepoRunCache(bootstrap);
    const observability: RepoRunObservability = {
      durationsMs,
      sloBudgetsMs,
      slo,
      cache,
    };

    trace.emit('metrics', 'Run observability summary', {
      ...durationsMs,
      ...cache,
      sloPassed: slo.passed,
      sloBreaches: slo.breaches.map((breach) => ({
        metric: breach.metric,
        actualMs: breach.actualMs,
        budgetMs: breach.budgetMs,
      })),
    });
    if (!slo.passed) {
      options.log?.(
        `[slo] budget exceeded (${slo.breaches
          .map((breach) => `${breach.metric}: ${breach.actualMs}ms > ${breach.budgetMs}ms`)
          .join(', ')})`
      );
    }

    trace.emit('ready', 'Running project ready', {
      kind: running.kind,
      port: running.port,
      url: running.url,
    });
    return {
      vfs,
      bootstrap,
      preflight,
      detected,
      running,
      trace: trace.events,
      observability,
    };
  } catch (error) {
    if (error instanceof RepoRunError) {
      throw error;
    }
    durationsMs.totalMs = Date.now() - runStartedAt;
    const diagnostic = buildRepoFailureDiagnostic({
      error,
      preflightIssues: preflight.issues,
    });
    trace.emit('metrics', 'Run failed before completion', {
      ...durationsMs,
    });
    trace.emit('error', diagnostic.message, {
      code: diagnostic.code,
      phase: diagnostic.phase,
      confidence: diagnostic.confidence,
    });
    throw new RepoRunError(diagnostic, error);
  }
}
