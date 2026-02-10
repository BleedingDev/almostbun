/**
 * NextDevServer - Next.js-compatible dev server for browser environment
 * Implements file-based routing, API routes, and HMR
 */

import { DevServer, DevServerOptions, ResponseData, HMRUpdate } from '../dev-server';
import { VirtualFS } from '../virtual-fs';
import { Buffer } from '../shims/stream';
import { simpleHash } from '../utils/hash';
import { loadTailwindConfig } from './tailwind-config-loader';
import { parseNextConfigValue } from './next-config-parser';
import {
  redirectNpmImports as _redirectNpmImports,
  stripCssImports as _stripCssImports,
  addReactRefresh as _addReactRefresh,
  transformEsmToCjsSimple,
  type CssModuleContext,
} from './code-transforms';
import {
  NEXT_LINK_SHIM,
  NEXT_ROUTER_SHIM,
  NEXT_NAVIGATION_SHIM,
  NEXT_HEAD_SHIM,
  NEXT_IMAGE_SHIM,
  NEXT_DYNAMIC_SHIM,
  NEXT_SCRIPT_SHIM,
  NEXT_FONT_GOOGLE_SHIM,
  NEXT_FONT_LOCAL_SHIM,
} from './next-shims';
import {
  type AppRoute,
  generateAppRouterHtml as _generateAppRouterHtml,
  generatePageHtml as _generatePageHtml,
  serve404Page as _serve404Page,
} from './next-html-generator';

// Check if we're in a real browser environment (not jsdom or Node.js)
const isBrowser = typeof window !== 'undefined' &&
  typeof window.navigator !== 'undefined' &&
  'serviceWorker' in window.navigator;

// Window.__esbuild type is declared in src/types/external.d.ts

/**
 * Initialize esbuild-wasm for browser transforms
 */
async function initEsbuild(): Promise<void> {
  if (!isBrowser) return;

  if (window.__esbuild) {
    return;
  }

  if (window.__esbuildInitPromise) {
    return window.__esbuildInitPromise;
  }

  window.__esbuildInitPromise = (async () => {
    try {
      const mod = await import(
        /* @vite-ignore */
        'https://esm.sh/esbuild-wasm@0.20.0'
      );

      const esbuildMod = mod.default || mod;

      try {
        await esbuildMod.initialize({
          wasmURL: 'https://unpkg.com/esbuild-wasm@0.20.0/esbuild.wasm',
        });
        console.log('[NextDevServer] esbuild-wasm initialized');
      } catch (initError) {
        if (initError instanceof Error && initError.message.includes('Cannot call "initialize" more than once')) {
          console.log('[NextDevServer] esbuild-wasm already initialized, reusing');
        } else {
          throw initError;
        }
      }

      window.__esbuild = esbuildMod;
    } catch (error) {
      console.error('[NextDevServer] Failed to initialize esbuild:', error);
      window.__esbuildInitPromise = undefined;
      throw error;
    }
  })();

  return window.__esbuildInitPromise;
}

function getEsbuild(): typeof import('esbuild-wasm') | undefined {
  return isBrowser ? window.__esbuild : undefined;
}

export interface NextDevServerOptions extends DevServerOptions {
  /** Pages directory (default: '/pages') */
  pagesDir?: string;
  /** App directory for App Router (default: '/app') */
  appDir?: string;
  /** Public directory for static assets (default: '/public') */
  publicDir?: string;
  /** Prefer App Router over Pages Router (default: auto-detect) */
  preferAppRouter?: boolean;
  /** Environment variables (NEXT_PUBLIC_* are available in browser code via process.env) */
  env?: Record<string, string>;
  /** Asset prefix for static files (e.g., '/marketing'). Auto-detected from next.config if not specified. */
  assetPrefix?: string;
  /** Base path for the app (e.g., '/docs'). Auto-detected from next.config if not specified. */
  basePath?: string;
}

/**
 * NextDevServer - A lightweight Next.js-compatible development server
 *
 * Supports both routing paradigms:
 *
 * 1. PAGES ROUTER (legacy, /pages directory):
 *    - /pages/index.jsx        -> /
 *    - /pages/about.jsx        -> /about
 *    - /pages/users/[id].jsx   -> /users/:id (dynamic)
 *    - /pages/api/hello.js     -> /api/hello (API route)
 *    - Uses next/router for navigation
 *
 * 2. APP ROUTER (new, /app directory):
 *    - /app/page.jsx           -> /
 *    - /app/about/page.jsx     -> /about
 *    - /app/users/[id]/page.jsx -> /users/:id (dynamic)
 *    - /app/layout.jsx         -> Root layout (wraps all pages)
 *    - /app/about/layout.jsx   -> Nested layout (wraps /about/*)
 *    - Uses next/navigation for navigation
 *
 * The server auto-detects which router to use based on directory existence,
 * preferring App Router if both exist. Can be overridden via options.
 */
export class NextDevServer extends DevServer {
  /** Pages Router directory (default: '/pages') */
  private pagesDir: string;

  /** App Router directory (default: '/app') */
  private appDir: string;

  /** Static assets directory (default: '/public') */
  private publicDir: string;

  /** Whether to use App Router (true) or Pages Router (false) */
  private useAppRouter: boolean;

  /** Cleanup function for file watchers */
  private watcherCleanup: (() => void) | null = null;

  /** Target window for HMR updates (iframe contentWindow) */
  private hmrTargetWindow: Window | null = null;

  /** Store options for later access (e.g., env vars) */
  private options: NextDevServerOptions;

  /** Transform result cache for performance */
  private transformCache: Map<string, { code: string; hash: string }> = new Map();

  /** Path aliases from tsconfig.json (e.g., @/* -> ./*) */
  private pathAliases: Map<string, string> = new Map();

  /** Cached Tailwind config script (injected before CDN) */
  private tailwindConfigScript: string = '';

  /** Whether Tailwind config has been loaded */
  private tailwindConfigLoaded: boolean = false;

  /** Asset prefix for static files (e.g., '/marketing') */
  private assetPrefix: string = '';

  /** Base path for the app (e.g., '/docs') */
  private basePath: string = '';

  constructor(vfs: VirtualFS, options: NextDevServerOptions) {
    super(vfs, options);
    this.options = options;
    this.pagesDir = options.pagesDir || '/pages';
    this.appDir = options.appDir || '/app';
    this.publicDir = options.publicDir || '/public';

    // Auto-detect which router to use based on directory existence
    // User can override with preferAppRouter option
    if (options.preferAppRouter !== undefined) {
      this.useAppRouter = options.preferAppRouter;
    } else {
      // Prefer App Router if /app directory exists with a page.jsx file
      this.useAppRouter = this.hasAppRouter();
    }

    // Load path aliases from tsconfig.json
    this.loadPathAliases();

    // Load assetPrefix from options or auto-detect from next.config
    this.loadAssetPrefix(options.assetPrefix);

    // Load basePath from options or auto-detect from next.config
    this.loadBasePath(options.basePath);
  }

  /**
   * Load path aliases from tsconfig.json
   * Supports common patterns like @/* -> ./*
   */
  private loadPathAliases(): void {
    try {
      const tsconfigPath = '/tsconfig.json';
      if (!this.vfs.existsSync(tsconfigPath)) {
        return;
      }

      const content = this.vfs.readFileSync(tsconfigPath, 'utf-8');
      const tsconfig = JSON.parse(content);
      const paths = tsconfig?.compilerOptions?.paths;

      if (!paths) {
        return;
      }

      // Convert tsconfig paths to a simple alias map
      // e.g., "@/*": ["./*"] becomes "@/" -> "/"
      for (const [alias, targets] of Object.entries(paths)) {
        if (Array.isArray(targets) && targets.length > 0) {
          // Remove trailing * from alias and target
          const aliasPrefix = alias.replace(/\*$/, '');
          const targetPrefix = (targets[0] as string).replace(/\*$/, '').replace(/^\./, '');
          this.pathAliases.set(aliasPrefix, targetPrefix);
        }
      }
    } catch (e) {
      // Silently ignore tsconfig parse errors
    }
  }

