/**
 * ViteDevServer - Vite-compatible dev server for browser environment
 * Serves files from VirtualFS with JSX/TypeScript transformation
 */

import { DevServer, DevServerOptions, ResponseData, HMRUpdate } from '../dev-server';
import { VirtualFS } from '../virtual-fs';
import { Buffer } from '../shims/stream';
import { getServer } from '../shims/http';
import { simpleHash } from '../utils/hash';
import * as path from '../shims/path';
import { addReactRefresh as _addReactRefresh } from './code-transforms';
import {
  redirectNpmImports as _redirectNpmImports,
  stripCssImports as _stripCssImports,
  type CssModuleContext,
} from './code-transforms';
import { ESBUILD_WASM_ESM_CDN, ESBUILD_WASM_BINARY_CDN, REACT_REFRESH_CDN, REACT_CDN, REACT_DOM_CDN } from '../config/cdn';

// Check if we're in a real browser environment (not jsdom or Node.js)
// jsdom has window but doesn't have ServiceWorker or SharedArrayBuffer
const isBrowser = typeof window !== 'undefined' &&
  typeof window.navigator !== 'undefined' &&
  'serviceWorker' in window.navigator;

// Window.__esbuild type is declared in src/types/external.d.ts

/**
 * Initialize esbuild-wasm for browser transforms
 * Uses window-level singleton to prevent "Cannot call initialize more than once" errors
 */
async function initEsbuild(): Promise<void> {
  if (!isBrowser) return;

  // Check if already initialized (survives HMR)
  if (window.__esbuild) {
    return;
  }

  // Check if initialization is in progress
  if (window.__esbuildInitPromise) {
    return window.__esbuildInitPromise;
  }

  window.__esbuildInitPromise = (async () => {
    try {
      const mod = await import(
        /* @vite-ignore */
        ESBUILD_WASM_ESM_CDN
      );

      const esbuildMod = mod.default || mod;

      try {
        await esbuildMod.initialize({
          wasmURL: ESBUILD_WASM_BINARY_CDN,
        });
        console.log('[ViteDevServer] esbuild-wasm initialized');
      } catch (initError) {
        // If esbuild is already initialized (e.g., from a previous HMR cycle),
        // the WASM is still loaded and the module is usable
        if (initError instanceof Error && initError.message.includes('Cannot call "initialize" more than once')) {
          console.log('[ViteDevServer] esbuild-wasm already initialized, reusing');
        } else {
          throw initError;
        }
      }

      window.__esbuild = esbuildMod;
    } catch (error) {
      console.error('[ViteDevServer] Failed to initialize esbuild:', error);
      window.__esbuildInitPromise = undefined;
      throw error;
    }
  })();

  return window.__esbuildInitPromise;
}

/**
 * Get the esbuild instance (after initialization)
 */
function getEsbuild(): typeof import('esbuild-wasm') | undefined {
  return isBrowser ? window.__esbuild : undefined;
}

export interface ViteDevServerOptions extends DevServerOptions {
  /**
   * Enable JSX transformation (default: true)
   */
  jsx?: boolean;

  /**
   * JSX factory function (default: 'React.createElement')
   */
  jsxFactory?: string;

  /**
   * JSX fragment function (default: 'React.Fragment')
   */
  jsxFragment?: string;

  /**
   * Auto-inject React import for JSX files (default: true)
   */
  jsxAutoImport?: boolean;

  /**
   * Disable HMR/React Refresh HTML + module injection.
   * Useful for compatibility with third-party templates that rely on plain Vite HTML semantics.
   */
  disableHmrInjection?: boolean;

  /**
   * Optional runtime server port used to proxy API calls (e.g. /api/*) for full-stack Vite apps.
   */
  apiProxyPort?: number;
}

/**
 * React Refresh preamble - MUST run before React is loaded
 * This script is blocking to ensure injectIntoGlobalHook runs first
 */
const REACT_REFRESH_PREAMBLE = `
<script type="module">
// Block until React Refresh is loaded and initialized
// This MUST happen before React is imported
const RefreshRuntime = await import('${REACT_REFRESH_CDN}').then(m => m.default || m);

// Hook into React BEFORE it's loaded
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshRuntime$ = RefreshRuntime;

// Track registrations for debugging
window.$RefreshRegCount$ = 0;

// Register function called by transformed modules
window.$RefreshReg$ = (type, id) => {
  window.$RefreshRegCount$++;
  RefreshRuntime.register(type, id);
};

// Signature function (simplified - always returns identity)
window.$RefreshSig$ = () => (type) => type;

console.log('[HMR] React Refresh initialized');
</script>
`;

/**
 * HMR client script injected into index.html
 * Implements the import.meta.hot API and handles HMR updates
 */
const HMR_CLIENT_SCRIPT = `
<script type="module">
(function() {
  // Track hot modules and their callbacks
  const hotModules = new Map();
  const pendingUpdates = new Map();

  // Implement import.meta.hot API (Vite-compatible)
  window.__vite_hot_context__ = function createHotContext(ownerPath) {
    // Return existing context if already created
    if (hotModules.has(ownerPath)) {
      return hotModules.get(ownerPath);
    }

    const hot = {
      // Persisted data between updates
      data: {},

      // Accept self-updates
      accept(callback) {
        hot._acceptCallback = callback;
      },

      // Cleanup before update
      dispose(callback) {
        hot._disposeCallback = callback;
      },

      // Force full reload
      invalidate() {
        location.reload();
      },

      // Prune callback (called when module is no longer imported)
      prune(callback) {
        hot._pruneCallback = callback;
      },

      // Event handlers (not implemented)
      on(event, cb) {},
      off(event, cb) {},
      send(event, data) {},

      // Internal callbacks
      _acceptCallback: null,
      _disposeCallback: null,
      _pruneCallback: null,
    };

    hotModules.set(ownerPath, hot);
    return hot;
  };

  // Listen for HMR updates via postMessage (works with sandboxed iframes)
  window.addEventListener('message', async (event) => {
    // Filter for HMR messages only
    if (!event.data || event.data.channel !== 'vite-hmr') return;
    const { type, path, timestamp } = event.data;

    if (type === 'update') {
      console.log('[HMR] Update:', path);

      if (path.endsWith('.css')) {
        // CSS hot reload - update stylesheet href
        const links = document.querySelectorAll('link[rel="stylesheet"]');
        links.forEach(link => {
          const href = link.getAttribute('href');
          if (href && href.includes(path.replace(/^\\//, ''))) {
            link.href = href.split('?')[0] + '?t=' + timestamp;
          }
        });

        // Also update any injected style tags
        const styles = document.querySelectorAll('style[data-vite-dev-id]');
        styles.forEach(style => {
          const id = style.getAttribute('data-vite-dev-id');
          if (id && id.includes(path.replace(/^\\//, ''))) {
            // Re-import the CSS module to get updated styles
            import(path + '?t=' + timestamp).catch(() => {});
          }
        });
      } else if (path.match(/\\.(jsx?|tsx?)$/)) {
        // JS/JSX hot reload with React Refresh
        await handleJSUpdate(path, timestamp);
      }
    } else if (type === 'full-reload') {
      console.log('[HMR] Full reload');
      location.reload();
    }
  });

  // Handle JS/JSX module updates
  async function handleJSUpdate(path, timestamp) {
    // Normalize path to match module keys
    const normalizedPath = path.startsWith('/') ? path : '/' + path;
    const hot = hotModules.get(normalizedPath);

    try {
      // Call dispose callback if registered
      if (hot && hot._disposeCallback) {
        hot._disposeCallback(hot.data);
      }

      // Enqueue React Refresh (batches multiple updates)
      if (window.$RefreshRuntime$) {
        pendingUpdates.set(normalizedPath, timestamp);

        // Schedule refresh after a short delay to batch updates
        if (pendingUpdates.size === 1) {
          setTimeout(async () => {
            try {
              // Re-import all pending modules
              for (const [modulePath, ts] of pendingUpdates) {
                const moduleUrl = '.' + modulePath + '?t=' + ts;
                await import(moduleUrl);
              }

              // Perform React Refresh
              window.$RefreshRuntime$.performReactRefresh();
              console.log('[HMR] Updated', pendingUpdates.size, 'module(s)');

              pendingUpdates.clear();
            } catch (error) {
              console.error('[HMR] Failed to apply update:', error);
              pendingUpdates.clear();
              location.reload();
            }
          }, 30);
        }
      } else {
        // No React Refresh available, fall back to page reload
        console.log('[HMR] React Refresh not available, reloading page');
        location.reload();
      }
    } catch (error) {
      console.error('[HMR] Update failed:', error);
      location.reload();
    }
  }

  console.log('[HMR] Client ready with React Refresh support');
})();
</script>
`;

