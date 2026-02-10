/**
 * ModernJsDistServer
 *
 * Serves a Modern.js production dist directory from VirtualFS and executes
 * dist/api handlers (lambda + effect) in the runtime.
 */

import { DevServer, DevServerOptions, ResponseData } from '../dev-server';
import { VirtualFS } from '../virtual-fs';
import { Buffer } from '../shims/stream';
import * as path from '../shims/path';
import { Runtime } from '../runtime';
import {
  createEffectBffRouter,
  type EffectBffRouter,
} from '../shims/modernjs-effect-server';

type LambdaHandler = (request: Request) => Promise<unknown>;

export interface ModernJsDistServerOptions extends DevServerOptions {
  /**
   * Dist root in VFS.
   * @default '/dist'
   */
  root?: string;

  /**
   * process.env for API runtime execution.
   */
  env?: Record<string, string>;

  /**
   * Explicit string replacements applied to JS/JSON/HTML/CSS responses.
   * Useful to rewrite remote origins in MF manifests/chunks.
   */
  originRewriteMap?: Record<string, string>;

  /**
   * Rewrite http://localhost:PORT and http://127.0.0.1:PORT to /__virtual__/PORT.
   * @default true
   */
  rewriteLocalhostToVirtual?: boolean;

  /**
   * Add permissive CORS headers to responses (needed for MF remote assets).
   * @default true
   */
  cors?: boolean;
}

interface RouteJsonEntry {
  urlPath?: string;
  entryPath?: string;
  isApi?: boolean;
}

interface RouteJson {
  routes?: RouteJsonEntry[];
}

function normalizePathname(pathname: string): string {
  if (!pathname) {
    return '/';
  }

  if (!pathname.startsWith('/')) {
    pathname = `/${pathname}`;
  }

  if (pathname !== '/' && pathname.endsWith('/')) {
    return pathname.slice(0, -1);
  }

  return pathname;
}

function hasExtension(pathname: string): boolean {
  return /\.[a-zA-Z0-9]+$/.test(pathname);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toHeaderRecord(headers: Record<string, string>): Headers {
  const out = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    out.set(key, value);
  }
  return out;
}

function shouldIncludeBody(method: string): boolean {
  const upper = method.toUpperCase();
  return upper !== 'GET' && upper !== 'HEAD';
}

function isTextLikeFile(filePath: string): boolean {
  return /\.(html?|css|js|mjs|cjs|json|map|txt|xml|svg)$/i.test(filePath);
}

function normalizeApiPrefix(prefix: string): string {
  const normalized = normalizePathname(prefix);
  return normalized === '/' ? normalized : normalized.replace(/\/+$/, '');
}

function toJsonResponse(data: unknown, statusCode: number = 200): ResponseData {
  const bodyString = JSON.stringify(data);
  const body = Buffer.from(bodyString);
  return {
    statusCode,
    statusMessage: statusCode === 200 ? 'OK' : statusCode === 404 ? 'Not Found' : 'Internal Server Error',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(body.length),
      'Cache-Control': 'no-cache',
    },
    body,
  };
}

export class ModernJsDistServer extends DevServer {
  private readonly distRoot: string;
  private readonly runtime: Runtime;
  private readonly apiPrefixes: string[] = [];
  private readonly lambdaHandlers: Map<string, LambdaHandler> = new Map();
  private effectRouter: EffectBffRouter | null = null;
  private rootEntryPath: string = '/html/index/index.html';
  private readonly originRewriteMap: Record<string, string>;
  private readonly rewriteLocalhostToVirtual: boolean;
  private readonly enableCors: boolean;

  constructor(vfs: VirtualFS, options: ModernJsDistServerOptions) {
    const root = options.root || '/dist';
    super(vfs, { ...options, root });

    this.distRoot = normalizePathname(root);
    this.originRewriteMap = options.originRewriteMap || {};
    this.rewriteLocalhostToVirtual = options.rewriteLocalhostToVirtual !== false;
    this.enableCors = options.cors !== false;

    const env = {
      NODE_ENV: 'production',
      ...options.env,
    };

    this.runtime = new Runtime(vfs, {
      cwd: this.distRoot,
      env,
    });

    this.loadRouteConfig();
    this.loadLambdaHandlers();
    this.loadEffectHandlers();
  }