  /**
   * Load a string config value from options or auto-detect from next.config.ts/js
   */
  private loadConfigStringValue(key: string, optionValue?: string): string {
    if (optionValue !== undefined) {
      let val = optionValue.startsWith('/') ? optionValue : `/${optionValue}`;
      if (val.endsWith('/')) val = val.slice(0, -1);
      return val;
    }

    try {
      const configFiles: { path: string; isTs: boolean }[] = [
        { path: '/next.config.ts', isTs: true },
        { path: '/next.config.js', isTs: false },
        { path: '/next.config.mjs', isTs: false },
      ];

      for (const { path, isTs } of configFiles) {
        if (!this.vfs.existsSync(path)) continue;
        const content = this.vfs.readFileSync(path, 'utf-8');
        const value = parseNextConfigValue(content, key, isTs);
        if (value) {
          let normalized = value.startsWith('/') ? value : `/${value}`;
          if (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
          return normalized;
        }
      }
    } catch {
      // Silently ignore config parse errors
    }

    return '';
  }

  private loadAssetPrefix(optionValue?: string): void {
    this.assetPrefix = this.loadConfigStringValue('assetPrefix', optionValue);
  }

  private loadBasePath(optionValue?: string): void {
    this.basePath = this.loadConfigStringValue('basePath', optionValue);
  }

  /**
   * Resolve path aliases in transformed code
   * Converts imports like "@/components/foo" to "/__virtual__/PORT/components/foo"
   * This ensures imports go through the virtual server instead of the main server
   */
  private resolvePathAliases(code: string, currentFile: string): string {
    if (this.pathAliases.size === 0) {
      return code;
    }

    // Get the virtual server base path
    const virtualBase = `/__virtual__/${this.port}`;

    let result = code;

    for (const [alias, target] of this.pathAliases) {
      // Match import/export statements with the alias
      // Handles: import ... from "@/...", export ... from "@/...", import("@/...")
      const aliasEscaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      // Pattern to match the alias in import/export statements
      // This matches: from "@/...", from '@/...', import("@/..."), import('@/...')
      const pattern = new RegExp(
        `(from\\s*['"]|import\\s*\\(\\s*['"])${aliasEscaped}([^'"]+)(['"])`,
        'g'
      );

      result = result.replace(pattern, (match, prefix, path, quote) => {
        // Convert alias to virtual server path
        // e.g., @/components/faq -> /__virtual__/3001/components/faq
        const resolvedPath = `${virtualBase}${target}${path}`;
        return `${prefix}${resolvedPath}${quote}`;
      });
    }

    return result;
  }

  /**
   * Set an environment variable at runtime
   * NEXT_PUBLIC_* variables will be available via process.env in browser code
   */
  setEnv(key: string, value: string): void {
    this.options.env = this.options.env || {};
    this.options.env[key] = value;
  }

  /**
   * Get current environment variables
   */
  getEnv(): Record<string, string> {
    return { ...this.options.env };
  }

  /**
   * Set the target window for HMR updates (typically iframe.contentWindow)
   * This enables HMR to work with sandboxed iframes via postMessage
   */
  setHMRTarget(targetWindow: Window): void {
    this.hmrTargetWindow = targetWindow;
  }

  /**
   * Generate a script tag that defines process.env with NEXT_PUBLIC_* variables
   * This makes environment variables available to browser code via process.env.NEXT_PUBLIC_*
   * Also includes all env variables for Server Component compatibility
   */
  private generateEnvScript(): string {
    const env = this.options.env || {};

    // Only include NEXT_PUBLIC_* vars in the HTML (client-side accessible)
    // Non-public vars should never be exposed in HTML for security
    const publicEnvVars: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (key.startsWith('NEXT_PUBLIC_')) {
        publicEnvVars[key] = value;
      }
    }

    // Always create process.env even if empty (some code checks for process.env existence)
    // This prevents "process is not defined" errors
    return `<script>
  // Environment variables (injected by NextDevServer)
  window.process = window.process || {};
  window.process.env = window.process.env || {};
  Object.assign(window.process.env, ${JSON.stringify(publicEnvVars)});
  // Next.js config values
  window.__NEXT_BASE_PATH__ = ${JSON.stringify(this.basePath)};
</script>`;
  }

  /**
   * Load Tailwind config from tailwind.config.ts and generate a script
   * that configures the Tailwind CDN at runtime
   */
  private async loadTailwindConfigIfNeeded(): Promise<string> {
    // Return cached script if already loaded
    if (this.tailwindConfigLoaded) {
      return this.tailwindConfigScript;
    }

    try {
      const result = await loadTailwindConfig(this.vfs, this.root);

      if (result.success) {
        this.tailwindConfigScript = result.configScript;
      } else if (result.error) {
        console.warn('[NextDevServer] Tailwind config warning:', result.error);
        this.tailwindConfigScript = '';
      }
    } catch (error) {
      console.warn('[NextDevServer] Failed to load tailwind.config:', error);
      this.tailwindConfigScript = '';
    }

    this.tailwindConfigLoaded = true;
    return this.tailwindConfigScript;
  }

  /**
   * Check if App Router is available
   */
  private hasAppRouter(): boolean {
    try {
      // Check if /app directory exists and has a page file
      if (!this.exists(this.appDir)) return false;

      const extensions = ['.jsx', '.tsx', '.js', '.ts'];

      // Check for root page directly
      for (const ext of extensions) {
        if (this.exists(`${this.appDir}/page${ext}`)) return true;
      }

      // Check for root page inside route groups (e.g., /app/(main)/page.tsx)
      try {
        const entries = this.vfs.readdirSync(this.appDir);
        for (const entry of entries) {
          if (/^\([^)]+\)$/.test(entry) && this.isDirectory(`${this.appDir}/${entry}`)) {
            for (const ext of extensions) {
              if (this.exists(`${this.appDir}/${entry}/page${ext}`)) return true;
            }
          }
        }
      } catch { /* ignore */ }

      // Also check for any layout.tsx which indicates App Router usage
      for (const ext of extensions) {
        if (this.exists(`${this.appDir}/layout${ext}`)) return true;
      }

      return false;
    } catch {
      return false;
    }
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
    const urlObj = new URL(url, 'http://localhost');
    let pathname = urlObj.pathname;

    // Strip virtual prefix if present (e.g., /__virtual__/3001/foo -> /foo)
    const virtualPrefixMatch = pathname.match(/^\/__virtual__\/\d+/);
    if (virtualPrefixMatch) {
      pathname = pathname.slice(virtualPrefixMatch[0].length) || '/';
    }

    // Strip assetPrefix if present (e.g., /marketing/images/foo.png -> /images/foo.png)
    // This allows static assets to be served from /public when using assetPrefix in next.config
    // Also handles double-slash case: /marketing//images/foo.png (when assetPrefix ends with /)
    if (this.assetPrefix && pathname.startsWith(this.assetPrefix)) {
      const rest = pathname.slice(this.assetPrefix.length);
      // Handle both /marketing/images and /marketing//images cases
      if (rest === '' || rest.startsWith('/')) {
        pathname = rest || '/';
        // Normalize double slashes that may occur from assetPrefix concatenation
        if (pathname.startsWith('//')) {
          pathname = pathname.slice(1);
        }
      }
    }

    // Strip basePath if present (e.g., /docs/about -> /about)
    if (this.basePath && pathname.startsWith(this.basePath)) {
      const rest = pathname.slice(this.basePath.length);
      if (rest === '' || rest.startsWith('/')) {
        pathname = rest || '/';
      }
    }

    // Serve Next.js shims
    if (pathname.startsWith('/_next/shims/')) {
      return this.serveNextShim(pathname);
    }

    // Route info endpoint for client-side navigation params extraction
    if (pathname === '/_next/route-info') {
      return this.serveRouteInfo(urlObj.searchParams.get('pathname') || '/');
    }