export class ViteDevServer extends DevServer {
  private watcherCleanup: (() => void) | null = null;
  private options: ViteDevServerOptions;
  private hmrTargetWindow: Window | null = null;
  private transformCache: Map<string, { code: string; hash: string }> = new Map();
  private pathAliases: Map<string, string> = new Map();
  private jsxImportSource = 'react';
  private reactVersion = '18.2.0';
  private reactDomVersion = '18.2.0';
  private vueCompilerSfcPromise: Promise<any> | null = null;
  private svelteCompilerPromise: Promise<any> | null = null;
  private syntheticIndexEntry: string | null = null;
  private syntheticTanstackRouterEntry: string | null = null;
  private apiProxyPort: number | null = null;

  constructor(vfs: VirtualFS, options: ViteDevServerOptions) {
    super(vfs, options);
    this.options = {
      jsx: true,
      jsxFactory: 'React.createElement',
      jsxFragment: 'React.Fragment',
      jsxAutoImport: true,
      disableHmrInjection: false,
      ...options,
    };
    this.jsxImportSource = this.detectJsxImportSource();
    this.detectReactVersions();
    this.loadPathAliases();
    this.syntheticIndexEntry = this.detectSyntheticIndexEntry();
    this.apiProxyPort = typeof this.options.apiProxyPort === 'number' ? this.options.apiProxyPort : null;
  }

  /**
   * Set the target window for HMR updates (typically iframe.contentWindow)
   * This enables HMR to work with sandboxed iframes via postMessage
   */
  setHMRTarget(targetWindow: Window): void {
    this.hmrTargetWindow = targetWindow;
  }

  /**
   * Handle an incoming HTTP request
   */
  async handleRequest(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: Buffer
  ): Promise<ResponseData> {
    // Parse URL
    const urlObj = new URL(url, 'http://localhost');
    let pathname = urlObj.pathname;

    if (this.shouldProxyApiRequest(pathname)) {
      return this.proxyApiRequest(method, `${pathname}${urlObj.search}`, headers, body);
    }

    // Handle root path - serve index.html
    if (pathname === '/') {
      pathname = '/index.html';
    }

    if (pathname === '/@almostbun/tanstack-start-client-entry.js') {
      return this.serveTanstackStartClientEntryModule();
    }

    // Resolve the full path
    let isFsPathRequest = false;
    let filePath: string;
    if (pathname.startsWith('/@fs/')) {
      isFsPathRequest = true;
      filePath = `/${pathname.slice('/@fs/'.length)}`.replace(/\/+/g, '/');
    } else {
      filePath = this.resolvePath(pathname);
    }

    // Check if file exists
    if (!this.exists(filePath)) {
      const resolved = this.resolveFileWithExtension(filePath);
      if (resolved) {
        filePath = resolved;
        pathname = this.toRequestPath(filePath);
        isFsPathRequest = pathname.startsWith('/@fs/');
      } else {
      // Try with .html extension
      if (this.exists(filePath + '.html')) {
        return this.serveFile(pathname + '.html');
      }
      // Try index.html in directory
      if (this.isDirectory(filePath) && this.exists(filePath + '/index.html')) {
        return this.serveFile(pathname.endsWith('/') ? `${pathname}index.html` : `${pathname}/index.html`);
      }
      // Try extension resolution under "/index" for path-like requests
      const indexResolved = this.resolveFileWithExtension(`${filePath}/index`);
      if (indexResolved) {
        filePath = indexResolved;
        pathname = this.toRequestPath(filePath);
      } else {
        const syntheticIndexEntry = this.getSyntheticIndexEntryForPath(pathname);
        if (syntheticIndexEntry) {
          return this.serveSyntheticIndexWithHMR(syntheticIndexEntry);
        }
        return this.notFound(pathname);
      }
      }
    }

    // If it's a directory, redirect to index.html
    if (this.isDirectory(filePath)) {
      // TanStack/route-based apps can have both:
      // - a directory `/routes/foo/`
      // - a file `/routes/foo.tsx`
      // Prefer the extension-resolved file when it exists.
      const siblingResolved = this.resolveFileWithExtension(filePath);
      if (siblingResolved && siblingResolved !== filePath) {
        filePath = siblingResolved;
        pathname = this.toRequestPath(filePath);
      } else if (this.exists(filePath + '/index.html')) {
        return this.serveFile(filePath + '/index.html');
      } else {
        return this.notFound(pathname);
      }
    }

    // Check if file needs transformation (JSX/TS/SFC)
    if (this.needsTransform(pathname)) {
      return this.transformAndServe(filePath, pathname);
    }

    // Check if CSS is being imported as a module (needs to be converted to JS)
    // In browser context with ES modules, CSS imports need to be served as JS
    if (pathname.endsWith('.css')) {
      if (this.isModuleRequest(headers)) {
        return this.serveCssAsModule(filePath);
      }
      // Otherwise serve as regular CSS (e.g., <link> tags with sec-fetch-dest: style)
      return isFsPathRequest ? this.serveAbsoluteFile(filePath) : this.serveFile(pathname);
    }

    if (this.isAssetPath(pathname) && this.isModuleRequest(headers)) {
      return this.serveAssetAsModule(pathname);
    }

    if (pathname.endsWith('.json') && this.isModuleRequest(headers)) {
      return this.serveJsonAsModule(filePath);
    }

    // Check if it's HTML that needs HMR client injection
    if (pathname.endsWith('.html')) {
      return this.serveHtmlWithHMR(filePath);
    }

    // Serve static file
    return isFsPathRequest ? this.serveAbsoluteFile(filePath) : this.serveFile(pathname);
  }

