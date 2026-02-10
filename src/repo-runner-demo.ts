import { VirtualFS } from './virtual-fs';
import {
  bootstrapGitHubProject,
  detectRunnableProject,
  startDetectedProject,
  type RunningProject,
} from './repo';
import { PackageManager } from './npm';
import { resetServerBridge } from './server-bridge';

type LogLevel = 'info' | 'success' | 'warn' | 'error';

const repoInput = document.getElementById('repo-url') as HTMLInputElement;
const appPathInput = document.getElementById('app-path') as HTMLInputElement;
const runButton = document.getElementById('run-button') as HTMLButtonElement;
const stopButton = document.getElementById('stop-button') as HTMLButtonElement;
const goButton = document.getElementById('go-button') as HTMLButtonElement;
const backButton = document.getElementById('back-button') as HTMLButtonElement;
const refreshButton = document.getElementById('refresh-button') as HTMLButtonElement;
const statusBadge = document.getElementById('status-badge') as HTMLSpanElement;
const frameworkBadge = document.getElementById('framework-badge') as HTMLSpanElement;
const networkBadge = document.getElementById('network-badge') as HTMLSpanElement;
const previewFrame = document.getElementById('preview-frame') as HTMLIFrameElement;
const previewEmpty = document.getElementById('preview-empty') as HTMLDivElement;
const logsContainer = document.getElementById('logs') as HTMLDivElement;

const STORAGE_REPO_KEY = 'almostbun.repoRunner.repoUrl';
const STORAGE_PATH_KEY = 'almostbun.repoRunner.appPath';

let currentVfs: VirtualFS | null = null;
let currentRun: RunningProject | null = null;
let runCounter = 0;

function appendLog(message: string, level: LogLevel = 'info'): void {
  const line = document.createElement('div');
  line.className = `log-line ${level}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logsContainer.appendChild(line);
  logsContainer.scrollTop = logsContainer.scrollHeight;
}

function setStatus(text: string, tone: 'idle' | 'busy' | 'ok' | 'error'): void {
  statusBadge.textContent = text;
  statusBadge.className = `badge ${tone}`;
}

function setFramework(text: string): void {
  frameworkBadge.textContent = text;
}

function updateNetworkBadge(): void {
  const online = navigator.onLine;
  networkBadge.textContent = online ? 'Online' : 'Offline';
  networkBadge.className = `badge ${online ? 'ok' : 'warn'}`;
}

function normalizeAppPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '/';

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      return `${parsed.pathname || '/'}${parsed.search}${parsed.hash}`;
    } catch {
      return '/';
    }
  }

  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function composePreviewUrl(baseUrl: string, appPath: string): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${normalizedBase}${normalizeAppPath(appPath)}`;
}

function syncAppPathFromFrame(): void {
  if (!currentRun) return;

  try {
    const frameUrl = new URL(previewFrame.contentWindow?.location.href || previewFrame.src);
    const prefix = `/__virtual__/${currentRun.port}`;
    let appPath = frameUrl.pathname;
    if (appPath.startsWith(prefix)) {
      appPath = appPath.slice(prefix.length) || '/';
    }
    appPathInput.value = `${appPath}${frameUrl.search}${frameUrl.hash}`;
  } catch {
    // Ignore frame URL parsing errors
  }
}

function showPreview(): void {
  previewEmpty.style.display = 'none';
  previewFrame.style.display = 'block';
}

function hidePreview(): void {
  previewFrame.style.display = 'none';
  previewEmpty.style.display = 'flex';
}

function setBusyState(isBusy: boolean): void {
  runButton.disabled = isBusy;
  repoInput.disabled = isBusy;
  goButton.disabled = isBusy || !currentRun;
  stopButton.disabled = isBusy || !currentRun;
}

function stopCurrentRun(reason: string = 'Stopped'): void {
  if (currentRun) {
    try {
      currentRun.stop();
    } catch (error) {
      appendLog(`Warning while stopping: ${String(error)}`, 'warn');
    }
  }

  currentRun = null;
  currentVfs = null;
  frameworkBadge.textContent = 'Not started';
  previewFrame.src = 'about:blank';
  hidePreview();
  setStatus(reason, 'idle');
  setBusyState(false);
}

async function navigatePreview(): Promise<void> {
  if (!currentRun) return;

  const pathValue = normalizeAppPath(appPathInput.value);
  localStorage.setItem(STORAGE_PATH_KEY, pathValue);
  previewFrame.src = composePreviewUrl(currentRun.url, pathValue);
  showPreview();
}