  startWatching(): void {
    // Dist server is static; no-op.
  }

  async handleRequest(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: Buffer
  ): Promise<ResponseData> {
    const urlObj = new URL(url, `http://localhost:${this.port}`);
    const pathname = normalizePathname(urlObj.pathname);
    const normalizedMethod = method.toUpperCase();

    if (normalizedMethod === 'OPTIONS') {
      return this.withCorsHeaders({
        statusCode: 204,
        statusMessage: 'No Content',
        headers: {
          'Content-Length': '0',
          'Cache-Control': 'no-cache',
        },
        body: Buffer.from(''),
      });
    }

    const apiPrefix = this.apiPrefixes.find(prefix =>
      pathname === prefix || pathname.startsWith(`${prefix}/`)
    );

    if (apiPrefix) {
      const apiResponse = await this.handleApiRequest(apiPrefix, method, urlObj, headers, body);
      return this.withCorsHeaders(apiResponse);
    }

    const resolvedRequestPath = this.resolveStaticRequestPath(pathname, method, headers);
    if (!resolvedRequestPath) {
      return this.withCorsHeaders(this.notFound(pathname));
    }

    const response = this.serveFile(resolvedRequestPath);
    const manifestRewritten = this.rewriteModernJsManifestIfNeeded(
      response,
      resolvedRequestPath,
      urlObj
    );
    const remoteEntryRewritten = this.rewriteModernJsRemoteEntryIfNeeded(
      manifestRewritten,
      resolvedRequestPath,
      urlObj
    );
    const rewritten = this.rewriteResponseBodyIfNeeded(remoteEntryRewritten, resolvedRequestPath);
    return this.withCorsHeaders(rewritten);
  }

  private loadRouteConfig(): void {
    const routeJsonPath = path.join(this.distRoot, 'route.json');
    if (!this.exists(routeJsonPath)) {
      return;
    }

    try {
      const content = this.vfs.readFileSync(routeJsonPath, 'utf-8');
      const parsed = JSON.parse(content) as RouteJson;
      const routes = parsed.routes || [];

      for (const route of routes) {
        if (route.isApi && route.urlPath) {
          this.apiPrefixes.push(normalizeApiPrefix(route.urlPath));
        }

        if (route.urlPath === '/' && route.entryPath) {
          this.rootEntryPath = normalizePathname(route.entryPath);
        }
      }
    } catch (error) {
      console.warn('[ModernJsDistServer] Failed to parse route.json:', error);
    }
  }

  private loadLambdaHandlers(): void {
    const lambdaRoot = path.join(this.distRoot, 'api/lambda');
    if (!this.exists(lambdaRoot) || !this.isDirectory(lambdaRoot)) {
      return;
    }

    const lambdaFiles = this.collectJsFiles(lambdaRoot);
    const prefixes = this.apiPrefixes.length > 0 ? this.apiPrefixes : ['/api'];

    for (const filePath of lambdaFiles) {
      const relative = path.relative(lambdaRoot, filePath).replace(/\\/g, '/');
      const withoutExt = relative.replace(/\.js$/, '');
      const endpoint = normalizePathname(
        withoutExt.endsWith('/index')
          ? withoutExt.slice(0, -'/index'.length) || '/'
          : withoutExt
      );

      let exported: unknown;
      try {
        const mod = this.runtime.runFile(filePath).exports as Record<string, unknown>;
        exported = mod?.default ?? mod;
      } catch (error) {
        console.warn(`[ModernJsDistServer] Failed to load lambda handler: ${filePath}`, error);
        continue;
      }

      const handler: LambdaHandler = async (request: Request) => {
        if (typeof exported === 'function') {
          return await Promise.resolve((exported as (ctx: { request: Request }) => unknown)({ request }));
        }
        return exported;
      };

      for (const prefix of prefixes) {
        const fullPath = normalizePathname(`${prefix}${endpoint === '/' ? '' : endpoint}`);
        this.lambdaHandlers.set(fullPath, handler);
      }
    }
  }

  private loadEffectHandlers(): void {
    const effectEntry = path.join(this.distRoot, 'api/effect/index.js');
    if (!this.exists(effectEntry)) {
      return;
    }

    try {
      const mod = this.runtime.runFile(effectEntry).exports as Record<string, unknown>;
      const exported = mod?.default ?? mod;
      this.effectRouter = createEffectBffRouter(exported);
    } catch (error) {
      console.warn('[ModernJsDistServer] Failed to initialize effect handlers:', error);
      this.effectRouter = null;
    }
  }

