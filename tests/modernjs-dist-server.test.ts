import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { ModernJsDistServer } from '../src/frameworks/modernjs-dist-server';

function createEffectApiModule(): string {
  return `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hostEffectApi = void 0;
const effectClient = require("@modern-js/plugin-bff/effect-client");
exports.hostEffectApi = effectClient.HttpApi.make("HostEffectApi").add(
  effectClient.HttpApiGroup.make("greetings").add(
    effectClient.HttpApiEndpoint.get("hello")\`/effect/hello\`.addSuccess(
      effectClient.Schema.Struct({
        message: effectClient.Schema.String,
        runtime: effectClient.Schema.Literal("host"),
      })
    )
  )
);
`;
}

function createEffectHandlerModule(): string {
  return `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const effectServer = require("@modern-js/plugin-bff/effect-server");
const apiModule = require("../../shared/effect/api");

const greetingsLayer = effectServer.HttpApiBuilder.group(apiModule.hostEffectApi, "greetings", handlers =>
  handlers.handle("hello", () =>
    effectServer.Effect.succeed({
      message: "Hello from host Effect API",
      runtime: "host",
    })
  )
);

const layer = effectServer.HttpApiBuilder.api(apiModule.hostEffectApi).pipe(
  effectServer.Layer.provide(greetingsLayer)
);

exports.default = effectServer.defineEffectBff({
  api: apiModule.hostEffectApi,
  layer,
});
`;
}

