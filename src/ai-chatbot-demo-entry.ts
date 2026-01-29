/**
 * Entry point for AI Chatbot Demo
 * This file is loaded by the HTML and bootstraps the demo
 */

import { VirtualFS } from './virtual-fs';
import { Runtime } from './runtime';
import { NextDevServer } from './frameworks/next-dev-server';
import { getServerBridge } from './server-bridge';
import { Buffer } from './shims/stream';
import { createAIChatbotProject } from './ai-chatbot-demo';

// DOM elements
const logsEl = document.getElementById('logs') as HTMLDivElement;
const previewContainer = document.getElementById('previewContainer') as HTMLDivElement;
const statusDot = document.getElementById('statusDot') as HTMLSpanElement;
const statusText = document.getElementById('statusText') as HTMLSpanElement;
const refreshBtn = document.getElementById('refreshBtn') as HTMLButtonElement;
const openBtn = document.getElementById('openBtn') as HTMLButtonElement;
const apiKeyInput = document.getElementById('apiKey') as HTMLInputElement;
const connectBtn = document.getElementById('connectBtn') as HTMLButtonElement;
const connectionStatus = document.getElementById('connectionStatus') as HTMLDivElement;
const connectionStatusText = document.getElementById('connectionStatusText') as HTMLSpanElement;

let serverUrl: string | null = null;
let iframe: HTMLIFrameElement | null = null;
let vfs: VirtualFS | null = null;
let devServer: NextDevServer | null = null;
let apiKeyConfigured = false;

function log(message: string, type: 'info' | 'error' | 'warn' | 'success' = 'info') {
  const line = document.createElement('div');
  const time = new Date().toLocaleTimeString();
  line.textContent = `[${time}] ${message}`;
  if (type === 'error') line.className = 'error';
  if (type === 'warn') line.className = 'warn';
  if (type === 'success') line.className = 'success';
  logsEl.appendChild(line);
  logsEl.scrollTop = logsEl.scrollHeight;
}

function setStatus(text: string, state: 'loading' | 'running' | 'error' = 'loading') {
  statusText.textContent = text;
  statusDot.className = 'status-dot ' + state;
}

/**
 * Configure the OpenAI API key
 */
function configureApiKey(apiKey: string): void {
  if (!vfs || !devServer) {
    log('Server not ready yet', 'error');
    return;
  }

  // Sanitize the API key: trim whitespace and remove non-ASCII characters
  // This prevents "String contains non ISO-8859-1 code point" errors in fetch headers
  const sanitizedKey = apiKey.trim().replace(/[^\x00-\x7F]/g, '');

  if (!sanitizedKey) {
    log('Please enter an OpenAI API key', 'error');
    return;
  }

  // Validate key format (basic check)
  if (!sanitizedKey.startsWith('sk-')) {
    log('Invalid API key format. OpenAI keys start with "sk-"', 'warn');
  }

  // Set the environment variable on the dev server
  console.log('[Entry] Setting API key, length:', sanitizedKey.length);
  console.log('[Entry] API key starts with:', sanitizedKey.substring(0, 10));
  devServer.setEnv('OPENAI_API_KEY', sanitizedKey);

  // Verify it was set correctly
  const verifyEnv = devServer.getEnv();
  console.log('[Entry] Verified env key length:', verifyEnv.OPENAI_API_KEY?.length);
  console.log('[Entry] Verified env key starts with:', verifyEnv.OPENAI_API_KEY?.substring(0, 10));

  log(`OpenAI API key configured`, 'success');

  // Update UI
  apiKeyConfigured = true;
  apiKeyInput.classList.add('connected');
  connectBtn.textContent = 'Connected';
  connectBtn.classList.add('success');
  connectionStatus.style.display = 'inline-flex';
  connectionStatusText.textContent = 'API Key Set';

  // Refresh the preview to pick up the new config
  if (iframe) {
    log('Refreshing preview...');
    const currentSrc = iframe.src;
    iframe.src = 'about:blank';
    setTimeout(() => {
      if (iframe) iframe.src = currentSrc;
    }, 100);
  }

  log('You can now start chatting with the AI!', 'success');
}