  private collectJsFiles(dir: string): string[] {
    const out: string[] = [];

    const walk = (current: string) => {
      let entries: string[];
      try {
        entries = this.vfs.readdirSync(current);
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(current, entry);
        if (this.isDirectory(fullPath)) {
          walk(fullPath);
          continue;
        }

        if (fullPath.endsWith('.js')) {
          out.push(fullPath);
        }
      }
    };

    walk(dir);
    return out;
  }

  private resolveStaticRequestPath(
    pathname: string,
    method: string,
    headers: Record<string, string>
  ): string | null {
    if (pathname === '/') {
      return this.rootEntryPath;
    }

    const directPath = path.join(this.distRoot, pathname);
    if (this.exists(directPath) && !this.isDirectory(directPath)) {
      return pathname;
    }

    const hashedAssetPath = this.resolveHashedAssetAlias(pathname);
    if (hashedAssetPath) {
      return hashedAssetPath;
    }

    if (this.isDirectory(directPath)) {
      const indexPath = normalizePathname(path.join(pathname, 'index.html'));
      const fullIndexPath = path.join(this.distRoot, indexPath);
      if (this.exists(fullIndexPath)) {
        return indexPath;
      }
    }

    if (method.toUpperCase() === 'GET' && !hasExtension(pathname)) {
      const accept = (headers['accept'] || headers['Accept'] || '').toLowerCase();
      if (!accept || accept.includes('text/html') || accept.includes('*/*')) {
        return this.rootEntryPath;
      }
    }

    return null;
  }

  private resolveHashedAssetAlias(pathname: string): string | null {
    if (!hasExtension(pathname)) {
      return null;
    }

    const requestDir = normalizePathname(path.dirname(pathname));
    const requestBase = path.basename(pathname);
    const lastDot = requestBase.lastIndexOf('.');
    if (lastDot <= 0 || lastDot === requestBase.length - 1) {
      return null;
    }

    const name = requestBase.slice(0, lastDot);
    const ext = requestBase.slice(lastDot + 1);
    const baseDir = path.join(this.distRoot, requestDir);
    if (!this.exists(baseDir) || !this.isDirectory(baseDir)) {
      return null;
    }

    let entries: string[];
    try {
      entries = this.vfs.readdirSync(baseDir);
    } catch {
      return null;
    }

    const aliasPattern = new RegExp(
      `^${escapeRegExp(name)}\\.[^.]+(?:\\.[^.]+)*\\.${escapeRegExp(ext)}$`
    );

    const matched = entries
      .filter(entry => aliasPattern.test(entry))
      .sort();

    if (matched.length === 0) {
      return null;
    }

    return normalizePathname(path.join(requestDir, matched[0]));
  }

  private async handleApiRequest(
    prefix: string,
    method: string,
    urlObj: URL,
    headers: Record<string, string>,
    body?: Buffer
  ): Promise<ResponseData> {
    const normalizedMethod = method.toUpperCase();
    const pathname = normalizePathname(urlObj.pathname);
    const subPath = normalizePathname(pathname.slice(prefix.length) || '/');

    const request = new Request(urlObj.toString(), {
      method: normalizedMethod,
      headers: toHeaderRecord(headers),
      body: shouldIncludeBody(normalizedMethod) && body
        ? new Uint8Array(body)
        : undefined,
    });

    if (subPath === '/openapi.json' && this.effectRouter) {
      return toJsonResponse(this.effectRouter.openapi);
    }

    const lambdaPath = normalizePathname(`${prefix}${subPath === '/' ? '' : subPath}`);
    const lambdaHandler = this.lambdaHandlers.get(lambdaPath);
    if (lambdaHandler) {
      try {
        const result = await lambdaHandler(request);
        return await this.resultToResponse(result);
      } catch (error) {
        return this.serverError(error);
      }
    }

    if (this.effectRouter) {
      try {
        const result = await this.effectRouter.handle(normalizedMethod, subPath, request);
        return await this.resultToResponse(result);
      } catch {
        // fall through to 404 below
      }
    }

    return toJsonResponse({ message: `Not found: ${pathname}` }, 404);
  }