describe('ModernJsDistServer', () => {
  let vfs: VirtualFS;

  beforeEach(() => {
    vfs = new VirtualFS();

    vfs.mkdirSync('/dist/html/index', { recursive: true });
    vfs.mkdirSync('/dist/static/js', { recursive: true });
    vfs.mkdirSync('/dist/api/lambda', { recursive: true });
    vfs.mkdirSync('/dist/api/effect', { recursive: true });
    vfs.mkdirSync('/dist/shared/effect', { recursive: true });

    vfs.writeFileSync(
      '/dist/route.json',
      JSON.stringify(
        {
          routes: [
            {
              urlPath: '/',
              entryName: 'index',
              entryPath: 'html/index/index.html',
              isSPA: true,
            },
            {
              urlPath: '/host-api',
              isApi: true,
              isSPA: false,
            },
          ],
        },
        null,
        2
      )
    );

    vfs.writeFileSync(
      '/dist/html/index/index.html',
      `<!doctype html>
<html>
  <head><title>Modern Dist Test</title></head>
  <body>
    <script type="module" src="/static/js/index.js"></script>
    <a id="manifest" href="http://localhost:3010/mf-manifest.json">manifest</a>
  </body>
</html>`
    );

    vfs.writeFileSync(
      '/dist/static/js/index.js',
      'window.__REMOTE_MANIFEST__ = "http://localhost:3010/mf-manifest.json";'
    );

    vfs.writeFileSync(
      '/dist/static/js/lib-react.04c88a27.js',
      'window.__LIB_REACT_HASHED__ = true;'
    );

    vfs.writeFileSync(
      '/dist/mf-manifest.json',
      JSON.stringify({
        metaData: {
          publicPath: '/',
          remoteEntry: {
            name: 'remoteEntry.js',
            path: '',
            type: 'global',
          },
        },
      })
    );

    vfs.writeFileSync(
      '/dist/remoteEntry.js',
      '(() => { __webpack_require__.p = "/"; })();'
    );

    vfs.writeFileSync(
      '/dist/api/lambda/legacy.js',
      '"use strict"; Object.defineProperty(exports, "__esModule", { value: true }); exports.default = async () => ({ message: "Hello from lambda" });'
    );

    vfs.writeFileSync('/dist/shared/effect/api.js', createEffectApiModule());
    vfs.writeFileSync('/dist/api/effect/index.js', createEffectHandlerModule());
  });

  it('serves root HTML and rewrites localhost origins to virtual paths', async () => {
    const server = new ModernJsDistServer(vfs, { port: 3001, root: '/dist' });

    const response = await server.handleRequest('GET', '/', {
      accept: 'text/html',
    });

    const html = response.body.toString();

    expect(response.statusCode).toBe(200);
    expect(html).toContain('/__virtual__/3010/mf-manifest.json');
  });

  it('serves SPA fallback routes', async () => {
    const server = new ModernJsDistServer(vfs, { port: 3001, root: '/dist' });

    const response = await server.handleRequest('GET', '/mf', {
      accept: 'text/html',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.toString()).toContain('Modern Dist Test');
  });

  it('serves and rewrites static JS files', async () => {
    const server = new ModernJsDistServer(vfs, { port: 3001, root: '/dist' });

    const response = await server.handleRequest('GET', '/static/js/index.js', {
      accept: 'application/javascript',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['Content-Type']).toContain('application/javascript');
    expect(response.body.toString()).toContain('/__virtual__/3010/mf-manifest.json');
  });

  it('resolves unhashed static asset aliases to hashed files', async () => {
    const server = new ModernJsDistServer(vfs, { port: 3001, root: '/dist' });

    const response = await server.handleRequest('GET', '/static/js/lib-react.js', {
      accept: 'application/javascript',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.toString()).toContain('__LIB_REACT_HASHED__');
  });

  it('executes lambda handlers under API prefix', async () => {
    const server = new ModernJsDistServer(vfs, { port: 3001, root: '/dist' });

    const response = await server.handleRequest('GET', '/host-api/legacy', {
      accept: 'application/json',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body.toString())).toEqual({
      message: 'Hello from lambda',
    });
  });

  it('executes effect handlers and exposes openapi endpoint', async () => {
    const server = new ModernJsDistServer(vfs, { port: 3001, root: '/dist' });

    const effectResponse = await server.handleRequest('GET', '/host-api/effect/hello', {
      accept: 'application/json',
    });

    expect(effectResponse.statusCode).toBe(200);
    expect(JSON.parse(effectResponse.body.toString())).toEqual({
      message: 'Hello from host Effect API',
      runtime: 'host',
    });

    const openapiResponse = await server.handleRequest('GET', '/host-api/openapi.json', {
      accept: 'application/json',
    });

    const openapi = JSON.parse(openapiResponse.body.toString()) as {
      paths: Record<string, unknown>;
    };

    expect(openapiResponse.statusCode).toBe(200);
    expect(openapi.paths['/effect/hello']).toBeDefined();
  });

  it('supports explicit origin rewrite maps without virtual-path rewriting', async () => {
    const server = new ModernJsDistServer(vfs, {
      port: 3001,
      root: '/dist',
      rewriteLocalhostToVirtual: false,
      originRewriteMap: {
        'http://localhost:3010': 'http://localhost:4010',
      },
    });

    const response = await server.handleRequest('GET', '/static/js/index.js', {
      accept: 'application/javascript',
    });

    const body = response.body.toString();
    expect(body).toContain('http://localhost:4010/mf-manifest.json');
    expect(body).not.toContain('/__virtual__/3010');
  });

  it('normalizes mf-manifest publicPath and remoteEntry public path from request origin', async () => {
    const server = new ModernJsDistServer(vfs, {
      port: 4110,
      root: '/dist',
      rewriteLocalhostToVirtual: false,
    });

    const manifestResponse = await server.handleRequest('GET', '/mf-manifest.json', {
      accept: 'application/json',
    });
    const manifest = JSON.parse(manifestResponse.body.toString()) as {
      metaData?: { publicPath?: string };
    };

    expect(manifestResponse.statusCode).toBe(200);
    expect(manifest.metaData?.publicPath).toBe('http://localhost:4110/');

    const remoteEntryResponse = await server.handleRequest('GET', '/remoteEntry.js', {
      accept: 'application/javascript',
    });
    const remoteEntry = remoteEntryResponse.body.toString();

    expect(remoteEntryResponse.statusCode).toBe(200);
    expect(remoteEntry).toContain('__webpack_require__.p = "http://localhost:4110/";');
  });
});