    // Serve page components for client-side navigation (Pages Router)
    if (pathname.startsWith('/_next/pages/')) {
      return this.servePageComponent(pathname);
    }

    // Serve app components for client-side navigation (App Router)
    if (pathname.startsWith('/_next/app/')) {
      return this.serveAppComponent(pathname);
    }

    // Static assets from /_next/static/*
    if (pathname.startsWith('/_next/static/')) {
      return this.serveStaticAsset(pathname);
    }

    // App Router API routes (route.ts/route.js) - check before Pages Router API routes
    if (this.useAppRouter) {
      const appRouteFile = this.resolveAppRouteHandler(pathname);
      if (appRouteFile) {
        return this.handleAppRouteHandler(method, pathname, headers, body, appRouteFile, urlObj.search);
      }
    }

    // Pages Router API routes: /api/*
    if (pathname.startsWith('/api/')) {
      return this.handleApiRoute(method, pathname, headers, body);
    }

    // Public directory files
    const publicPath = this.publicDir + pathname;
    if (this.exists(publicPath) && !this.isDirectory(publicPath)) {
      return this.serveFile(publicPath);
    }

    // Direct file requests (e.g., /pages/index.jsx for HMR re-imports)
    if (this.needsTransform(pathname) && this.exists(pathname)) {
      return this.transformAndServe(pathname, pathname);
    }

    // Try to resolve file with different extensions (for imports without extensions)
    // e.g., /components/faq -> /components/faq.tsx
    const resolvedFile = this.resolveFileWithExtension(pathname);
    if (resolvedFile) {
      if (this.needsTransform(resolvedFile)) {
        return this.transformAndServe(resolvedFile, pathname);
      }
      return this.serveFile(resolvedFile);
    }

    // Serve regular files directly if they exist
    if (this.exists(pathname) && !this.isDirectory(pathname)) {
      return this.serveFile(pathname);
    }