  private async resultToResponse(result: unknown): Promise<ResponseData> {
    if (result instanceof Response) {
      return this.fetchResponseToResponseData(result);
    }

    if (typeof result === 'undefined') {
      return {
        statusCode: 204,
        statusMessage: 'No Content',
        headers: {
          'Content-Length': '0',
          'Cache-Control': 'no-cache',
        },
        body: Buffer.from(''),
      };
    }

    if (typeof result === 'string') {
      const body = Buffer.from(result);
      return {
        statusCode: 200,
        statusMessage: 'OK',
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': String(body.length),
          'Cache-Control': 'no-cache',
        },
        body,
      };
    }

    return toJsonResponse(result);
  }

  private async fetchResponseToResponseData(response: Response): Promise<ResponseData> {
    const data = new Uint8Array(await response.arrayBuffer());
    const body = Buffer.from(data);
    const headers: Record<string, string> = {};

    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    if (!headers['Content-Length'] && !headers['content-length']) {
      headers['Content-Length'] = String(body.length);
    }

    if (!headers['Cache-Control'] && !headers['cache-control']) {
      headers['Cache-Control'] = 'no-cache';
    }

    return {
      statusCode: response.status,
      statusMessage: response.statusText || 'OK',
      headers,
      body,
    };
  }

  private rewriteResponseBodyIfNeeded(response: ResponseData, requestPath: string): ResponseData {
    if (!isTextLikeFile(requestPath) || response.statusCode >= 400) {
      return response;
    }

    let text = response.body.toString('utf-8');

    for (const [from, to] of Object.entries(this.originRewriteMap)) {
      if (from) {
        text = text.split(from).join(to);
      }
    }

    if (this.rewriteLocalhostToVirtual) {
      text = text.replace(
        /https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/g,
        (_match, port) => `/__virtual__/${port}`
      );
    }

    const body = Buffer.from(text);

    return {
      ...response,
      headers: {
        ...response.headers,
        'Content-Length': String(body.length),
      },
      body,
    };
  }

  private rewriteModernJsManifestIfNeeded(
    response: ResponseData,
    requestPath: string,
    requestUrl: URL
  ): ResponseData {
    if (response.statusCode >= 400 || !/\/mf-manifest\.json$/i.test(requestPath)) {
      return response;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body.toString('utf-8'));
    } catch {
      return response;
    }

    if (!parsed || typeof parsed !== 'object') {
      return response;
    }

    const manifest = parsed as {
      metaData?: {
        publicPath?: unknown;
      };
    };

    const publicPath = manifest.metaData?.publicPath;
    if (typeof publicPath !== 'string') {
      return response;
    }

    let normalizedPublicPath: string;
    try {
      normalizedPublicPath = new URL(
        publicPath || '/',
        `${requestUrl.origin}/`
      ).toString();
    } catch {
      return response;
    }

    if (normalizedPublicPath === publicPath) {
      return response;
    }

    const nextManifest = {
      ...manifest,
      metaData: {
        ...manifest.metaData,
        publicPath: normalizedPublicPath,
      },
    };

    const body = Buffer.from(JSON.stringify(nextManifest));
    return {
      ...response,
      headers: {
        ...response.headers,
        'Content-Length': String(body.length),
      },
      body,
    };
  }

  private rewriteModernJsRemoteEntryIfNeeded(
    response: ResponseData,
    requestPath: string,
    requestUrl: URL
  ): ResponseData {
    if (response.statusCode >= 400 || !/\/remoteEntry\.js$/i.test(requestPath)) {
      return response;
    }

    const original = response.body.toString('utf-8');
    const normalizedPublicPath = `${requestUrl.origin}/`;
    const rewritten = original.replace(
      /__webpack_require__\.p\s*=\s*["']\/["'];/g,
      `__webpack_require__.p = "${normalizedPublicPath}";`
    );

    if (rewritten === original) {
      return response;
    }

    const body = Buffer.from(rewritten);
    return {
      ...response,
      headers: {
        ...response.headers,
        'Content-Length': String(body.length),
      },
      body,
    };
  }

  private withCorsHeaders(response: ResponseData): ResponseData {
    if (!this.enableCors) {
      return response;
    }

    return {
      ...response,
      headers: {
        ...response.headers,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      },
    };
  }
}

export default ModernJsDistServer;