  /**
   * Start file watching for HMR
   */
  startWatching(): void {
    // Watch /src directory for changes
    const srcPath = this.root === '/' ? '/src' : `${this.root}/src`;

    try {
      const watcher = this.vfs.watch(srcPath, { recursive: true }, (eventType, filename) => {
        if (eventType === 'change' && filename) {
          const fullPath = filename.startsWith('/') ? filename : `${srcPath}/${filename}`;
          this.handleFileChange(fullPath);
        }
      });

      this.watcherCleanup = () => {
        watcher.close();
      };
    } catch (error) {
      console.warn('[ViteDevServer] Could not watch /src directory:', error);
    }

    // Also watch for CSS files in root
    try {
      const rootWatcher = this.vfs.watch(this.root, { recursive: false }, (eventType, filename) => {
        if (eventType === 'change' && filename && filename.endsWith('.css')) {
          this.handleFileChange(`${this.root}/${filename}`);
        }
      });

      const originalCleanup = this.watcherCleanup;
      this.watcherCleanup = () => {
        originalCleanup?.();
        rootWatcher.close();
      };
    } catch {
      // Ignore if root watching fails
    }
  }

  /**
   * Handle file change event
   */
  private handleFileChange(path: string): void {
    // Determine update type:
    // - CSS and JS/JSX/TSX files: 'update' (handled by HMR client)
    // - Other files: 'full-reload'
    const isCSS = path.endsWith('.css');
    const isJS = /\.(jsx?|tsx?)$/.test(path);
    const updateType = (isCSS || isJS) ? 'update' : 'full-reload';

    const update: HMRUpdate = {
      type: updateType,
      path,
      timestamp: Date.now(),
    };

    // Emit event for ServerBridge
    this.emitHMRUpdate(update);

    // Send HMR update via postMessage (works with sandboxed iframes)
    if (this.hmrTargetWindow) {
      try {
        this.hmrTargetWindow.postMessage({ ...update, channel: 'vite-hmr' }, '*');
      } catch (e) {
        // Window may be closed or unavailable
      }
    }
  }

  /**
   * Stop the server
   */
  stop(): void {
    if (this.watcherCleanup) {
      this.watcherCleanup();
      this.watcherCleanup = null;
    }

    this.hmrTargetWindow = null;

    super.stop();
  }

  /**
   * Check if a file needs transformation
   */
  private needsTransform(path: string): boolean {
    return /\.(jsx|tsx|ts|vue|svelte)$/.test(path);
  }