async function main() {
  try {
    setStatus('Creating virtual file system...', 'loading');
    log('Creating virtual file system...');
    vfs = new VirtualFS();

    setStatus('Setting up project...', 'loading');
    log('Creating AI Chatbot project structure...');
    createAIChatbotProject(vfs);
    log('Project files created', 'success');

    setStatus('Initializing runtime...', 'loading');
    log('Initializing runtime...');
    const runtime = new Runtime(vfs, {
      cwd: '/',
      env: { NODE_ENV: 'development' },
      onConsole: (method, args) => {
        const msg = args.map(a => String(a)).join(' ');
        if (method === 'error') log(msg, 'error');
        else if (method === 'warn') log(msg, 'warn');
        else log(msg);
      },
    });

    setStatus('Starting dev server...', 'loading');
    log('Starting Next.js dev server...');

    const port = 3003;
    devServer = new NextDevServer(vfs, {
      port,
      root: '/',
      preferAppRouter: true,
    });

    const bridge = getServerBridge();

    try {
      log('Initializing Service Worker...');
      await bridge.initServiceWorker();
      log('Service Worker ready', 'success');
    } catch (error) {
      log(`Service Worker warning: ${error}`, 'warn');
    }

    // Create HTTP server wrapper
    const httpServer = {
      listening: true,
      address: () => ({ port, address: '0.0.0.0', family: 'IPv4' }),
      async handleRequest(
        method: string,
        url: string,
        headers: Record<string, string>,
        body?: string | Buffer
      ) {
        const bodyBuffer = body
          ? typeof body === 'string' ? Buffer.from(body) : body
          : undefined;
        return devServer!.handleRequest(method, url, headers, bodyBuffer);
      },
      // Streaming request handler - forwards to devServer's streaming support
      async handleStreamingRequest(
        method: string,
        url: string,
        headers: Record<string, string>,
        body: Buffer | undefined,
        onStart: (statusCode: number, statusMessage: string, headers: Record<string, string>) => void,
        onChunk: (chunk: string | Uint8Array) => void,
        onEnd: () => void
      ) {
        return devServer!.handleStreamingRequest(method, url, headers, body, onStart, onChunk, onEnd);
      },
    };

    bridge.registerServer(httpServer as any, port);
    devServer.start();

    serverUrl = bridge.getServerUrl(port) + '/';
    log(`Server running at: ${serverUrl}`, 'success');

    setStatus('Running', 'running');

    // Show iframe
    previewContainer.innerHTML = '';
    iframe = document.createElement('iframe');
    iframe.src = serverUrl;
    iframe.id = 'preview-iframe';
    iframe.name = 'preview-iframe';
    iframe.setAttribute('sandbox', 'allow-forms allow-scripts allow-same-origin allow-popups allow-pointer-lock allow-modals allow-downloads allow-orientation-lock allow-presentation allow-popups-to-escape-sandbox');

    iframe.onload = () => {
      if (iframe?.contentWindow && devServer) {
        devServer.setHMRTarget(iframe.contentWindow);
      }
    };

    previewContainer.appendChild(iframe);

    // Enable buttons
    refreshBtn.disabled = false;
    openBtn.disabled = false;
    connectBtn.disabled = false;

    refreshBtn.onclick = () => {
      if (iframe) {
        log('Refreshing preview...');
        iframe.src = iframe.src;
      }
    };

    openBtn.onclick = () => {
      if (serverUrl) {
        window.open(serverUrl, '_blank');
      }
    };

    connectBtn.onclick = () => {
      const key = apiKeyInput.value.trim();
      configureApiKey(key);
    };

    // Allow pressing Enter to connect
    apiKeyInput.onkeydown = (e) => {
      if (e.key === 'Enter') {
        const key = apiKeyInput.value.trim();
        configureApiKey(key);
      }
    };

    log('Demo ready!', 'success');
    log('Enter your OpenAI API key and click Connect to start chatting.');
    log('Note: API calls go through a CORS proxy (corsproxy.io)');

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`Error: ${errorMessage}`, 'error');
    console.error(error);
    setStatus('Error', 'error');
  }
}

// Start the demo
main();