async function runRepository(): Promise<void> {
  const url = repoInput.value.trim();
  if (!url) {
    appendLog('Repository URL is required', 'error');
    setStatus('Missing URL', 'error');
    return;
  }

  runCounter += 1;
  const thisRun = runCounter;

  stopCurrentRun('Preparing');
  setBusyState(true);
  setStatus('Importing repository…', 'busy');
  appendLog(`Bootstrapping ${url}`);
  localStorage.setItem(STORAGE_REPO_KEY, url);

  try {
    resetServerBridge();
    const vfs = new VirtualFS();
    currentVfs = vfs;

    const bootstrap = await bootstrapGitHubProject(vfs, url, {
      destPath: '/project',
      includeDev: false,
      includeOptional: true,
      includeWorkspaces: true,
      preferPublishedWorkspacePackages: true,
      transform: true,
      transformProjectSources: false,
      onProgress: (message) => appendLog(message),
    });

    if (thisRun !== runCounter) return;

    appendLog(`Project imported to ${bootstrap.projectPath}`, 'success');
    let detected;
    try {
      detected = detectRunnableProject(vfs, {
        projectPath: bootstrap.projectPath,
      });
    } catch (initialDetectError) {
      const initialMessage = initialDetectError instanceof Error
        ? initialDetectError.message
        : String(initialDetectError);
      appendLog(`Primary detection failed: ${initialMessage}`, 'warn');
      appendLog('Retrying install with devDependencies for tooling-based apps...', 'warn');

      const manager = new PackageManager(vfs, { cwd: bootstrap.projectPath });
      await manager.installFromPackageJson({
        includeDev: true,
        includeOptional: true,
        includeWorkspaces: true,
        preferPublishedWorkspacePackages: true,
        transform: true,
        onProgress: (message) => appendLog(message),
      });

      detected = detectRunnableProject(vfs, {
        projectPath: bootstrap.projectPath,
      });
    }
    appendLog(detected.reason, 'success');

    setStatus(`Starting ${detected.kind}…`, 'busy');
    const running = await startDetectedProject(vfs, detected, {
      env: {
        NODE_ENV: 'development',
        NAPI_RS_FORCE_WASI: '1',
      },
      disableViteHmrInjection: true,
      log: (message) => appendLog(message),
    });

    if (thisRun !== runCounter) {
      running.stop();
      return;
    }

    currentRun = running;
    setFramework(`${running.kind} (${running.port})`);
    setStatus('Running', 'ok');
    appendLog(`Server ready at ${running.url}`, 'success');

    await navigatePreview();
    setBusyState(false);
    stopButton.disabled = false;
    goButton.disabled = false;
  } catch (error) {
    if (thisRun !== runCounter) return;
    const message = error instanceof Error ? error.message : String(error);
    appendLog(message, 'error');
    setStatus('Failed', 'error');
    setBusyState(false);
    frameworkBadge.textContent = 'Failed';
  }
}

function wireEvents(): void {
  runButton.addEventListener('click', () => {
    runRepository();
  });

  stopButton.addEventListener('click', () => {
    stopCurrentRun('Stopped');
  });

  goButton.addEventListener('click', () => {
    navigatePreview();
  });

  appPathInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      navigatePreview();
    }
  });

  repoInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      runRepository();
    }
  });

  backButton.addEventListener('click', () => {
    try {
      previewFrame.contentWindow?.history.back();
    } catch {
      // Ignore
    }
  });

  refreshButton.addEventListener('click', () => {
    try {
      previewFrame.contentWindow?.location.reload();
    } catch {
      if (currentRun) {
        previewFrame.src = composePreviewUrl(currentRun.url, appPathInput.value);
      }
    }
  });

  previewFrame.addEventListener('load', () => {
    syncAppPathFromFrame();
  });

  window.addEventListener('online', updateNetworkBadge);
  window.addEventListener('offline', updateNetworkBadge);
}

function initFromStoredState(): void {
  const params = new URLSearchParams(window.location.search);
  const paramRepo = params.get('repo');
  const paramPath = params.get('path');
  const autoStart = params.get('run') === '1';

  const savedRepo = localStorage.getItem(STORAGE_REPO_KEY);
  const savedPath = localStorage.getItem(STORAGE_PATH_KEY);

  repoInput.value = paramRepo || savedRepo || 'https://github.com/mdn/beginner-html-site-styled';
  appPathInput.value = paramPath || savedPath || '/';

  if (autoStart && repoInput.value.trim()) {
    runRepository();
  }
}

function init(): void {
  wireEvents();
  hidePreview();
  setStatus('Idle', 'idle');
  setFramework('Not started');
  updateNetworkBadge();
  initFromStoredState();
  appendLog('Ready. Paste a GitHub URL and click Run.', 'success');
}

init();