    // Page routes: everything else
    return this.handlePageRoute(pathname, urlObj.search);
  }

  /**
   * Serve Next.js shims (link, router, head, navigation)
   */
  private serveNextShim(pathname: string): ResponseData {
    const shimName = pathname.replace('/_next/shims/', '').replace('.js', '');

    let code: string;
    switch (shimName) {
      case 'link':
        code = NEXT_LINK_SHIM;
        break;
      case 'router':
        code = NEXT_ROUTER_SHIM;
        break;
      case 'head':
        code = NEXT_HEAD_SHIM;
        break;
      case 'navigation':
        code = NEXT_NAVIGATION_SHIM;
        break;
      case 'image':
        code = NEXT_IMAGE_SHIM;
        break;
      case 'dynamic':
        code = NEXT_DYNAMIC_SHIM;
        break;
      case 'script':
        code = NEXT_SCRIPT_SHIM;
        break;
      case 'font/google':
        code = NEXT_FONT_GOOGLE_SHIM;
        break;
      case 'font/local':
        code = NEXT_FONT_LOCAL_SHIM;
        break;
      default:
        return this.notFound(pathname);
    }

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
   * Serve route info for client-side navigation
   * Returns params extracted from dynamic route segments
   */
  private serveRouteInfo(pathname: string): ResponseData {
    const route = this.resolveAppRoute(pathname);

    const info = route
      ? { params: route.params, found: true }
      : { params: {}, found: false };

    const json = JSON.stringify(info);
    const buffer = Buffer.from(json);

    return {
      statusCode: 200,
      statusMessage: 'OK',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(buffer.length),
        'Cache-Control': 'no-cache',
      },
      body: buffer,
    };
  }

  /**
   * Serve static assets from /_next/static/
   */
  private serveStaticAsset(pathname: string): ResponseData {
    // Map /_next/static/* to actual file location
    const filePath = pathname.replace('/_next/static/', '/');
    if (this.exists(filePath)) {
      return this.serveFile(filePath);
    }
    return this.notFound(pathname);
  }

  /**
   * Serve page components for client-side navigation
   * Maps /_next/pages/index.js → /pages/index.jsx (transformed)
   */
  private async servePageComponent(pathname: string): Promise<ResponseData> {
    // Extract the route from /_next/pages/about.js → /about
    const route = pathname
      .replace('/_next/pages', '')
      .replace(/\.js$/, '');

    // Resolve the actual page file
    const pageFile = this.resolvePageFile(route);

    if (!pageFile) {
      return this.notFound(pathname);
    }

    // Transform and serve the page component as a JS module
    // Use the actual file path (pageFile) for both reading and determining the loader
    return this.transformAndServe(pageFile, pageFile);
  }

  /**
   * Serve app components for client-side navigation (App Router)
   * Maps /_next/app/app/about/page.js → /app/about/page.tsx (transformed)
   */
  private async serveAppComponent(pathname: string): Promise<ResponseData> {
    // Extract the file path from /_next/app prefix
    let rawFilePath = pathname.replace('/_next/app', '');
    if (rawFilePath.startsWith('/app/app/')) {
      rawFilePath = rawFilePath.replace('/app/app/', '/app/');
    }

    const appRelativePath = rawFilePath.startsWith('/app')
      ? `${this.appDir}${rawFilePath.slice('/app'.length)}`
      : rawFilePath;

    // First, try the path as-is (handles imports with explicit extensions like .tsx/.ts)
    if (this.exists(appRelativePath) && !this.isDirectory(appRelativePath)) {
      return this.transformAndServe(appRelativePath, appRelativePath);
    }

    // Strip .js extension and try different extensions
    // e.g. /_next/app/app/about/page.js → /app/about/page → /app/about/page.tsx
    const filePath = appRelativePath.replace(/\.js$/, '');

    const extensions = ['.tsx', '.jsx', '.ts', '.js'];
    for (const ext of extensions) {
      const fullPath = filePath + ext;
      if (this.exists(fullPath)) {
        return this.transformAndServe(fullPath, fullPath);
      }
    }

    return this.notFound(pathname);
  }

  /**
   * Handle API route requests
   */
  private async handleApiRoute(
    method: string,
    pathname: string,
    headers: Record<string, string>,
    body?: Buffer
  ): Promise<ResponseData> {
    // Map /api/hello → /pages/api/hello.js or .ts
    const apiFile = this.resolveApiFile(pathname);

    if (!apiFile) {
      return {
        statusCode: 404,
        statusMessage: 'Not Found',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: Buffer.from(JSON.stringify({ error: 'API route not found' })),
      };
    }

    try {
      // Read and transform the API handler to CJS for eval execution
      const code = this.vfs.readFileSync(apiFile, 'utf8');
      const transformed = await this.transformApiHandler(code, apiFile);

      // Create mock req/res objects
      const req = this.createMockRequest(method, pathname, headers, body);
      const res = this.createMockResponse();

      // Execute the handler
      await this.executeApiHandler(transformed, req, res);

      // Wait for async handlers (like those using https.get with callbacks)
      // with a reasonable timeout
      if (!res.isEnded()) {
        const timeout = new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error('API handler timeout')), 30000);
        });
        await Promise.race([res.waitForEnd(), timeout]);
      }

      return res.toResponse();
    } catch (error) {
      console.error('[NextDevServer] API error:', error);
      return {
        statusCode: 500,
        statusMessage: 'Internal Server Error',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: Buffer.from(JSON.stringify({
          error: error instanceof Error ? error.message : 'Internal Server Error'
        })),
      };
    }
  }

  /**
   * Resolve an App Router route handler (route.ts/route.js)
   * Returns the file path if found, null otherwise
   */
  private resolveAppRouteHandler(pathname: string): string | null {
    const extensions = ['.ts', '.js', '.tsx', '.jsx'];

    // Build the directory path in the app dir
    const segments = pathname === '/' ? [] : pathname.split('/').filter(Boolean);
    let dirPath = this.appDir;

    for (const segment of segments) {
      dirPath = `${dirPath}/${segment}`;
    }

    // Check for route file
    for (const ext of extensions) {
      const routePath = `${dirPath}/route${ext}`;
      if (this.exists(routePath)) {
        return routePath;
      }
    }

    // Try dynamic route resolution with route groups
    return this.resolveAppRouteHandlerDynamic(segments);
  }

  /**
   * Resolve dynamic App Router route handlers with route group support
   */
  private resolveAppRouteHandlerDynamic(segments: string[]): string | null {
    const extensions = ['.ts', '.js', '.tsx', '.jsx'];

    const tryPath = (dirPath: string, remainingSegments: string[]): string | null => {
      if (remainingSegments.length === 0) {
        for (const ext of extensions) {
          const routePath = `${dirPath}/route${ext}`;
          if (this.exists(routePath)) {
            return routePath;
          }
        }

        // Check route groups
        try {
          const entries = this.vfs.readdirSync(dirPath);
          for (const entry of entries) {
            if (/^\([^)]+\)$/.test(entry) && this.isDirectory(`${dirPath}/${entry}`)) {
              for (const ext of extensions) {
                const routePath = `${dirPath}/${entry}/route${ext}`;
                if (this.exists(routePath)) {
                  return routePath;
                }
              }
            }
          }
        } catch { /* ignore */ }

        return null;
      }

      const [current, ...rest] = remainingSegments;

      // Try exact match
      const exactPath = `${dirPath}/${current}`;
      if (this.isDirectory(exactPath)) {
        const result = tryPath(exactPath, rest);
        if (result) return result;
      }

      // Try route groups and dynamic segments
      try {
        const entries = this.vfs.readdirSync(dirPath);
        for (const entry of entries) {
          // Route groups
          if (/^\([^)]+\)$/.test(entry) && this.isDirectory(`${dirPath}/${entry}`)) {
            const groupExact = `${dirPath}/${entry}/${current}`;
            if (this.isDirectory(groupExact)) {
              const result = tryPath(groupExact, rest);
              if (result) return result;
            }
          }
          // Dynamic segments
          if (entry.startsWith('[') && entry.endsWith(']') && !entry.includes('.')) {
            const dynamicPath = `${dirPath}/${entry}`;
            if (this.isDirectory(dynamicPath)) {
              const result = tryPath(dynamicPath, rest);
              if (result) return result;
            }
          }
          // Catch-all
          if (entry.startsWith('[...') && entry.endsWith(']')) {
            const dynamicPath = `${dirPath}/${entry}`;
            if (this.isDirectory(dynamicPath)) {
              const result = tryPath(dynamicPath, []);
              if (result) return result;
            }
          }
        }
      } catch { /* ignore */ }

      return null;
    };

    return tryPath(this.appDir, segments);
  }

  /**
   * Handle App Router route handler (route.ts) requests
   * These use the Web Request/Response API pattern
   */
  private async handleAppRouteHandler(
    method: string,
    pathname: string,
    headers: Record<string, string>,
    body: Buffer | undefined,
    routeFile: string,
    search?: string
  ): Promise<ResponseData> {
    try {
      const code = this.vfs.readFileSync(routeFile, 'utf8');
      const transformed = await this.transformApiHandler(code, routeFile);

      // Create module context
      const builtinModules: Record<string, unknown> = {
        https: await import('../shims/https'),
        http: await import('../shims/http'),
        path: await import('../shims/path'),
        url: await import('../shims/url'),
        querystring: await import('../shims/querystring'),
        util: await import('../shims/util'),
        events: await import('../shims/events'),
        stream: await import('../shims/stream'),
        buffer: await import('../shims/buffer'),
        crypto: await import('../shims/crypto'),
      };

      const require = (id: string): unknown => {
        const modId = id.startsWith('node:') ? id.slice(5) : id;
        if (builtinModules[modId]) return builtinModules[modId];
        throw new Error(`Module not found: ${id}`);
      };

      const module = { exports: {} as Record<string, unknown> };
      const exports = module.exports;
      const process = {
        env: { ...this.options.env },
        cwd: () => '/',
        platform: 'browser',
        version: 'v18.0.0',
        versions: { node: '18.0.0' },
      };

      const fn = new Function('exports', 'require', 'module', 'process', transformed);
      fn(exports, require, module, process);

      // Get the handler for the HTTP method
      const methodUpper = method.toUpperCase();
      const handler = module.exports[methodUpper] || module.exports[methodUpper.toLowerCase()];

      if (typeof handler !== 'function') {
        return {
          statusCode: 405,
          statusMessage: 'Method Not Allowed',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: Buffer.from(JSON.stringify({ error: `Method ${method} not allowed` })),
        };
      }

      // Create a Web API Request object
      const requestUrl = new URL(pathname + (search || ''), 'http://localhost');
      const requestInit: RequestInit = {
        method: methodUpper,
        headers: new Headers(headers),
      };
      if (body && methodUpper !== 'GET' && methodUpper !== 'HEAD') {
        requestInit.body = body;
      }
      const request = new Request(requestUrl.toString(), requestInit);

      // Extract route params
      const route = this.resolveAppRoute(pathname);
      const params = route?.params || {};

      // Call the handler
      const response = await handler(request, { params: Promise.resolve(params) });

      // Convert Response to our format
      if (response instanceof Response) {
        const respHeaders: Record<string, string> = {};
        response.headers.forEach((value: string, key: string) => {
          respHeaders[key] = value;
        });

        const respBody = await response.text();
        return {
          statusCode: response.status,
          statusMessage: response.statusText || 'OK',
          headers: respHeaders,
          body: Buffer.from(respBody),
        };
      }

      // If the handler returned a plain object, serialize as JSON
      if (response && typeof response === 'object') {
        const json = JSON.stringify(response);
        return {
          statusCode: 200,
          statusMessage: 'OK',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: Buffer.from(json),
        };
      }

      return {
        statusCode: 200,
        statusMessage: 'OK',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: Buffer.from(String(response || '')),
      };
    } catch (error) {
      console.error('[NextDevServer] App Route handler error:', error);
      return {
        statusCode: 500,
        statusMessage: 'Internal Server Error',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: Buffer.from(JSON.stringify({
          error: error instanceof Error ? error.message : 'Internal Server Error'
        })),
      };
    }
  }

  /**
   * Handle streaming API route requests
   * This is called by the server bridge for requests that need streaming support
   */
  async handleStreamingRequest(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: Buffer | undefined,
    onStart: (statusCode: number, statusMessage: string, headers: Record<string, string>) => void,
    onChunk: (chunk: string | Uint8Array) => void,
    onEnd: () => void
  ): Promise<void> {
    const urlObj = new URL(url, 'http://localhost');
    const pathname = urlObj.pathname;

    // Only handle API routes
    if (!pathname.startsWith('/api/')) {
      onStart(404, 'Not Found', { 'Content-Type': 'application/json' });
      onChunk(JSON.stringify({ error: 'Not found' }));
      onEnd();
      return;
    }

    const apiFile = this.resolveApiFile(pathname);

    if (!apiFile) {
      onStart(404, 'Not Found', { 'Content-Type': 'application/json' });
      onChunk(JSON.stringify({ error: 'API route not found' }));
      onEnd();
      return;
    }

    try {
      const code = this.vfs.readFileSync(apiFile, 'utf8');
      const transformed = await this.transformApiHandler(code, apiFile);

      const req = this.createMockRequest(method, pathname, headers, body);
      const res = this.createStreamingMockResponse(onStart, onChunk, onEnd);

      await this.executeApiHandler(transformed, req, res);

      // Wait for the response to end
      if (!res.isEnded()) {
        const timeout = new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error('API handler timeout')), 30000);
        });
        await Promise.race([res.waitForEnd(), timeout]);
      }
    } catch (error) {
      console.error('[NextDevServer] Streaming API error:', error);
      onStart(500, 'Internal Server Error', { 'Content-Type': 'application/json' });
      onChunk(JSON.stringify({ error: error instanceof Error ? error.message : 'Internal Server Error' }));
      onEnd();
    }
  }

  /**
   * Create a streaming mock response that calls callbacks as data is written
   */
  private createStreamingMockResponse(
    onStart: (statusCode: number, statusMessage: string, headers: Record<string, string>) => void,
    onChunk: (chunk: string | Uint8Array) => void,
    onEnd: () => void
  ) {
    let statusCode = 200;
    let statusMessage = 'OK';
    const headers: Record<string, string> = {};
    let ended = false;
    let headersSent = false;
    let resolveEnded: (() => void) | null = null;

    const endedPromise = new Promise<void>((resolve) => {
      resolveEnded = resolve;
    });

    const sendHeaders = () => {
      if (!headersSent) {
        headersSent = true;
        onStart(statusCode, statusMessage, headers);
      }
    };

    const markEnded = () => {
      if (!ended) {
        sendHeaders();
        ended = true;
        onEnd();
        if (resolveEnded) resolveEnded();
      }
    };

    return {
      headersSent: false,

      status(code: number) {
        statusCode = code;
        return this;
      },
      setHeader(name: string, value: string) {
        headers[name] = value;
        return this;
      },
      getHeader(name: string) {
        return headers[name];
      },
      // Write data and stream it immediately
      write(chunk: string | Buffer): boolean {
        sendHeaders();
        const data = typeof chunk === 'string' ? chunk : chunk.toString();
        onChunk(data);
        return true;
      },
      get writable() {
        return true;
      },
      json(data: unknown) {
        headers['Content-Type'] = 'application/json; charset=utf-8';
        sendHeaders();
        onChunk(JSON.stringify(data));
        markEnded();
        return this;
      },
      send(data: string | object) {
        if (typeof data === 'object') {
          return this.json(data);
        }
        sendHeaders();
        onChunk(data);
        markEnded();
        return this;
      },
      end(data?: string) {
        if (data) {
          sendHeaders();
          onChunk(data);
        }
        markEnded();
        return this;
      },
      redirect(statusOrUrl: number | string, url?: string) {
        if (typeof statusOrUrl === 'number') {
          statusCode = statusOrUrl;
          headers['Location'] = url || '/';
        } else {
          statusCode = 307;
          headers['Location'] = statusOrUrl;
        }
        markEnded();
        return this;
      },
      isEnded() {
        return ended;
      },
      waitForEnd() {
        return endedPromise;
      },
      toResponse(): ResponseData {
        // This shouldn't be called for streaming responses
        return {
          statusCode,
          statusMessage,
          headers,
          body: Buffer.from(''),
        };
      },
    };
  }

  /**
   * Resolve API route to file path
   */
  private resolveApiFile(pathname: string): string | null {
    // Remove /api prefix and look in /pages/api
    const apiPath = pathname.replace(/^\/api/, `${this.pagesDir}/api`);

    const extensions = ['.js', '.ts', '.jsx', '.tsx'];

    for (const ext of extensions) {
      const filePath = apiPath + ext;
      if (this.exists(filePath)) {
        return filePath;
      }
    }

    // Try index file
    for (const ext of extensions) {
      const filePath = `${apiPath}/index${ext}`;
      if (this.exists(filePath)) {
        return filePath;
      }
    }

    return null;
  }

  /**
   * Create mock Next.js request object
   */
  private createMockRequest(
    method: string,
    pathname: string,
    headers: Record<string, string>,
    body?: Buffer
  ) {
    const url = new URL(pathname, 'http://localhost');

    return {
      method,
      url: pathname,
      headers,
      query: Object.fromEntries(url.searchParams),
      body: body ? JSON.parse(body.toString()) : undefined,
      cookies: this.parseCookies(headers.cookie || ''),
    };
  }

  /**
   * Parse cookie header
   */
  private parseCookies(cookieHeader: string): Record<string, string> {
    const cookies: Record<string, string> = {};
    if (!cookieHeader) return cookies;

    cookieHeader.split(';').forEach(cookie => {
      const [name, value] = cookie.trim().split('=');
      if (name && value) {
        cookies[name] = decodeURIComponent(value);
      }
    });

    return cookies;
  }

  /**
   * Create mock Next.js response object with streaming support
   */
  private createMockResponse() {
    let statusCode = 200;
    let statusMessage = 'OK';
    const headers: Record<string, string> = {};
    let responseBody = '';
    let ended = false;
    let resolveEnded: (() => void) | null = null;
    let headersSent = false;

    // Promise that resolves when response is ended
    const endedPromise = new Promise<void>((resolve) => {
      resolveEnded = resolve;
    });

    const markEnded = () => {
      if (!ended) {
        ended = true;
        if (resolveEnded) resolveEnded();
      }
    };

    return {
      // Track if headers have been sent (for streaming)
      headersSent: false,

      status(code: number) {
        statusCode = code;
        return this;
      },
      setHeader(name: string, value: string) {
        headers[name] = value;
        return this;
      },
      getHeader(name: string) {
        return headers[name];
      },
      // Write data to response body (for streaming)
      write(chunk: string | Buffer): boolean {
        if (!headersSent) {
          headersSent = true;
          this.headersSent = true;
        }
        responseBody += typeof chunk === 'string' ? chunk : chunk.toString();
        return true;
      },
      // Writable stream interface for AI SDK compatibility
      get writable() {
        return true;
      },
      json(data: unknown) {
        headers['Content-Type'] = 'application/json; charset=utf-8';
        responseBody = JSON.stringify(data);
        markEnded();
        return this;
      },
      send(data: string | object) {
        if (typeof data === 'object') {
          return this.json(data);
        }
        responseBody = data;
        markEnded();
        return this;
      },
      end(data?: string) {
        if (data) responseBody += data;
        markEnded();
        return this;
      },
      redirect(statusOrUrl: number | string, url?: string) {
        if (typeof statusOrUrl === 'number') {
          statusCode = statusOrUrl;
          headers['Location'] = url || '/';
        } else {
          statusCode = 307;
          headers['Location'] = statusOrUrl;
        }
        markEnded();
        return this;
      },
      isEnded() {
        return ended;
      },
      waitForEnd() {
        return endedPromise;
      },
      toResponse(): ResponseData {
        const buffer = Buffer.from(responseBody);
        headers['Content-Length'] = String(buffer.length);
        return {
          statusCode,
          statusMessage,
          headers,
          body: buffer,
        };
      },
    };
  }

  /**
   * Execute API handler code
   */
  private async executeApiHandler(
    code: string,
    req: ReturnType<typeof this.createMockRequest>,
    res: ReturnType<typeof this.createMockResponse>
  ): Promise<void> {
    try {
      // Create a minimal require function for built-in modules
      const builtinModules: Record<string, unknown> = {
        https: await import('../shims/https'),
        http: await import('../shims/http'),
        path: await import('../shims/path'),
        fs: await import('../shims/fs').then(m => m.createFsShim(this.vfs)),
        url: await import('../shims/url'),
        querystring: await import('../shims/querystring'),
        util: await import('../shims/util'),
        events: await import('../shims/events'),
        stream: await import('../shims/stream'),
        buffer: await import('../shims/buffer'),
        crypto: await import('../shims/crypto'),
      };

      const require = (id: string): unknown => {
        // Handle node: prefix
        const modId = id.startsWith('node:') ? id.slice(5) : id;
        if (builtinModules[modId]) {
          return builtinModules[modId];
        }
        throw new Error(`Module not found: ${id}`);
      };

      // Create module context
      const module = { exports: {} as Record<string, unknown> };
      const exports = module.exports;

      // Create process object with environment variables
      const process = {
        env: { ...this.options.env },
        cwd: () => '/',
        platform: 'browser',
        version: 'v18.0.0',
        versions: { node: '18.0.0' },
      };

      // Execute the transformed code
      // The code is already in CJS format from esbuild transform
      // Use Function constructor instead of eval with template literal
      // to avoid issues with backticks or ${} in the transformed code
      const fn = new Function('exports', 'require', 'module', 'process', code);
      fn(exports, require, module, process);

      // Get the handler - check both module.exports and module.exports.default
      let handler: unknown = module.exports.default || module.exports;

      // If handler is still an object with a default property, unwrap it
      if (typeof handler === 'object' && handler !== null && 'default' in handler) {
        handler = (handler as { default: unknown }).default;
      }

      if (typeof handler !== 'function') {
        throw new Error('No default export handler found');
      }

      // Call the handler - it may be async
      const result = (handler as (req: unknown, res: unknown) => unknown)(req, res);

      // If the handler returns a promise, wait for it
      if (result instanceof Promise) {
        await result;
      }
    } catch (error) {
      console.error('[NextDevServer] API handler error:', error);
      throw error;
    }
  }

  /**
   * Handle page route requests
   */
  private async handlePageRoute(pathname: string, search: string): Promise<ResponseData> {
    // Use App Router if available
    if (this.useAppRouter) {
      return this.handleAppRouterPage(pathname, search);
    }

    // Resolve pathname to page file (Pages Router)
    const pageFile = this.resolvePageFile(pathname);

    if (!pageFile) {
      // Try to serve 404 page if exists
      const notFoundPage = this.resolvePageFile('/404');
      if (notFoundPage) {
        const html = await this.generatePageHtml(notFoundPage, '/404');
        return {
          statusCode: 404,
          statusMessage: 'Not Found',
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
          body: Buffer.from(html),
        };
      }
      return this.serve404Page();
    }

    // Check if this is a direct request for a page file (e.g., /pages/index.jsx)
    if (this.needsTransform(pathname)) {
      return this.transformAndServe(pageFile, pathname);
    }

    // Generate HTML shell with page component
    const html = await this.generatePageHtml(pageFile, pathname);

    const buffer = Buffer.from(html);
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

  /**
   * Handle App Router page requests
   */
  private async handleAppRouterPage(pathname: string, search: string): Promise<ResponseData> {
    // Resolve the route to page and layouts
    const route = this.resolveAppRoute(pathname);

    if (!route) {
      // Try not-found page
      const notFoundRoute = this.resolveAppRoute('/not-found');
      if (notFoundRoute) {
        const html = await this.generateAppRouterHtml(notFoundRoute, '/not-found');
        return {
          statusCode: 404,
          statusMessage: 'Not Found',
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
          body: Buffer.from(html),
        };
      }
      return this.serve404Page();
    }

    const html = await this.generateAppRouterHtml(route, pathname);

    const buffer = Buffer.from(html);
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

  /**
   * Resolve App Router route to page and layout files
   */
  private resolveAppRoute(pathname: string): AppRoute | null {
    const segments = pathname === '/' ? [] : pathname.split('/').filter(Boolean);
    // Use the unified dynamic resolver which handles static, dynamic, and route groups
    return this.resolveAppDynamicRoute(pathname, segments);
  }

  /**
   * Resolve App Router routes including static, dynamic, and route groups.
   * Route groups are folders wrapped in parentheses like (marketing) that
   * don't affect the URL path but can have their own layouts.
   */
  private resolveAppDynamicRoute(
    _pathname: string,
    segments: string[]
  ): AppRoute | null {
    const extensions = ['.jsx', '.tsx', '.js', '.ts'];

    /**
     * Collect layout from a directory if it exists
     */
    const collectLayout = (dirPath: string, layouts: string[]): string[] => {
      for (const ext of extensions) {
        const layoutPath = `${dirPath}/layout${ext}`;
        if (this.exists(layoutPath) && !layouts.includes(layoutPath)) {
          return [...layouts, layoutPath];
        }
      }
      return layouts;
    };

    /**
     * Find page file in a directory
     */
    const findPage = (dirPath: string): string | null => {
      for (const ext of extensions) {
        const pagePath = `${dirPath}/page${ext}`;
        if (this.exists(pagePath)) {
          return pagePath;
        }
      }
      return null;
    };

    /**
     * Find a UI convention file (loading, error, not-found) in a directory
     */
    const findConventionFile = (dirPath: string, name: string): string | null => {
      for (const ext of extensions) {
        const filePath = `${dirPath}/${name}${ext}`;
        if (this.exists(filePath)) {
          return filePath;
        }
      }
      return null;
    };

    /**
     * Find the nearest convention file by walking up from the page directory
     */
    const findNearestConventionFile = (dirPath: string, name: string): string | null => {
      let current = dirPath;
      while (current.startsWith(this.appDir)) {
        const file = findConventionFile(current, name);
        if (file) return file;
        // Move up one directory
        const parent = current.replace(/\/[^/]+$/, '');
        if (parent === current) break;
        current = parent;
      }
      return null;
    };

    /**
     * Get route group directories (folders matching (name) pattern)
     */
    const getRouteGroups = (dirPath: string): string[] => {
      try {
        const entries = this.vfs.readdirSync(dirPath);
        return entries.filter(e => /^\([^)]+\)$/.test(e) && this.isDirectory(`${dirPath}/${e}`));
      } catch {
        return [];
      }
    };

    const tryPath = (
      dirPath: string,
      remainingSegments: string[],
      layouts: string[],
      params: Record<string, string | string[]>
    ): AppRoute | null => {
      // Check for layout at current level
      layouts = collectLayout(dirPath, layouts);

      if (remainingSegments.length === 0) {
        // Look for page file directly
        const page = findPage(dirPath);
        if (page) {
          return {
            page, layouts, params,
            loading: findNearestConventionFile(dirPath, 'loading') || undefined,
            error: findNearestConventionFile(dirPath, 'error') || undefined,
            notFound: findNearestConventionFile(dirPath, 'not-found') || undefined,
          };
        }

        // Look for page inside route groups at this level
        // e.g., /app/(marketing)/page.tsx resolves to /
        const groups = getRouteGroups(dirPath);
        for (const group of groups) {
          const groupPath = `${dirPath}/${group}`;
          const groupLayouts = collectLayout(groupPath, layouts);
          const page = findPage(groupPath);
          if (page) {
            return {
              page, layouts: groupLayouts, params,
              loading: findNearestConventionFile(groupPath, 'loading') || undefined,
              error: findNearestConventionFile(groupPath, 'error') || undefined,
              notFound: findNearestConventionFile(groupPath, 'not-found') || undefined,
            };
          }
        }

        return null;
      }

      const [current, ...rest] = remainingSegments;

      // Try exact match first
      const exactPath = `${dirPath}/${current}`;
      if (this.isDirectory(exactPath)) {
        const result = tryPath(exactPath, rest, layouts, params);
        if (result) return result;
      }

      // Try inside route groups - route groups are transparent in URL
      // e.g., /about might match /app/(marketing)/about/page.tsx
      const groups = getRouteGroups(dirPath);
      for (const group of groups) {
        const groupPath = `${dirPath}/${group}`;
        const groupLayouts = collectLayout(groupPath, layouts);

        // Try exact match inside group
        const groupExactPath = `${groupPath}/${current}`;
        if (this.isDirectory(groupExactPath)) {
          const result = tryPath(groupExactPath, rest, groupLayouts, params);
          if (result) return result;
        }

        // Try dynamic segments inside group
        try {
          const groupEntries = this.vfs.readdirSync(groupPath);
          for (const entry of groupEntries) {
            if (entry.startsWith('[...') && entry.endsWith(']')) {
              const dynamicPath = `${groupPath}/${entry}`;
              if (this.isDirectory(dynamicPath)) {
                const paramName = entry.slice(4, -1);
                const newParams = { ...params, [paramName]: [current, ...rest] };
                const result = tryPath(dynamicPath, [], groupLayouts, newParams);
                if (result) return result;
              }
            } else if (entry.startsWith('[[...') && entry.endsWith(']]')) {
              const dynamicPath = `${groupPath}/${entry}`;
              if (this.isDirectory(dynamicPath)) {
                const paramName = entry.slice(5, -2);
                const newParams = { ...params, [paramName]: [current, ...rest] };
                const result = tryPath(dynamicPath, [], groupLayouts, newParams);
                if (result) return result;
              }
            } else if (entry.startsWith('[') && entry.endsWith(']') && !entry.includes('.')) {
              const dynamicPath = `${groupPath}/${entry}`;
              if (this.isDirectory(dynamicPath)) {
                const paramName = entry.slice(1, -1);
                const newParams = { ...params, [paramName]: current };
                const result = tryPath(dynamicPath, rest, groupLayouts, newParams);
                if (result) return result;
              }
            }
          }
        } catch {
          // Group directory read failed
        }
      }

      // Try dynamic segments at current level
      try {
        const entries = this.vfs.readdirSync(dirPath);
        for (const entry of entries) {
          // Handle catch-all routes [...slug]
          if (entry.startsWith('[...') && entry.endsWith(']')) {
            const dynamicPath = `${dirPath}/${entry}`;
            if (this.isDirectory(dynamicPath)) {
              const paramName = entry.slice(4, -1);
              const newParams = { ...params, [paramName]: [current, ...rest] };
              const result = tryPath(dynamicPath, [], layouts, newParams);
              if (result) return result;
            }
          }
          // Handle optional catch-all routes [[...slug]]
          else if (entry.startsWith('[[...') && entry.endsWith(']]')) {
            const dynamicPath = `${dirPath}/${entry}`;
            if (this.isDirectory(dynamicPath)) {
              const paramName = entry.slice(5, -2);
              const newParams = { ...params, [paramName]: [current, ...rest] };
              const result = tryPath(dynamicPath, [], layouts, newParams);
              if (result) return result;
            }
          }
          // Handle single dynamic segment [param]
          else if (entry.startsWith('[') && entry.endsWith(']') && !entry.includes('.')) {
            const dynamicPath = `${dirPath}/${entry}`;
            if (this.isDirectory(dynamicPath)) {
              const paramName = entry.slice(1, -1);
              const newParams = { ...params, [paramName]: current };
              const result = tryPath(dynamicPath, rest, layouts, newParams);
              if (result) return result;
            }
          }
        }
      } catch {
        // Directory doesn't exist
      }

      return null;
    };

    // Collect root layout
    const layouts: string[] = [];
    for (const ext of extensions) {
      const rootLayout = `${this.appDir}/layout${ext}`;
      if (this.exists(rootLayout)) {
        layouts.push(rootLayout);
        break;
      }
    }

    return tryPath(this.appDir, segments, layouts, {});
  }

  /**
   * Build context object for HTML generation functions
   */
  private htmlContext() {
    return {
      port: this.port,
      exists: (path: string) => this.exists(path),
      generateEnvScript: () => this.generateEnvScript(),
      loadTailwindConfigIfNeeded: () => this.loadTailwindConfigIfNeeded(),
    };
  }

  /**
   * Generate HTML for App Router with nested layouts
   */
  private async generateAppRouterHtml(
    route: AppRoute,
    pathname: string
  ): Promise<string> {
    return _generateAppRouterHtml(this.htmlContext(), route, pathname);
  }


  /**
   * Resolve URL pathname to page file
   */
  private resolvePageFile(pathname: string): string | null {
    // Handle root path
    if (pathname === '/') {
      pathname = '/index';
    }

    const extensions = ['.jsx', '.tsx', '.js', '.ts'];

    // Try exact match: /about → /pages/about.jsx
    for (const ext of extensions) {
      const filePath = `${this.pagesDir}${pathname}${ext}`;
      if (this.exists(filePath)) {
        return filePath;
      }
    }

    // Try index file: /about → /pages/about/index.jsx
    for (const ext of extensions) {
      const filePath = `${this.pagesDir}${pathname}/index${ext}`;
      if (this.exists(filePath)) {
        return filePath;
      }
    }

    // Try dynamic route matching
    return this.resolveDynamicRoute(pathname);
  }

  /**
   * Resolve dynamic routes like /users/[id]
   */
  private resolveDynamicRoute(pathname: string): string | null {
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length === 0) return null;

    const extensions = ['.jsx', '.tsx', '.js', '.ts'];

    // Build possible paths with dynamic segments
    // e.g., /users/123 could match /pages/users/[id].jsx
    const tryPath = (dirPath: string, remainingSegments: string[]): string | null => {
      if (remainingSegments.length === 0) {
        // Try index file
        for (const ext of extensions) {
          const indexPath = `${dirPath}/index${ext}`;
          if (this.exists(indexPath)) {
            return indexPath;
          }
        }
        return null;
      }

      const [current, ...rest] = remainingSegments;

      // Try exact match first
      const exactPath = `${dirPath}/${current}`;

      // Check if it's a file
      for (const ext of extensions) {
        if (rest.length === 0 && this.exists(exactPath + ext)) {
          return exactPath + ext;
        }
      }

      // Check if it's a directory
      if (this.isDirectory(exactPath)) {
        const exactResult = tryPath(exactPath, rest);
        if (exactResult) return exactResult;
      }

      // Try dynamic segment [param]
      try {
        const entries = this.vfs.readdirSync(dirPath);
        for (const entry of entries) {
          // Check for dynamic file like [id].jsx
          for (const ext of extensions) {
            const dynamicFilePattern = /^\[([^\]]+)\]$/;
            const nameWithoutExt = entry.replace(ext, '');
            if (entry.endsWith(ext) && dynamicFilePattern.test(nameWithoutExt)) {
              // It's a dynamic file like [id].jsx
              if (rest.length === 0) {
                const filePath = `${dirPath}/${entry}`;
                if (this.exists(filePath)) {
                  return filePath;
                }
              }
            }
          }

          // Check for dynamic directory like [id]
          if (entry.startsWith('[') && entry.endsWith(']') && !entry.includes('.')) {
            const dynamicPath = `${dirPath}/${entry}`;
            if (this.isDirectory(dynamicPath)) {
              const dynamicResult = tryPath(dynamicPath, rest);
              if (dynamicResult) return dynamicResult;
            }
          }

          // Check for catch-all [...param].jsx
          for (const ext of extensions) {
            if (entry.startsWith('[...') && entry.endsWith(']' + ext)) {
              const filePath = `${dirPath}/${entry}`;
              if (this.exists(filePath)) {
                return filePath;
              }
            }
          }
        }
      } catch {
        // Directory doesn't exist
      }

      return null;
    };

    return tryPath(this.pagesDir, segments);
  }

  /**
   * Generate HTML shell for a page
   */
  private async generatePageHtml(pageFile: string, pathname: string): Promise<string> {
    return _generatePageHtml(this.htmlContext(), pageFile, pathname);
  }

  /**
   * Serve a basic 404 page
   */
  private serve404Page(): ResponseData {
    return _serve404Page(this.port);
  }

  /**
   * Try to resolve a file path by adding common extensions
   * e.g., /components/faq -> /components/faq.tsx
   * Also handles index files in directories
   */
  private resolveFileWithExtension(pathname: string): string | null {
    // If the file already has an extension and exists, return it
    if (/\.\w+$/.test(pathname) && this.exists(pathname)) {
      return pathname;
    }

    // Common extensions to try, in order of preference
    const extensions = ['.tsx', '.ts', '.jsx', '.js'];

    // Try adding extensions directly
    for (const ext of extensions) {
      const withExt = pathname + ext;
      if (this.exists(withExt)) {
        return withExt;
      }
    }

    // Try as a directory with index file
    for (const ext of extensions) {
      const indexPath = pathname + '/index' + ext;
      if (this.exists(indexPath)) {
        return indexPath;
      }
    }

    return null;
  }

  /**
   * Check if a file needs transformation
   */
  private needsTransform(path: string): boolean {
    return /\.(jsx|tsx|ts)$/.test(path);
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

      // Use filePath (with extension) for transform so loader is correctly determined
      const transformed = await this.transformCode(content, filePath);

      // Cache the transform result (LRU eviction at 500 entries)
      this.transformCache.set(filePath, { code: transformed, hash });
      if (this.transformCache.size > 500) {
        const firstKey = this.transformCache.keys().next().value;
        if (firstKey) this.transformCache.delete(firstKey);
      }

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
      console.error('[NextDevServer] Transform error:', error);
      const message = error instanceof Error ? error.message : 'Transform failed';
      const body = `// Transform Error: ${message}\nconsole.error(${JSON.stringify(message)});`;
      return {
        statusCode: 200,
        statusMessage: 'OK',
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'X-Transform-Error': 'true',
        },
        body: Buffer.from(body),
      };
    }
  }

  /**
   * Transform JSX/TS code to browser-compatible JavaScript (ESM for browser)
   */
  private async transformCode(code: string, filename: string): Promise<string> {
    if (!isBrowser) {
      // Even in non-browser mode, strip/transform CSS imports
      // so CSS module imports get replaced with class name objects
      return this.stripCssImports(code, filename);
    }

    await initEsbuild();

    const esbuild = getEsbuild();
    if (!esbuild) {
      throw new Error('esbuild not available');
    }

    // Remove CSS imports before transformation - they are handled via <link> tags
    // CSS imports in ESM would fail with MIME type errors
    const codeWithoutCssImports = this.stripCssImports(code, filename);

    // Resolve path aliases (e.g., @/ -> /) before transformation
    const codeWithResolvedAliases = this.resolvePathAliases(codeWithoutCssImports, filename);

    let loader: 'js' | 'jsx' | 'ts' | 'tsx' = 'js';
    if (filename.endsWith('.jsx')) loader = 'jsx';
    else if (filename.endsWith('.tsx')) loader = 'tsx';
    else if (filename.endsWith('.ts')) loader = 'ts';

    const result = await esbuild.transform(codeWithResolvedAliases, {
      loader,
      format: 'esm',
      target: 'esnext',
      jsx: 'automatic',
      jsxImportSource: 'react',
      sourcemap: 'inline',
      sourcefile: filename,
    });

    // Redirect bare npm imports to esm.sh CDN
    const codeWithCdnImports = this.redirectNpmImports(result.code);

    // Add React Refresh registration for JSX/TSX files
    if (/\.(jsx|tsx)$/.test(filename)) {
      return this.addReactRefresh(codeWithCdnImports, filename);
    }

    return codeWithCdnImports;
  }

  private redirectNpmImports(code: string): string {
    return _redirectNpmImports(code);
  }

  private stripCssImports(code: string, currentFile?: string): string {
    return _stripCssImports(code, currentFile, this.getCssModuleContext());
  }

  private getCssModuleContext(): CssModuleContext {
    return {
      readFile: (path: string) => this.vfs.readFileSync(path, 'utf-8'),
      exists: (path: string) => this.exists(path),
    };
  }

  /**
   * Transform API handler code to CommonJS for eval execution
   */
  private async transformApiHandler(code: string, filename: string): Promise<string> {
    // Resolve path aliases first
    const codeWithResolvedAliases = this.resolvePathAliases(code, filename);

    if (isBrowser) {
      // Use esbuild in browser
      await initEsbuild();

      const esbuild = getEsbuild();
      if (!esbuild) {
        throw new Error('esbuild not available');
      }

      let loader: 'js' | 'jsx' | 'ts' | 'tsx' = 'js';
      if (filename.endsWith('.jsx')) loader = 'jsx';
      else if (filename.endsWith('.tsx')) loader = 'tsx';
      else if (filename.endsWith('.ts')) loader = 'ts';

      const result = await esbuild.transform(codeWithResolvedAliases, {
        loader,
        format: 'cjs',  // CommonJS for eval execution
        target: 'esnext',
        platform: 'neutral',
        sourcefile: filename,
      });

      return result.code;
    }

    return transformEsmToCjsSimple(codeWithResolvedAliases);
  }

  private addReactRefresh(code: string, filename: string): string {
    return _addReactRefresh(code, filename);
  }

  /**
   * Start file watching for HMR
   */
  startWatching(): void {
    const watchers: Array<{ close: () => void }> = [];

    // Watch /pages directory
    try {
      const pagesWatcher = this.vfs.watch(this.pagesDir, { recursive: true }, (eventType, filename) => {
        if (eventType === 'change' && filename) {
          const fullPath = filename.startsWith('/') ? filename : `${this.pagesDir}/${filename}`;
          this.handleFileChange(fullPath);
        }
      });
      watchers.push(pagesWatcher);
    } catch (error) {
      console.warn('[NextDevServer] Could not watch pages directory:', error);
    }

    // Watch /app directory for App Router
    if (this.useAppRouter) {
      try {
        const appWatcher = this.vfs.watch(this.appDir, { recursive: true }, (eventType, filename) => {
          if (eventType === 'change' && filename) {
            const fullPath = filename.startsWith('/') ? filename : `${this.appDir}/${filename}`;
            this.handleFileChange(fullPath);
          }
        });
        watchers.push(appWatcher);
      } catch (error) {
        console.warn('[NextDevServer] Could not watch app directory:', error);
      }
    }

    // Watch /public directory for static assets
    try {
      const publicWatcher = this.vfs.watch(this.publicDir, { recursive: true }, (eventType, filename) => {
        if (eventType === 'change' && filename) {
          this.handleFileChange(`${this.publicDir}/${filename}`);
        }
      });
      watchers.push(publicWatcher);
    } catch {
      // Ignore if public directory doesn't exist
    }

    this.watcherCleanup = () => {
      watchers.forEach(w => w.close());
    };
  }

  /**
   * Handle file change event
   */
  private handleFileChange(path: string): void {
    const isCSS = path.endsWith('.css');
    const isJS = /\.(jsx?|tsx?)$/.test(path);
    const updateType = (isCSS || isJS) ? 'update' : 'full-reload';

    const update: HMRUpdate = {
      type: updateType,
      path,
      timestamp: Date.now(),
    };

    this.emitHMRUpdate(update);

    // Send HMR update via postMessage (works with sandboxed iframes)
    if (this.hmrTargetWindow) {
      try {
        this.hmrTargetWindow.postMessage({ ...update, channel: 'next-hmr' }, '*');
      } catch (e) {
        // Window may be closed or unavailable
      }
    }
  }

  /**
   * Override serveFile to wrap JSON files as ES modules
   * This is needed because browsers can't dynamically import raw JSON files
   */
  protected serveFile(filePath: string): ResponseData {
    // For JSON files, wrap as ES module so they can be dynamically imported
    if (filePath.endsWith('.json')) {
      try {
        const normalizedPath = this.resolvePath(filePath);
        const content = this.vfs.readFileSync(normalizedPath);

        // Properly convert content to string
        // VirtualFS may return string, Buffer, or Uint8Array
        let jsonContent: string;
        if (typeof content === 'string') {
          jsonContent = content;
        } else if (content instanceof Uint8Array) {
          // Use TextDecoder for Uint8Array (includes Buffer in browser)
          jsonContent = new TextDecoder('utf-8').decode(content);
        } else {
          // Fallback for other buffer-like objects
          jsonContent = Buffer.from(content).toString('utf-8');
        }

        // Wrap JSON as ES module
        const esModuleContent = `export default ${jsonContent};`;
        const buffer = Buffer.from(esModuleContent);

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
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return this.notFound(filePath);
        }
        return this.serverError(error);
      }
    }

    // For all other files, use the parent implementation
    return super.serveFile(filePath);
  }

  /**
   * Resolve a path (helper to access protected method from parent)
   */
  protected resolvePath(urlPath: string): string {
    // Remove query string and hash
    let path = urlPath.split('?')[0].split('#')[0];

    // Normalize path
    if (!path.startsWith('/')) {
      path = '/' + path;
    }

    // Join with root
    if (this.root !== '/') {
      path = this.root + path;
    }

    return path;
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
}

export default NextDevServer;