  /**
   * Transform and serve a JSX/TS file
   */
  private async transformAndServe(filePath: string, urlPath: string): Promise<ResponseData> {
    try {
      const content = this.vfs.readFileSync(filePath, 'utf8');
      const hash = simpleHash(content);

      // Check transform cache
      const cached = this.transformCache.get(filePath);
      if (cached && cached.hash === hash) {
        const buffer = Buffer.from(cached.code);
        return {
          statusCode: 200,
          statusMessage: 'OK',
          headers: {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Content-Length': String(buffer.length),
            'Cache-Control': 'no-cache',
            'X-Transformed': 'true',
            'X-Cache': 'hit',
          },
          body: buffer,
        };
      }

      const transformed = filePath.endsWith('.vue')
        ? await this.transformVueSfc(content, filePath, urlPath)
        : filePath.endsWith('.svelte')
          ? await this.transformSvelteComponent(content, filePath, urlPath)
        : await this.transformCode(content, urlPath);

      // Cache the transform result
      this.transformCache.set(filePath, { code: transformed, hash });

      const buffer = Buffer.from(transformed);
      return {
        statusCode: 200,
        statusMessage: 'OK',
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Content-Length': String(buffer.length),
          'Cache-Control': 'no-cache',
          'X-Transformed': 'true',
        },
        body: buffer,
      };
    } catch (error) {
      console.error('[ViteDevServer] Transform error:', error);
      const message = error instanceof Error ? error.message : 'Transform failed';
      const body = `// Transform Error: ${message}\nconsole.error(${JSON.stringify(message)});`;
      return {
        statusCode: 200, // Return 200 with error in code to show in browser console
        statusMessage: 'OK',
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'X-Transform-Error': 'true',
        },
        body: Buffer.from(body),
      };
    }
  }

  private async getVueCompilerSfc(): Promise<any | null> {
    if (!isBrowser) {
      return null;
    }

    if (!this.vueCompilerSfcPromise) {
      this.vueCompilerSfcPromise = import(
        /* @vite-ignore */
        'https://esm.sh/@vue/compiler-sfc@3.5.28'
      )
        .then((mod) => mod.default || mod)
        .catch((error) => {
          console.error('[ViteDevServer] Failed to load @vue/compiler-sfc:', error);
          return null;
        });
    }

    return this.vueCompilerSfcPromise;
  }

  private normalizeVueCompilerErrors(errors: unknown[]): string {
    return errors
      .map((error) => {
        if (typeof error === 'string') return error;
        if (error instanceof Error) return error.message;
        try {
          return JSON.stringify(error);
        } catch {
          return String(error);
        }
      })
      .join('\n');
  }

  private async transformVueSfc(source: string, filePath: string, urlPath: string): Promise<string> {
    const compiler = await this.getVueCompilerSfc();
    if (!compiler) {
      return this.transformCode('const __sfc__ = {};\nexport default __sfc__;\n', `${urlPath}.ts`);
    }

    const parsed = compiler.parse(source, { filename: filePath });
    const descriptor = parsed?.descriptor;
    const parseErrors = Array.isArray(parsed?.errors) ? parsed.errors : [];
    if (parseErrors.length > 0) {
      throw new Error(this.normalizeVueCompilerErrors(parseErrors));
    }

    if (!descriptor) {
      throw new Error(`Invalid Vue SFC: ${filePath}`);
    }

    const scopeHash = simpleHash(filePath).slice(0, 8);
    const scopeId = `data-v-${scopeHash}`;
    const hasScopedStyle = Array.isArray(descriptor.styles) && descriptor.styles.some((style: any) => Boolean(style?.scoped));
    let bindingMetadata: Record<string, unknown> | undefined;

    let code = '';

    if (descriptor.script || descriptor.scriptSetup) {
      const compiledScript = compiler.compileScript(descriptor, {
        id: scopeId,
        genDefaultAs: '__sfc__',
      });
      bindingMetadata = compiledScript.bindings;
      code += `${compiledScript.content}\n`;
    } else {
      code += 'const __sfc__ = {};\n';
    }

    if (descriptor.template?.content) {
      const templateResult = compiler.compileTemplate({
        source: descriptor.template.content,
        filename: filePath,
        id: scopeId,
        scoped: hasScopedStyle,
        compilerOptions: {
          mode: 'module',
          bindingMetadata,
        },
      });
      const templateErrors = Array.isArray(templateResult?.errors) ? templateResult.errors : [];
      if (templateErrors.length > 0) {
        throw new Error(this.normalizeVueCompilerErrors(templateErrors));
      }
      code += `${templateResult.code}\n`;
      code += '__sfc__.render = render;\n';
    }

    const styles = Array.isArray(descriptor.styles) ? descriptor.styles : [];
    styles.forEach((style: any, index: number) => {
      const styleResult = compiler.compileStyle({
        source: style?.content || '',
        filename: filePath,
        id: scopeId,
        scoped: Boolean(style?.scoped),
      });
      const styleErrors = Array.isArray(styleResult?.errors) ? styleResult.errors : [];
      if (styleErrors.length > 0) {
        throw new Error(this.normalizeVueCompilerErrors(styleErrors));
      }

      const styleKey = `${filePath}:${index}`;
      const styleMarker = `almostbun-vue-style-${simpleHash(styleKey).slice(0, 12)}`;
      code += `
if (typeof document !== 'undefined' && !document.getElementById(${JSON.stringify(styleMarker)})) {
  const style = document.createElement('style');
  style.id = ${JSON.stringify(styleMarker)};
  style.setAttribute('data-almostbun-vue-style', ${JSON.stringify(styleKey)});
  style.textContent = ${JSON.stringify(styleResult.code)};
  document.head.appendChild(style);
}
`;
    });

    if (hasScopedStyle) {
      code += `__sfc__.__scopeId = ${JSON.stringify(scopeId)};\n`;
    }

    code += 'export default __sfc__;\n';

    // Feed generated module through the standard transform pipeline
    // (path aliases, bare import redirects, import.meta.env).
    return this.transformCode(code, `${urlPath}.ts`);
  }

  private async getSvelteCompiler(): Promise<any | null> {
    if (!isBrowser) {
      return null;
    }

    if (!this.svelteCompilerPromise) {
      this.svelteCompilerPromise = import(
        /* @vite-ignore */
        'https://esm.sh/svelte@5.39.6/compiler'
      )
        .then((mod) => mod.default || mod)
        .catch((error) => {
          console.error('[ViteDevServer] Failed to load Svelte compiler:', error);
          return null;
        });
    }

    return this.svelteCompilerPromise;
  }

  private async maybeTranspileSvelteTypeScript(source: string, filePath: string): Promise<string> {
    const scriptMatch = source.match(/<script\b([^>]*)>([\s\S]*?)<\/script>/i);
    if (!scriptMatch) {
      return source;
    }

    const attributes = scriptMatch[1] || '';
    if (!/\blang\s*=\s*['"]ts['"]/i.test(attributes)) {
      return source;
    }

    if (!isBrowser) {
      return source;
    }

    await initEsbuild();
    const esbuild = getEsbuild();
    if (!esbuild) {
      return source;
    }

    const transpiled = await esbuild.transform(scriptMatch[2], {
      loader: 'ts',
      format: 'esm',
      target: 'esnext',
      sourcefile: `${filePath}?svelte-script.ts`,
      sourcemap: false,
    });

    const cleanedAttributes = attributes
      .replace(/\blang\s*=\s*['"]ts['"]/i, '')
      .replace(/\s+/g, ' ')
      .trim();

    const replacement = `<script${cleanedAttributes ? ` ${cleanedAttributes}` : ''}>\n${transpiled.code}\n</script>`;
    return source.replace(scriptMatch[0], replacement);
  }

  private async transformSvelteComponent(source: string, filePath: string, urlPath: string): Promise<string> {
    const compiler = await this.getSvelteCompiler();
    if (!compiler || typeof compiler.compile !== 'function') {
      return this.transformCode('export default {};\n', `${urlPath}.js`);
    }

    const preparedSource = await this.maybeTranspileSvelteTypeScript(source, filePath);

    let result: any;
    try {
      result = compiler.compile(preparedSource, {
        filename: filePath,
        generate: 'client',
        css: 'injected',
        dev: true,
      });
    } catch {
      result = compiler.compile(preparedSource, {
        filename: filePath,
        generate: 'dom',
        css: 'injected',
        dev: true,
      });
    }

    const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
    warnings.forEach((warning: any) => {
      if (warning?.message) {
        console.warn(`[ViteDevServer] Svelte warning (${filePath}): ${warning.message}`);
      }
    });

    const jsCode = result?.js?.code;
    if (typeof jsCode !== 'string' || jsCode.length === 0) {
      throw new Error(`Svelte compile produced no JS output: ${filePath}`);
    }

    return this.transformCode(jsCode, `${urlPath}.js`);
  }

  /**
   * Transform JSX/TS code to browser-compatible JavaScript
   */
  private async transformCode(code: string, filename: string): Promise<string> {
    const codeWithTanstackClientFallback = this.rewriteTanstackStartClientModule(code, filename);
    const codeWithTanstackRouterBasepath = this.rewriteTanstackRouterBasepath(
      codeWithTanstackClientFallback,
      filename
    );

    if (!isBrowser) {
      // In non-browser environments (tests/node), esbuild isn't available.
      // Still run alias/special import rewrites so resolution behavior matches browser mode.
      const codeWithoutCssImports = this.stripCssImports(codeWithTanstackRouterBasepath, filename);
      const codeWithResolvedAliases = this.resolvePathAliases(codeWithoutCssImports, filename);
      const codeWithResolvedSpecialImports = this.resolveSpecialBareImports(
        codeWithResolvedAliases,
        filename
      );
      const codeWithEnv = this.injectImportMetaEnv(codeWithResolvedSpecialImports);
      return this.redirectNpmImports(codeWithEnv);
    }

    // Initialize esbuild if needed
    await initEsbuild();

    const esbuild = getEsbuild();
    if (!esbuild) {
      throw new Error('esbuild not available');
    }

    // Determine loader based on extension
    let loader: 'js' | 'jsx' | 'ts' | 'tsx' = 'js';
    if (filename.endsWith('.jsx')) loader = 'jsx';
    else if (filename.endsWith('.tsx')) loader = 'tsx';
    else if (filename.endsWith('.ts')) loader = 'ts';

    const codeWithoutCssImports = this.stripCssImports(codeWithTanstackRouterBasepath, filename);
    const codeWithResolvedAliases = this.resolvePathAliases(codeWithoutCssImports, filename);
    const codeWithResolvedSpecialImports = this.resolveSpecialBareImports(
      codeWithResolvedAliases,
      filename
    );

    const shouldUseSolidHyperscriptTransform =
      this.jsxImportSource === 'solid-js' && (loader === 'jsx' || loader === 'tsx');

    const result = await esbuild.transform(codeWithResolvedSpecialImports, shouldUseSolidHyperscriptTransform
      ? {
          loader,
          format: 'esm',
          target: 'esnext',
          jsx: 'transform',
          jsxFactory: 'h',
          jsxFragment: 'Fragment',
          sourcemap: 'inline',
          sourcefile: filename,
        }
      : {
          loader,
          format: 'esm', // Keep as ES modules for browser
          target: 'esnext',
          jsx: 'automatic', // Use React 17+ automatic runtime
          jsxImportSource: this.jsxImportSource,
          sourcemap: 'inline',
          sourcefile: filename,
        });

    let transformedCode = result.code;
    if (
      shouldUseSolidHyperscriptTransform &&
      !/from\s+['"]solid-js\/h['"]/.test(transformedCode)
    ) {
      transformedCode = `import h from 'solid-js/h';\nconst Fragment = (props) => props?.children ?? null;\n${transformedCode}`;
    }

    const codeWithEnv = this.injectImportMetaEnv(transformedCode);
    const codeWithCdnImports = this.redirectNpmImports(codeWithEnv);

    // Add React Refresh registration for JSX/TSX files unless explicitly disabled.
    if (!this.options.disableHmrInjection && /\.(jsx|tsx)$/.test(filename)) {
      return this.addReactRefresh(codeWithCdnImports, filename);
    }

    return codeWithCdnImports;
  }

  private rewriteTanstackStartClientModule(code: string, filename: string): string {
    if (!/\/src\/client\.(?:tsx|jsx|ts|js)$/.test(filename)) {
      return code;
    }
    if (!code.includes('@tanstack/react-start') || !code.includes('StartClient')) {
      return code;
    }

    let rewritten = code;
    rewritten = rewritten.replace(
      /import\s+\{\s*hydrateRoot\s*\}\s+from\s+['"]react-dom\/client['"]\s*;?/,
      "import { createRoot } from 'react-dom/client';"
    );
    rewritten = rewritten.replace(
      /import\s+\{\s*StartClient\s*\}\s+from\s+['"]@tanstack\/react-start['"]\s*;?/,
      "import { RouterProvider } from '@tanstack/react-router';"
    );
    rewritten = rewritten.replace(/\bStartClient\b/g, 'RouterProvider');
    rewritten = rewritten.replace(
      /hydrateRoot\s*\(\s*document\s*,/g,
      "createRoot(document.getElementById('root') || document.body).render("
    );

    return rewritten;
  }

  private rewriteTanstackRouterBasepath(code: string, _filename: string): string {
    if (!code.includes('@tanstack/react-router') || !code.includes('createRouter')) {
      return code;
    }

    if (!/\bcreateRouter\s*\(\s*\{/.test(code)) {
      return code;
    }

    // Respect user-defined base path settings.
    if (/\bcreateRouter\s*\(\s*\{[\s\S]*?\b(?:basepath|basename)\s*:/.test(code)) {
      return code;
    }

    const injection = `createRouter({
  ...((typeof window !== 'undefined' && window.location.pathname.match(/^\\/__virtual__\\/\\d+/))
    ? { basepath: window.location.pathname.match(/^\\/__virtual__\\/\\d+/)[0] }
    : {}),
`;

    return code.replace(/\bcreateRouter\s*\(\s*\{/, injection);
  }

  private addReactRefresh(code: string, filename: string): string {
    return _addReactRefresh(code, filename);
  }

  private shouldProxyApiRequest(pathname: string): boolean {
    if (!this.apiProxyPort) {
      return false;
    }
    return pathname === '/api' || pathname.startsWith('/api/');
  }

  private async proxyApiRequest(
    method: string,
    targetPath: string,
    headers: Record<string, string>,
    body?: Buffer
  ): Promise<ResponseData> {
    if (!this.apiProxyPort) {
      return this.notFound(targetPath);
    }

    const runtimeServer = getServer(this.apiProxyPort);
    if (!runtimeServer || typeof runtimeServer.handleRequest !== 'function') {
      return this.notFound(targetPath);
    }

    try {
      return await runtimeServer.handleRequest(method, targetPath, headers, body);
    } catch (error) {
      return this.serverError(error);
    }
  }

  private redirectNpmImports(code: string): string {
    const redirected = _redirectNpmImports(code);
    return this.applyReactVersionMappings(redirected);
  }

  private applyReactVersionMappings(code: string): string {
    return code
      .replace(/https:\/\/esm\.sh\/react@18\.2\.0\?dev/g, `https://esm.sh/react@${this.reactVersion}?dev`)
      .replace(/https:\/\/esm\.sh\/react@18\.2\.0&dev\/jsx-runtime/g, `https://esm.sh/react@${this.reactVersion}&dev/jsx-runtime`)
      .replace(/https:\/\/esm\.sh\/react@18\.2\.0&dev\/jsx-dev-runtime/g, `https://esm.sh/react@${this.reactVersion}&dev/jsx-dev-runtime`)
      .replace(/https:\/\/esm\.sh\/react-dom@18\.2\.0\?dev/g, `https://esm.sh/react-dom@${this.reactDomVersion}?dev`)
      .replace(/https:\/\/esm\.sh\/react-dom@18\.2\.0\/client\?dev/g, `https://esm.sh/react-dom@${this.reactDomVersion}/client?dev`);
  }

  private stripCssImports(code: string, currentFile?: string): string {
    return _stripCssImports(code, currentFile, this.getCssModuleContext());
  }

  private getCssModuleContext(): CssModuleContext {
    return {
      readFile: (filePath: string) => this.vfs.readFileSync(filePath, 'utf-8'),
      exists: (filePath: string) => this.exists(filePath),
    };
  }

  private resolveFileWithExtension(filePath: string): string | null {
    if (/\.\w+$/.test(filePath) && this.exists(filePath)) {
      return filePath;
    }

    const extensions = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.json', '.vue', '.svelte'];
    const hasJsLikeExtension = /\.(?:mjs|cjs|js)$/.test(filePath);

    if (hasJsLikeExtension) {
      const base = filePath.replace(/\.(?:mjs|cjs|js)$/, '');
      for (const ext of ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs']) {
        const candidate = `${base}${ext}`;
        if (this.exists(candidate)) {
          return candidate;
        }
      }
      for (const ext of ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs']) {
        const candidate = `${base}/index${ext}`;
        if (this.exists(candidate)) {
          return candidate;
        }
      }
    }

    for (const ext of extensions) {
      const candidate = `${filePath}${ext}`;
      if (this.exists(candidate)) {
        return candidate;
      }
    }

    for (const ext of extensions) {
      const candidate = `${filePath}/index${ext}`;
      if (this.exists(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private detectJsxImportSource(): string {
    try {
      const packageJsonPath = path.posix.join(this.root, 'package.json');
      if (!this.exists(packageJsonPath)) {
        return 'react';
      }

      const raw = this.vfs.readFileSync(packageJsonPath, 'utf8');
      const pkg = JSON.parse(raw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const names = new Set([
        ...Object.keys(pkg.dependencies || {}),
        ...Object.keys(pkg.devDependencies || {}),
      ]);

      if (names.has('preact')) {
        return 'preact';
      }
      if (names.has('solid-js')) {
        return 'solid-js';
      }
    } catch {
      // Default to React when package metadata is unavailable.
    }

    return 'react';
  }

  private normalizeSemverVersion(range: string | undefined): string | null {
    if (!range) {
      return null;
    }
    const match = range.match(/(\d+\.\d+\.\d+)/);
    if (!match) {
      return null;
    }

    // For ranges (e.g. ^19.0.0), prefer major-channel URLs (react@19)
    // to stay aligned with transitive packages that may resolve newer patches.
    if (/[\^~><=*xX]|\\|\\|/.test(range)) {
      return match[1].split('.')[0];
    }

    return match[1];
  }

  private detectReactVersions(): void {
    try {
      const packageJsonPath = path.posix.join(this.root, 'package.json');
      if (!this.exists(packageJsonPath)) {
        return;
      }

      const raw = this.vfs.readFileSync(packageJsonPath, 'utf8');
      const pkg = JSON.parse(raw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {}),
      };

      const reactVersion = this.normalizeSemverVersion(deps.react);
      const reactDomVersion = this.normalizeSemverVersion(deps['react-dom']);

      if (reactVersion) {
        this.reactVersion = reactVersion;
      }
      if (reactDomVersion) {
        this.reactDomVersion = reactDomVersion;
      } else if (reactVersion) {
        this.reactDomVersion = reactVersion;
      }
    } catch {
      // Keep defaults when package metadata is unavailable.
    }
  }

  private toRequestPath(filePath: string): string {
    if (this.root === '/') {
      return filePath.startsWith('/') ? filePath : `/${filePath}`;
    }

    const rel = path.posix.relative(this.root, filePath).replace(/\\/g, '/');
    if (!rel || rel === '.') {
      return '/';
    }

    if (rel.startsWith('..') || path.posix.isAbsolute(rel)) {
      const absolute = filePath.startsWith('/') ? filePath : `/${filePath}`;
      return `/@fs${absolute}`;
    }

    return rel.startsWith('/') ? rel : `/${rel}`;
  }

  private findNearestTsconfigPath(): string | null {
    let current = this.root || '/';
    while (true) {
      const candidate = path.posix.join(current, 'tsconfig.json');
      if (this.exists(candidate)) {
        return candidate;
      }

      if (current === '/' || current === '') {
        break;
      }
      current = path.posix.dirname(current);
    }
    return null;
  }

  private normalizeFsPath(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/').replace(/\/+/g, '/');
    return normalized.startsWith('/') ? normalized : `/${normalized}`;
  }

  private loadPathAliases(): void {
    try {
      const tsconfigPath = this.findNearestTsconfigPath();
      if (!tsconfigPath) {
        return;
      }

      const content = this.vfs.readFileSync(tsconfigPath, 'utf-8');
      const tsconfig = JSON.parse(content);
      const compilerOptions = tsconfig?.compilerOptions;
      const paths = compilerOptions?.paths;

      if (!paths || typeof paths !== 'object') {
        return;
      }

      const tsconfigDir = path.posix.dirname(tsconfigPath);
      const baseUrl = typeof compilerOptions.baseUrl === 'string' ? compilerOptions.baseUrl : '.';
      const absoluteBaseUrl = baseUrl.startsWith('/')
        ? baseUrl
        : path.posix.join(tsconfigDir, baseUrl);

      for (const [alias, targets] of Object.entries(paths)) {
        if (!Array.isArray(targets) || targets.length === 0) {
          continue;
        }
        const firstTarget = targets[0];
        if (typeof firstTarget !== 'string') {
          continue;
        }

        const aliasPrefix = alias.replace(/\*$/, '');
        if (!aliasPrefix) {
          continue;
        }

        const targetPrefix = firstTarget.replace(/\*$/, '');
        const absoluteTarget = targetPrefix.startsWith('/')
          ? targetPrefix
          : path.posix.join(absoluteBaseUrl, targetPrefix);

        this.pathAliases.set(aliasPrefix, this.normalizeFsPath(absoluteTarget));
      }
    } catch {
      // Ignore tsconfig parsing failures.
    }
  }

  private resolveAliasToImportPath(targetFsPath: string, currentFile: string): string {
    const normalizedTarget = this.normalizeFsPath(targetFsPath);
    const virtualBase = `/__virtual__/${this.port}`;
    const relativeToRoot = path.posix.relative(this.root, normalizedTarget).replace(/\\/g, '/');
    if (!relativeToRoot.startsWith('..') && !path.posix.isAbsolute(relativeToRoot)) {
      const normalized = relativeToRoot === '.' ? '' : relativeToRoot;
      return normalized ? `${virtualBase}/${normalized}` : `${virtualBase}/`;
    }
    return `${virtualBase}/@fs${normalizedTarget}`;
  }

  private resolvePathAliases(code: string, currentFile: string): string {
    if (this.pathAliases.size === 0) {
      return code;
    }

    let result = code;
    for (const [alias, target] of this.pathAliases) {
      const aliasEscaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(
        `(from\\s*['"]|import\\s*\\(\\s*['"])${aliasEscaped}([^'"]+)(['"])`,
        'g'
      );

      result = result.replace(pattern, (_match, prefix, suffix, quote) => {
        const resolvedFsPath = path.posix.join(target, suffix);
        const resolvedImportPath = this.resolveAliasToImportPath(resolvedFsPath, currentFile);
        return `${prefix}${resolvedImportPath}${quote}`;
      });
    }

    return result;
  }

  private resolveSpecialBareImports(code: string, currentFile: string): string {
    const pattern = /(from\s*['"]|import\s*\(\s*['"])([^'"]+)(['"])/g;
    return code.replace(pattern, (match, prefix, specifier, suffix) => {
      if (!this.isBareSpecifier(specifier)) {
        return match;
      }

      const resolved = this.resolveBareFileImport(specifier, currentFile);
      if (!resolved) {
        return match;
      }

      return `${prefix}${resolved}${suffix}`;
    });
  }

  private isBareSpecifier(specifier: string): boolean {
    return !specifier.startsWith('.') &&
      !specifier.startsWith('/') &&
      !specifier.startsWith('http://') &&
      !specifier.startsWith('https://') &&
      !specifier.startsWith('data:') &&
      !specifier.startsWith('/__virtual__') &&
      !specifier.startsWith('node:');
  }

  private resolveBareFileImport(specifier: string, currentFile: string): string | null {
    const currentFsPath = this.resolvePath(currentFile);
    let dir = path.posix.dirname(currentFsPath);

    while (true) {
      const candidate = path.posix.join(dir, specifier);
      const resolved = this.resolveFileWithExtension(candidate) ?? (this.isFile(candidate) ? candidate : null);
      if (resolved) {
        return this.resolveAliasToImportPath(resolved, currentFile);
      }

      if (dir === '/' || dir === '') {
        break;
      }
      dir = path.posix.dirname(dir);
    }

    return null;
  }

  private isFile(filePath: string): boolean {
    try {
      return this.vfs.statSync(filePath).isFile();
    } catch {
      return false;
    }
  }

  private injectImportMetaEnv(code: string): string {
    const envMap: Record<string, string> = {
      MODE: JSON.stringify('development'),
      DEV: 'true',
      PROD: 'false',
      SSR: 'false',
      PORT: JSON.stringify(String(this.port)),
      BASE_URL: JSON.stringify(`/__virtual__/${this.port}/`),
    };

    let result = code;
    for (const [key, value] of Object.entries(envMap)) {
      const pattern = new RegExp(`\\bimport\\.meta\\.env\\.${key}\\b`, 'g');
      result = result.replace(pattern, value);
    }

    const envObjectLiteral = `{ MODE: "development", DEV: true, PROD: false, SSR: false, PORT: ${JSON.stringify(String(this.port))}, BASE_URL: ${JSON.stringify(`/__virtual__/${this.port}/`)} }`;
    result = result.replace(/\bimport\.meta\.env\b/g, envObjectLiteral);
    return result;
  }

  private isModuleRequest(headers: Record<string, string>): boolean {
    const secFetchDest =
      headers['sec-fetch-dest'] ||
      headers['Sec-Fetch-Dest'] ||
      headers['SEC-FETCH-DEST'] ||
      '';
    return secFetchDest === 'script' || secFetchDest === 'empty' || (isBrowser && secFetchDest === '');
  }

  private isAssetPath(pathname: string): boolean {
    return /\.(svg|png|jpe?g|gif|webp|ico)$/.test(pathname);
  }

  private serveAbsoluteFile(filePath: string): ResponseData {
    try {
      const content = this.vfs.readFileSync(filePath);
      const buffer = typeof content === 'string'
        ? Buffer.from(content)
        : Buffer.from(content);
      return {
        statusCode: 200,
        statusMessage: 'OK',
        headers: {
          'Content-Type': this.getMimeType(filePath),
          'Content-Length': String(buffer.length),
          'Cache-Control': 'no-cache',
        },
        body: buffer,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return this.notFound(filePath);
      }
      return this.serverError(error);
    }
  }

  private serveJsonAsModule(filePath: string): ResponseData {
    try {
      const raw = this.vfs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const exports = Object.keys(parsed)
        .filter((key) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key))
        .map((key) => `export const ${key} = data[${JSON.stringify(key)}];`)
        .join('\n');

      const js = `const data = ${JSON.stringify(parsed)};\nexport default data;\n${exports}\n`;
      const buffer = Buffer.from(js);
      return {
        statusCode: 200,
        statusMessage: 'OK',
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Content-Length': String(buffer.length),
          'Cache-Control': 'no-cache',
        },
        body: buffer,
      };
    } catch (error) {
      return this.serverError(error);
    }
  }

  private serveAssetAsModule(pathname: string): ResponseData {
    const virtualUrl = `/__virtual__/${this.port}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
    const escapedUrl = JSON.stringify(virtualUrl);

    const code = pathname.endsWith('.svg')
      ? `
import { jsx as _jsx } from "https://esm.sh/react@18.2.0&dev/jsx-runtime";
const __url = ${escapedUrl};
function __SvgComponent(props = {}) {
  return _jsx("img", { ...props, src: __url });
}
__SvgComponent.toString = () => __url;
__SvgComponent.url = __url;
export const src = __url;
export const url = __url;
export const ReactComponent = __SvgComponent;
export default __SvgComponent;
`
      : `
const __url = ${escapedUrl};
export const src = __url;
export const url = __url;
export default __url;
`;

    const buffer = Buffer.from(code);
    return {
      statusCode: 200,
      statusMessage: 'OK',
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Content-Length': String(buffer.length),
        'Cache-Control': 'no-cache',
      },
      body: buffer,
    };
  }

  /**
   * Serve CSS file as a JavaScript module that injects styles
   * This is needed because ES module imports of CSS files need to return JS
   */
  private serveCssAsModule(filePath: string): ResponseData {
    try {
      const css = this.vfs.readFileSync(filePath, 'utf8');

      // Create JavaScript that injects the CSS into the document
      const js = `
// CSS Module: ${filePath}
const css = ${JSON.stringify(css)};
const style = document.createElement('style');
style.setAttribute('data-vite-dev-id', ${JSON.stringify(filePath)});
style.textContent = css;
document.head.appendChild(style);
export default css;
`;

      const buffer = Buffer.from(js);
      return {
        statusCode: 200,
        statusMessage: 'OK',
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Content-Length': String(buffer.length),
          'Cache-Control': 'no-cache',
        },
        body: buffer,
      };
    } catch (error) {
      return this.serverError(error);
    }
  }

  /**
   * Serve HTML file with HMR client script injected
   *
   * IMPORTANT: React Refresh preamble MUST be injected before any module scripts.
   * The preamble uses top-level await to block until React Refresh is loaded
   * and injectIntoGlobalHook is called. This ensures React Refresh hooks into
   * React BEFORE React is imported by any module.
   */
  private serveHtmlWithHMR(filePath: string): ResponseData {
    try {
      const content = this.vfs.readFileSync(filePath, 'utf8');
      return this.serveHtmlContent(content);
    } catch (error) {
      return this.serverError(error);
    }
  }

  private serveSyntheticIndexWithHMR(entryPath: string): ResponseData {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>almostbun App</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="${entryPath}"></script>
</body>
</html>`;

    return this.serveHtmlContent(html);
  }

  private serveTanstackStartClientEntryModule(): ResponseData {
    if (!this.syntheticTanstackRouterEntry) {
      return this.notFound('/@almostbun/tanstack-start-client-entry.js');
    }

    const routerImportPath = this.syntheticTanstackRouterEntry.startsWith('/__virtual__/')
      ? this.syntheticTanstackRouterEntry
      : `/__virtual__/${this.port}${this.syntheticTanstackRouterEntry}`;

    const code = `globalThis.__almostbunTanstackSyntheticStatus = 'booting';
(async () => {
  try {
    const ReactMod = await import(${JSON.stringify(`https://esm.sh/react@${this.reactVersion}?dev`)});
    const React = ReactMod.default || ReactMod;
    const reactDom = await import(${JSON.stringify(`https://esm.sh/react-dom@${this.reactDomVersion}/client?dev`)});
    const routerLib = await import('https://esm.sh/@tanstack/react-router?external=react');
    const routerModule = await import(${JSON.stringify(routerImportPath)});

    const createRoot = reactDom.createRoot;
    const RouterProvider = routerLib.RouterProvider;
    const createRouter =
      routerModule.createRouter ||
      routerModule.getRouter ||
      routerModule.default;
    if (typeof createRouter !== 'function') {
      throw new Error('TanStack router module must export createRouter/getRouter');
    }
    const router = createRouter();
    const rootElement = document.getElementById('root') || document.body;
    createRoot(rootElement).render(React.createElement(RouterProvider, { router }));
    globalThis.__almostbunTanstackSyntheticStatus = 'ok';
  } catch (error) {
    const rootElement = document.getElementById('root') || document.body;
    rootElement.textContent = String(error);
    globalThis.__almostbunTanstackSyntheticStatus = 'error';
    globalThis.__almostbunTanstackSyntheticError = String(error);
    console.error('[almostbun] TanStack synthetic entry failed', error);
  }
})();`;

    const buffer = Buffer.from(code);
    return {
      statusCode: 200,
      statusMessage: 'OK',
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Content-Length': String(buffer.length),
        'Cache-Control': 'no-cache',
      },
      body: buffer,
    };
  }

  private serveHtmlContent(html: string): ResponseData {
    let content = this.injectImportMap(html);
    content = this.rewriteAbsoluteHtmlUrls(content);

    if (!this.options.disableHmrInjection) {
      // Inject a React import map if the HTML doesn't already have one.
      // This lets seed HTML omit the esm.sh boilerplate — the platform provides it.
      if (!content.includes('"importmap"')) {
        const importMap = `<script type="importmap">
{
  "imports": {
    "react": "${REACT_CDN}?dev",
    "react/": "${REACT_CDN}&dev/",
    "react-dom": "${REACT_DOM_CDN}?dev",
    "react-dom/": "${REACT_DOM_CDN}&dev/"
  }
}
</script>`;
        if (content.includes('</head>')) {
          content = content.replace('</head>', `${importMap}\n</head>`);
        } else if (content.includes('<head>')) {
          content = content.replace('<head>', `<head>\n${importMap}`);
        }
      }
      // Inject React Refresh preamble before any app module scripts.
      // Firefox requires all <script type="importmap"> to appear before any <script type="module">,
      // so if the HTML contains an import map, inject AFTER the last one (not right after <head>).
      const importMapRegex = /<script\b[^>]*\btype\s*=\s*["']importmap["'][^>]*>[\s\S]*?<\/script>/gi;
      let lastImportMapEnd = -1;
      let match;
      while ((match = importMapRegex.exec(content)) !== null) {
        lastImportMapEnd = match.index + match[0].length;
      }

      if (lastImportMapEnd !== -1) {
        // Insert preamble right after the last import map </script>
        content = content.slice(0, lastImportMapEnd) + REACT_REFRESH_PREAMBLE + content.slice(lastImportMapEnd);
      } else if (content.includes('<head>')) {
        content = content.replace('<head>', `<head>${REACT_REFRESH_PREAMBLE}`);
      } else if (content.includes('<html')) {
        // If no <head>, inject after <html...>
        content = content.replace(/<html[^>]*>/, `$&${REACT_REFRESH_PREAMBLE}`);
      } else {
        // Prepend if no html tag
        content = REACT_REFRESH_PREAMBLE + content;
      }

      // Inject HMR client script before </head> or </body>
      if (content.includes('</head>')) {
        content = content.replace('</head>', `${HMR_CLIENT_SCRIPT}</head>`);
      } else if (content.includes('</body>')) {
        content = content.replace('</body>', `${HMR_CLIENT_SCRIPT}</body>`);
      } else {
        // Append at the end if no closing tag found
        content += HMR_CLIENT_SCRIPT;
      }
    }

    const buffer = Buffer.from(content);
    return {
      statusCode: 200,
      statusMessage: 'OK',
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': String(buffer.length),
        'Cache-Control': 'no-cache',
      },
      body: buffer,
    };
  }

  private detectSyntheticIndexEntry(): string | null {
    this.syntheticTanstackRouterEntry = null;

    const rootIndex = path.posix.join(this.root, 'index.html');
    if (this.exists(rootIndex)) {
      return null;
    }

    const candidates = [
      'src/client.tsx',
      'src/client.ts',
      'src/client.jsx',
      'src/client.js',
      'src/main.tsx',
      'src/main.ts',
      'src/main.jsx',
      'src/main.js',
      'client.tsx',
      'client.ts',
      'client.jsx',
      'client.js',
      'main.tsx',
      'main.ts',
      'main.jsx',
      'main.js',
    ];

    for (const candidate of candidates) {
      const absoluteCandidate = path.posix.join(this.root, candidate);
      if (!this.exists(absoluteCandidate) || this.isDirectory(absoluteCandidate)) {
        continue;
      }
      return this.toRequestPath(absoluteCandidate);
    }

    const packageJsonPath = path.posix.join(this.root, 'package.json');
    const hasTanStackStartDependency = (() => {
      if (!this.exists(packageJsonPath)) {
        return false;
      }
      try {
        const pkg = JSON.parse(this.vfs.readFileSync(packageJsonPath, 'utf8')) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        return Boolean(
          pkg.dependencies?.['@tanstack/react-start'] ||
          pkg.dependencies?.['@tanstack/start'] ||
          pkg.devDependencies?.['@tanstack/react-start'] ||
          pkg.devDependencies?.['@tanstack/start']
        );
      } catch {
        return false;
      }
    })();

    if (hasTanStackStartDependency) {
      const tanstackRouterCandidates = [
        'src/router.tsx',
        'src/router.ts',
        'src/router.jsx',
        'src/router.js',
      ];

      for (const candidate of tanstackRouterCandidates) {
        const absoluteCandidate = path.posix.join(this.root, candidate);
        if (!this.exists(absoluteCandidate) || this.isDirectory(absoluteCandidate)) {
          continue;
        }
        this.syntheticTanstackRouterEntry = this.toRequestPath(absoluteCandidate);
        return '/@almostbun/tanstack-start-client-entry.js';
      }
    }

    return null;
  }

  private getSyntheticIndexEntryForPath(pathname: string): string | null {
    if (!this.syntheticIndexEntry) {
      return null;
    }

    return pathname === '/index.html' ? this.syntheticIndexEntry : null;
  }

  private rewriteAbsoluteHtmlUrls(html: string): string {
    const virtualBase = `/__virtual__/${this.port}`;
    const rewriteUrl = (value: string): string => {
      if (!value.startsWith('/')) {
        return value;
      }
      if (value.startsWith('//')) {
        return value;
      }
      if (value.startsWith('/__virtual__/')) {
        return value;
      }
      // Keep Vite's own client endpoint untouched when HMR is enabled.
      if (value.startsWith('/@vite/')) {
        return value;
      }
      return `${virtualBase}${value}`;
    };

    return html.replace(
      /\b(src|href|action|poster|formaction)=(['"])([^'"]+)\2/gi,
      (full, attr, quote, value) => `${attr}=${quote}${rewriteUrl(value)}${quote}`
    );
  }

  private injectImportMap(html: string): string {
    if (html.includes('data-almostbun-importmap')) {
      return html;
    }

    const map = {
      imports: {
        react: `https://esm.sh/react@${this.reactVersion}?dev`,
        'react/jsx-runtime': `https://esm.sh/react@${this.reactVersion}&dev/jsx-runtime`,
        'react/jsx-dev-runtime': `https://esm.sh/react@${this.reactVersion}&dev/jsx-dev-runtime`,
        'react-dom': `https://esm.sh/react-dom@${this.reactDomVersion}?dev`,
        'react-dom/client': `https://esm.sh/react-dom@${this.reactDomVersion}/client?dev`,
        vue: 'https://esm.sh/vue@3.5.28?dev',
        'vue/server-renderer': 'https://esm.sh/vue@3.5.28/server-renderer?dev',
        preact: 'https://esm.sh/preact@10.27.2?dev',
        'preact/hooks': 'https://esm.sh/preact@10.27.2/hooks?dev',
        'preact/jsx-runtime': 'https://esm.sh/preact@10.27.2/jsx-runtime?dev',
        'preact/jsx-dev-runtime': 'https://esm.sh/preact@10.27.2/jsx-dev-runtime?dev',
        'solid-js': 'https://esm.sh/solid-js@1.9.9?dev',
        'solid-js/web': 'https://esm.sh/solid-js@1.9.9/web?dev',
        'solid-js/store': 'https://esm.sh/solid-js@1.9.9/store?dev',
        'solid-js/h': 'https://esm.sh/solid-js@1.9.9/h?dev',
        svelte: 'https://esm.sh/svelte@5.39.6',
        'svelte/internal': 'https://esm.sh/svelte@5.39.6/internal',
        'svelte/internal/client': 'https://esm.sh/svelte@5.39.6/internal/client',
        'svelte/store': 'https://esm.sh/svelte@5.39.6/store',
        'svelte/easing': 'https://esm.sh/svelte@5.39.6/easing',
        'svelte/motion': 'https://esm.sh/svelte@5.39.6/motion',
        'svelte/transition': 'https://esm.sh/svelte@5.39.6/transition',
      },
    };

    const script = `<script type="importmap" data-almostbun-importmap>${JSON.stringify(map)}</script>`;
    if (html.includes('<head>')) {
      return html.replace('<head>', `<head>${script}`);
    }
    if (html.includes('<html')) {
      return html.replace(/<html[^>]*>/, `$&${script}`);
    }
    return `${script}${html}`;
  }
}

export default ViteDevServer;
