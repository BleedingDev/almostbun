import { afterEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { getServerBridge, resetServerBridge } from '../src/server-bridge';
import {
  detectRunnableProject,
  startDetectedProject,
} from '../src/repo/runner';

describe('repo runner detection', () => {
  it('detects Modern.js dist output', () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/project/dist/api', { recursive: true });
    vfs.writeFileSync('/project/dist/route.json', '{"routes":[]}');

    const detected = detectRunnableProject(vfs, { projectPath: '/project' });
    expect(detected.kind).toBe('modernjs-dist');
    expect(detected.serverRoot).toBe('/project/dist');
  });

  it('detects Next.js app in nested project path', () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/project/pages', { recursive: true });
    vfs.writeFileSync('/project/pages/index.tsx', 'export default function Page(){ return null; }');
    vfs.writeFileSync(
      '/project/package.json',
      JSON.stringify({
        name: 'next-app',
        dependencies: { next: '^14.2.0' },
      })
    );

    const detected = detectRunnableProject(vfs, { projectPath: '/project' });
    expect(detected.kind).toBe('next');
    expect(detected.projectPath).toBe('/project');
  });

  it('detects Vite app', () => {
    const vfs = new VirtualFS();
    vfs.writeFileSync('/project/index.html', '<!doctype html>');
    vfs.writeFileSync('/project/vite.config.ts', 'export default {}');
    vfs.writeFileSync(
      '/project/package.json',
      JSON.stringify({
        name: 'vite-app',
        devDependencies: { vite: '^5.4.0' },
      })
    );

    const detected = detectRunnableProject(vfs, { projectPath: '/project' });
    expect(detected.kind).toBe('vite');
  });

  it('detects Vite app in deep e2e fixture subdir path', () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/project/packages/e2e-tests/env', { recursive: true });
    vfs.writeFileSync('/project/packages/e2e-tests/env/index.html', '<!doctype html><h1>Hello world!</h1>');
    vfs.writeFileSync('/project/packages/e2e-tests/env/vite.config.js', 'export default {}');
    vfs.writeFileSync(
      '/project/packages/e2e-tests/env/package.json',
      JSON.stringify({
        name: 'env',
        scripts: {
          dev: 'vite',
        },
        devDependencies: { vite: '^7.0.0' },
      })
    );

    const detected = detectRunnableProject(vfs, { projectPath: '/project/packages/e2e-tests/env' });
    expect(detected.kind).toBe('vite');
    expect(detected.projectPath).toBe('/project/packages/e2e-tests/env');
  });

  it('detects Vite app in TanStack example-style nested path', () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/project/examples/react/authenticated-routes', { recursive: true });
    vfs.writeFileSync(
      '/project/examples/react/authenticated-routes/index.html',
      '<!doctype html><div id="root"></div>'
    );
    vfs.writeFileSync(
      '/project/examples/react/authenticated-routes/package.json',
      JSON.stringify({
        name: 'authenticated-routes',
        scripts: {
          dev: 'vite',
        },
        dependencies: { vite: '^7.0.0' },
      })
    );

    const detected = detectRunnableProject(vfs, {
      projectPath: '/project/examples/react/authenticated-routes',
    });
    expect(detected.kind).toBe('vite');
    expect(detected.projectPath).toBe('/project/examples/react/authenticated-routes');
  });

  it('prefers node-script for vinxi apps that only depend on vite transitively', () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/project/node_modules/vinxi/bin', { recursive: true });
    vfs.writeFileSync(
      '/project/node_modules/vinxi/package.json',
      JSON.stringify({
        name: 'vinxi',
        bin: {
          vinxi: 'bin/cli.mjs',
        },
      })
    );
    vfs.writeFileSync('/project/node_modules/vinxi/bin/cli.mjs', '#!/usr/bin/env node\nmodule.exports = null;\n');
    vfs.writeFileSync(
      '/project/package.json',
      JSON.stringify({
        name: 'tanstack-start-like-app',
        scripts: {
          dev: 'vinxi dev',
        },
        dependencies: {
          vite: '^7.0.0',
          vinxi: '^0.5.0',
        },
      })
    );

    const detected = detectRunnableProject(vfs, { projectPath: '/project' });
    expect(detected.kind).toBe('node-script');
    expect(detected.entryPath).toBe('/project/node_modules/vinxi/bin/cli.mjs');
    expect(detected.entryArgs).toEqual(['dev']);
  });

  it('detects TanStack Start projects as vite apps with client-entry fallback', () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/project/src', { recursive: true });
    vfs.writeFileSync('/project/app.config.ts', 'export default {};');
    vfs.writeFileSync('/project/src/client.tsx', 'console.log("client");');
    vfs.writeFileSync(
      '/project/package.json',
      JSON.stringify({
        name: 'tanstack-start-app',
        scripts: {
          dev: 'vinxi dev',
        },
        dependencies: {
          '@tanstack/react-start': '^1.0.0',
          vinxi: '^0.5.0',
        },
      })
    );

    const detected = detectRunnableProject(vfs, { projectPath: '/project' });
    expect(detected.kind).toBe('vite');
    expect(detected.reason).toContain('TanStack Start');
  });

  it('resolves bin commands from scoped packages (modern dev -> @modern-js/app-tools)', () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/project/node_modules/@modern-js/app-tools/bin', { recursive: true });
    vfs.mkdirSync('/project/node_modules/esbuild/bin', { recursive: true });
    vfs.writeFileSync(
      '/project/node_modules/esbuild/package.json',
      JSON.stringify({
        name: 'esbuild',
        bin: {
          esbuild: 'bin/esbuild',
        },
      })
    );
    vfs.writeFileSync('/project/node_modules/esbuild/bin/esbuild', '#!/usr/bin/env node\n');
    vfs.writeFileSync(
      '/project/node_modules/@modern-js/app-tools/package.json',
      JSON.stringify({
        name: '@modern-js/app-tools',
        bin: {
          modern: 'bin/modern.js',
        },
      })
    );
    vfs.writeFileSync('/project/node_modules/@modern-js/app-tools/bin/modern.js', '#!/usr/bin/env node\n');
    vfs.writeFileSync(
      '/project/package.json',
      JSON.stringify({
        name: 'modern-like-app',
        scripts: {
          dev: 'modern dev',
        },
        devDependencies: {
          '@modern-js/app-tools': '1.0.0',
        },
      })
    );

    const detected = detectRunnableProject(vfs, { projectPath: '/project' });
    expect(detected.kind).toBe('node-script');
    expect(detected.entryPath).toBe('/project/node_modules/@modern-js/app-tools/bin/modern.js');
    expect(detected.entryArgs).toEqual(['dev']);
  });

  it('detects bun script entry and resolves to file path', () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/project/src', { recursive: true });
    vfs.writeFileSync('/project/src/server.ts', 'console.log("server");');
    vfs.writeFileSync(
      '/project/package.json',
      JSON.stringify({
        name: 'bun-script-app',
        scripts: {
          dev: 'bun run src/server.ts',
        },
      })
    );

    const detected = detectRunnableProject(vfs, { projectPath: '/project' });
    expect(detected.kind).toBe('node-script');
    expect(detected.entryPath).toBe('/project/src/server.ts');
  });

  it('resolves nested script references (bun run start)', () => {
    const vfs = new VirtualFS();
    vfs.writeFileSync('/project/server.js', 'console.log("nested script");');
    vfs.writeFileSync(
      '/project/package.json',
      JSON.stringify({
        name: 'nested-script-app',
        scripts: {
          dev: 'bun run start',
          start: 'node server.js',
        },
      })
    );

    const detected = detectRunnableProject(vfs, { projectPath: '/project' });
    expect(detected.kind).toBe('node-script');
    expect(detected.entryPath).toBe('/project/server.js');
  });

  it('falls back to runnable package inside monorepo', () => {
    const vfs = new VirtualFS();
    vfs.writeFileSync(
      '/repo/package.json',
      JSON.stringify({
        name: 'workspace-root',
        private: true,
        workspaces: ['apps/*'],
      })
    );
    vfs.mkdirSync('/repo/apps/web', { recursive: true });
    vfs.writeFileSync('/repo/apps/web/index.html', '<!doctype html>');
    vfs.writeFileSync('/repo/apps/web/vite.config.js', 'export default {}');
    vfs.writeFileSync(
      '/repo/apps/web/package.json',
      JSON.stringify({
        name: 'web',
        scripts: {
          dev: 'vite',
        },
      })
    );

    const detected = detectRunnableProject(vfs, {
      projectPath: '/repo',
    });
    expect(detected.kind).toBe('vite');
    expect(detected.projectPath).toBe('/repo/apps/web');
  });

  it('detects static app in hidden .output subdir path', () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/project/examples/deploy/self-built-node/.output/html/main', { recursive: true });
    vfs.writeFileSync(
      '/project/examples/deploy/self-built-node/.output/html/main/index.html',
      '<h1>Hello Modern</h1>'
    );

    const detected = detectRunnableProject(vfs, {
      projectPath: '/project/examples/deploy/self-built-node/.output/html/main',
    });

    expect(detected.kind).toBe('static');
    expect(detected.projectPath).toBe('/project/examples/deploy/self-built-node/.output/html/main');
    expect(detected.serverRoot).toBe('/project/examples/deploy/self-built-node/.output/html/main');
  });

  it('detects static app in deep e2e fixture static path', () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/project/tests/e2e/builder/cases/html/minify/static', { recursive: true });
    vfs.writeFileSync(
      '/project/tests/e2e/builder/cases/html/minify/static/index.html',
      '<h1>fixture</h1>'
    );

    const detected = detectRunnableProject(vfs, {
      projectPath: '/project/tests/e2e/builder/cases/html/minify/static',
    });

    expect(detected.kind).toBe('static');
    expect(detected.projectPath).toBe('/project/tests/e2e/builder/cases/html/minify/static');
    expect(detected.serverRoot).toBe('/project/tests/e2e/builder/cases/html/minify/static');
  });

  it('detects static app in deep dist-html fixture path', () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/project/packages/server/server/tests/fixtures/pure/test-dist/html/main', { recursive: true });
    vfs.writeFileSync(
      '/project/packages/server/server/tests/fixtures/pure/test-dist/html/main/index.html',
      '<h1>dist-html</h1>'
    );

    const detected = detectRunnableProject(vfs, {
      projectPath: '/project/packages/server/server/tests/fixtures/pure/test-dist/html/main',
    });

    expect(detected.kind).toBe('static');
    expect(detected.projectPath).toBe('/project/packages/server/server/tests/fixtures/pure/test-dist/html/main');
    expect(detected.serverRoot).toBe('/project/packages/server/server/tests/fixtures/pure/test-dist/html/main');
  });

  it('detects static app in playwright-report fixture path', () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/project/examples/test-playwright/playwright-report', { recursive: true });
    vfs.writeFileSync(
      '/project/examples/test-playwright/playwright-report/index.html',
      '<h1>report</h1>'
    );

    const detected = detectRunnableProject(vfs, {
      projectPath: '/project/examples/test-playwright/playwright-report',
    });

    expect(detected.kind).toBe('static');
    expect(detected.projectPath).toBe('/project/examples/test-playwright/playwright-report');
    expect(detected.serverRoot).toBe('/project/examples/test-playwright/playwright-report');
  });
});

describe('repo runner startDetectedProject', () => {
  afterEach(() => {
    resetServerBridge();
  });

  it('starts static project and serves index.html', async () => {
    const vfs = new VirtualFS();
    vfs.writeFileSync('/project/index.html', '<h1>Static Works</h1>');

    const detected = detectRunnableProject(vfs, { projectPath: '/project' });
    const running = await startDetectedProject(vfs, detected, {
      initServiceWorker: false,
      port: 4080,
    });

    const bridge = getServerBridge();
    const response = await bridge.handleRequest(
      running.port,
      'GET',
      '/',
      {
        host: 'localhost',
      }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.toString()).toContain('Static Works');

    running.stop();
  });

  it('starts sibling Modern.js dist remotes for MF host projects', async () => {
    const vfs = new VirtualFS();

    // Host
    vfs.mkdirSync('/project/routes-tanstack-mf/mf-host/dist/html/index', { recursive: true });
    vfs.writeFileSync(
      '/project/routes-tanstack-mf/mf-host/modern.config.ts',
      'export default { server: { port: 3011 } };'
    );
    vfs.writeFileSync(
      '/project/routes-tanstack-mf/mf-host/dist/route.json',
      JSON.stringify({
        routes: [
          {
            urlPath: '/',
            entryPath: 'html/index/index.html',
            isSPA: true,
          },
        ],
      })
    );
    vfs.writeFileSync(
      '/project/routes-tanstack-mf/mf-host/dist/html/index/index.html',
      '<script src="http://localhost:3010/remoteEntry.js"></script><script src="http://localhost:3012/remoteEntry.js"></script>'
    );

    // Remote #1
    vfs.mkdirSync('/project/routes-tanstack-mf/mf-remote/dist/html/index', { recursive: true });
    vfs.writeFileSync(
      '/project/routes-tanstack-mf/mf-remote/modern.config.ts',
      'export default { server: { port: 3010 } };'
    );
    vfs.writeFileSync(
      '/project/routes-tanstack-mf/mf-remote/dist/route.json',
      JSON.stringify({
        routes: [
          {
            urlPath: '/',
            entryPath: 'html/index/index.html',
            isSPA: true,
          },
        ],
      })
    );
    vfs.writeFileSync('/project/routes-tanstack-mf/mf-remote/dist/html/index/index.html', '<h1>remote one</h1>');
    vfs.writeFileSync(
      '/project/routes-tanstack-mf/mf-remote/dist/mf-manifest.json',
      JSON.stringify({
        metaData: {
          publicPath: '/',
        },
      })
    );
    vfs.writeFileSync(
      '/project/routes-tanstack-mf/mf-remote/dist/remoteEntry.js',
      '(() => { __webpack_require__.p = "/"; window.__REMOTE_ONE__ = true; })();'
    );

    // Remote #2
    vfs.mkdirSync('/project/routes-tanstack-mf/mf-remote-2/dist/html/index', { recursive: true });
    vfs.writeFileSync(
      '/project/routes-tanstack-mf/mf-remote-2/modern.config.ts',
      'export default { server: { port: 3012 } };'
    );
    vfs.writeFileSync(
      '/project/routes-tanstack-mf/mf-remote-2/dist/route.json',
      JSON.stringify({
        routes: [
          {
            urlPath: '/',
            entryPath: 'html/index/index.html',
            isSPA: true,
          },
        ],
      })
    );
    vfs.writeFileSync('/project/routes-tanstack-mf/mf-remote-2/dist/html/index/index.html', '<h1>remote two</h1>');
    vfs.writeFileSync(
      '/project/routes-tanstack-mf/mf-remote-2/dist/mf-manifest.json',
      JSON.stringify({
        metaData: {
          publicPath: '/',
        },
      })
    );
    vfs.writeFileSync(
      '/project/routes-tanstack-mf/mf-remote-2/dist/remoteEntry.js',
      '(() => { __webpack_require__.p = "/"; window.__REMOTE_TWO__ = true; })();'
    );

    const detected = detectRunnableProject(vfs, {
      projectPath: '/project/routes-tanstack-mf/mf-host',
    });
    expect(detected.kind).toBe('modernjs-dist');

    const running = await startDetectedProject(vfs, detected, {
      initServiceWorker: false,
      port: 3011,
    });

    const bridge = getServerBridge();

    const hostResponse = await bridge.handleRequest(
      running.port,
      'GET',
      '/',
      {
        host: 'localhost',
        accept: 'text/html',
      }
    );

    expect(hostResponse.statusCode).toBe(200);
    expect(hostResponse.body.toString()).toContain('/__virtual__/3010/remoteEntry.js');
    expect(hostResponse.body.toString()).toContain('/__virtual__/3012/remoteEntry.js');

    const remoteOneManifest = await bridge.handleRequest(
      3010,
      'GET',
      '/mf-manifest.json',
      {
        host: 'localhost',
        accept: 'application/json',
      }
    );
    expect(remoteOneManifest.statusCode).toBe(200);
    expect(JSON.parse(remoteOneManifest.body.toString())).toMatchObject({
      metaData: {
        publicPath: '/__virtual__/3010/',
      },
    });

    const remoteOneEntry = await bridge.handleRequest(
      3010,
      'GET',
      '/remoteEntry.js',
      {
        host: 'localhost',
        accept: 'application/javascript',
      }
    );
    expect(remoteOneEntry.statusCode).toBe(200);
    expect(remoteOneEntry.body.toString()).toContain('__webpack_require__.p = "/__virtual__/3010/";');

    const remoteTwoEntry = await bridge.handleRequest(
      3012,
      'GET',
      '/remoteEntry.js',
      {
        host: 'localhost',
        accept: 'application/javascript',
      }
    );
    expect(remoteTwoEntry.statusCode).toBe(200);
    expect(remoteTwoEntry.body.toString()).toContain('__webpack_require__.p = "/__virtual__/3012/";');

    running.stop();
  });

  it('starts sibling Modern.js dist sub-apps for garfish-style microfrontend URLs', async () => {
    const vfs = new VirtualFS();

    // Host
    vfs.mkdirSync('/project/garfish-host/dist/html/index', { recursive: true });
    vfs.writeFileSync(
      '/project/garfish-host/modern.config.ts',
      'export default { server: { port: 3200 } };'
    );
    vfs.writeFileSync(
      '/project/garfish-host/dist/route.json',
      JSON.stringify({
        routes: [
          {
            urlPath: '/',
            entryPath: 'html/index/index.html',
            isSPA: true,
          },
        ],
      })
    );
    vfs.writeFileSync(
      '/project/garfish-host/dist/html/index/index.html',
      '<script src="http://localhost:3201/static/js/sub-app.js"></script>'
    );

    // Garfish-style sub-app
    vfs.mkdirSync('/project/garfish-subapp/dist/html/index', { recursive: true });
    vfs.mkdirSync('/project/garfish-subapp/dist/static/js', { recursive: true });
    vfs.writeFileSync(
      '/project/garfish-subapp/modern.config.ts',
      'export default { server: { port: 3201 } };'
    );
    vfs.writeFileSync(
      '/project/garfish-subapp/dist/route.json',
      JSON.stringify({
        routes: [
          {
            urlPath: '/',
            entryPath: 'html/index/index.html',
            isSPA: true,
          },
        ],
      })
    );
    vfs.writeFileSync('/project/garfish-subapp/dist/html/index/index.html', '<h1>sub-app</h1>');
    vfs.writeFileSync(
      '/project/garfish-subapp/dist/static/js/sub-app.js',
      'window.__GARFISH_SUBAPP_READY__ = true;'
    );

    const detected = detectRunnableProject(vfs, {
      projectPath: '/project/garfish-host',
    });
    expect(detected.kind).toBe('modernjs-dist');

    const running = await startDetectedProject(vfs, detected, {
      initServiceWorker: false,
      port: 3200,
    });

    const bridge = getServerBridge();
    const hostResponse = await bridge.handleRequest(
      running.port,
      'GET',
      '/',
      {
        host: 'localhost',
        accept: 'text/html',
      }
    );

    expect(hostResponse.statusCode).toBe(200);
    expect(hostResponse.body.toString()).toContain('/__virtual__/3201/static/js/sub-app.js');

    const subAppScript = await bridge.handleRequest(
      3201,
      'GET',
      '/static/js/sub-app.js',
      {
        host: 'localhost',
        accept: 'application/javascript',
      }
    );

    expect(subAppScript.statusCode).toBe(200);
    expect(subAppScript.body.toString()).toContain('__GARFISH_SUBAPP_READY__');

    running.stop();
  });

  it('starts script project and exposes registered http server', async () => {
    const vfs = new VirtualFS();
    vfs.writeFileSync(
      '/project/server.js',
      `
const http = require('http');
const port = Number(process.env.PORT || 3000);
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.statusCode = 200;
    res.end('ok');
    return;
  }
  res.statusCode = 200;
  res.end('hello');
});
server.listen(port);
`
    );
    vfs.writeFileSync(
      '/project/package.json',
      JSON.stringify({
        name: 'script-app',
        scripts: {
          start: 'node server.js',
        },
      })
    );

    const detected = detectRunnableProject(vfs, { projectPath: '/project' });
    expect(detected.kind).toBe('node-script');

    const running = await startDetectedProject(vfs, detected, {
      initServiceWorker: false,
      port: 4090,
    });

    const bridge = getServerBridge();
    const response = await bridge.handleRequest(
      running.port,
      'GET',
      '/health',
      {
        host: 'localhost',
      }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.toString()).toBe('ok');

    running.stop();
  });

  it('detects Vite root in nested client folder and serves it', async () => {
    const vfs = new VirtualFS();
    vfs.writeFileSync('/project/package.json', JSON.stringify({
      name: 'vite-nested',
      scripts: { dev: 'vite' },
    }));
    vfs.writeFileSync('/project/vite.config.ts', 'export default {};');
    vfs.writeFileSync('/project/src/client/index.html', '<h1>Nested Vite Root</h1>');

    const detected = detectRunnableProject(vfs, { projectPath: '/project' });
    expect(detected.kind).toBe('vite');
    expect(detected.serverRoot).toBe('/project/src/client');

    const running = await startDetectedProject(vfs, detected, {
      initServiceWorker: false,
      port: 4091,
    });

    const bridge = getServerBridge();
    const response = await bridge.handleRequest(
      running.port,
      'GET',
      '/',
      {
        host: 'localhost',
      }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.toString()).toContain('Nested Vite Root');

    running.stop();
  });

  it('can disable Vite HMR injection for repo-runner compatibility mode', async () => {
    const vfs = new VirtualFS();
    vfs.writeFileSync('/project/package.json', JSON.stringify({
      name: 'vite-no-hmr-injection',
      scripts: { dev: 'vite' },
    }));
    vfs.writeFileSync('/project/vite.config.ts', 'export default {};');
    vfs.writeFileSync(
      '/project/index.html',
      '<!doctype html><html><head><title>t</title></head><body><div id=\"root\"></div></body></html>'
    );

    const detected = detectRunnableProject(vfs, { projectPath: '/project' });
    expect(detected.kind).toBe('vite');

    const running = await startDetectedProject(vfs, detected, {
      initServiceWorker: false,
      port: 4093,
      disableViteHmrInjection: true,
    });

    const bridge = getServerBridge();
    const response = await bridge.handleRequest(
      running.port,
      'GET',
      '/',
      {
        host: 'localhost',
      }
    );

    const html = response.body.toString();
    expect(response.statusCode).toBe(200);
    expect(html).toContain('<div id="root"></div>');
    expect(html).not.toContain('[HMR]');
    expect(html).not.toContain('react-refresh');

    running.stop();
  });

  it('proxies /api requests to vite sidecar runtime when backend entry exists', async () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/project/src/server', { recursive: true });
    vfs.writeFileSync(
      '/project/src/server/index.js',
      `
const http = require('http');
const port = Number(process.env.PORT || 3000);
http.createServer((req, res) => {
  if (req.url === '/api/hello') {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.statusCode = 404;
  res.end('nope');
}).listen(port);
`
    );
    vfs.writeFileSync(
      '/project/package.json',
      JSON.stringify({
        name: 'vite-fullstack-sidecar',
        scripts: {
          dev: 'bun concurrent --names "server,client" "bun src/server/index.js" "bunx --bun vite"',
        },
        dependencies: {
          vite: '^5.4.0',
          elysia: '^1.0.0',
        },
      })
    );
    vfs.writeFileSync('/project/vite.config.ts', 'export default {};');
    vfs.writeFileSync('/project/index.html', '<!doctype html><html><body><div id="root"></div></body></html>');

    const detected = detectRunnableProject(vfs, { projectPath: '/project' });
    expect(detected.kind).toBe('vite');

    const running = await startDetectedProject(vfs, detected, {
      initServiceWorker: false,
      port: 4095,
      serverReadyTimeoutMs: 4000,
    });

    const bridge = getServerBridge();
    const response = await bridge.handleRequest(
      running.port,
      'GET',
      '/api/hello',
      {
        host: 'localhost',
      }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.toString()).toContain('"ok":true');

    running.stop();
  });

  it('logs sidecar failures without warning prefix while keeping app running', async () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/project/src/server', { recursive: true });
    vfs.writeFileSync('/project/src/server/index.ts', 'export const broken: = true;');
    vfs.writeFileSync(
      '/project/package.json',
      JSON.stringify({
        name: 'vite-sidecar-failure',
        scripts: {
          dev: 'vite',
        },
        dependencies: {
          vite: '^5.4.0',
          elysia: '^1.0.0',
        },
      })
    );
    vfs.writeFileSync('/project/vite.config.ts', 'export default {};');
    vfs.writeFileSync('/project/index.html', '<!doctype html><html><body><h1>ok</h1></body></html>');

    const detected = detectRunnableProject(vfs, { projectPath: '/project' });
    expect(detected.kind).toBe('vite');

    const logs: string[] = [];
    const running = await startDetectedProject(vfs, detected, {
      initServiceWorker: false,
      port: 4096,
      log: (line) => logs.push(line),
    });

    const bridge = getServerBridge();
    const response = await bridge.handleRequest(
      running.port,
      'GET',
      '/',
      {
        host: 'localhost',
      }
    );

    expect(response.statusCode).toBe(200);
    expect(logs.some((line) => line.includes('API sidecar failed'))).toBe(true);
    expect(logs.some((line) => line.includes('Warning: API sidecar failed'))).toBe(false);

    running.stop();
  });

  it('starts script project when server.listen uses process.env.PORT string', async () => {
    const vfs = new VirtualFS();
    vfs.writeFileSync(
      '/project/server.js',
      `
const http = require('http');
const server = http.createServer((req, res) => {
  res.statusCode = 200;
  res.end('ok');
});
server.listen(process.env.PORT, () => {
  console.log('listening');
});
`
    );
    vfs.writeFileSync(
      '/project/package.json',
      JSON.stringify({
        name: 'script-app-string-port',
        scripts: {
          start: 'node server.js',
        },
      })
    );

    const detected = detectRunnableProject(vfs, { projectPath: '/project' });
    expect(detected.kind).toBe('node-script');

    const running = await startDetectedProject(vfs, detected, {
      initServiceWorker: false,
      port: 4092,
      serverReadyTimeoutMs: 4000,
    });

    const bridge = getServerBridge();
    const response = await bridge.handleRequest(
      running.port,
      'GET',
      '/',
      {
        host: 'localhost',
      }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.toString()).toBe('ok');

    running.stop();
  });

  it('starts script project when entry uses Bun.serve in TypeScript ESM', async () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/project/src', { recursive: true });
    vfs.writeFileSync(
      '/project/src/server.ts',
      `
import bun from 'bun';

const port = Number(process.env.PORT || 3000);
bun.serve({
  port,
  fetch() {
    return new Response('bun-ok', { status: 200 });
  },
});
`
    );
    vfs.writeFileSync(
      '/project/package.json',
      JSON.stringify({
        name: 'bun-serve-script-app',
        type: 'module',
        scripts: {
          start: 'bun run src/server.ts',
        },
      })
    );

    const detected = detectRunnableProject(vfs, { projectPath: '/project' });
    expect(detected.kind).toBe('node-script');

    const running = await startDetectedProject(vfs, detected, {
      initServiceWorker: false,
      port: 4094,
      serverReadyTimeoutMs: 4000,
    });

    const bridge = getServerBridge();
    const response = await bridge.handleRequest(
      running.port,
      'GET',
      '/',
      {
        host: 'localhost',
      }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.toString()).toBe('bun-ok');

    running.stop();
  });

  it('emits structured trace events during startup', async () => {
    const vfs = new VirtualFS();
    vfs.writeFileSync('/project/index.html', '<h1>trace</h1>');

    const detected = detectRunnableProject(vfs, { projectPath: '/project' });
    const traces: Array<{ sequence: number; phase: string; message: string }> = [];
    const running = await startDetectedProject(vfs, detected, {
      initServiceWorker: false,
      port: 4097,
      onTraceEvent: (event) => {
        traces.push({
          sequence: event.sequence,
          phase: event.phase,
          message: event.message,
        });
      },
    });

    expect(traces.length).toBeGreaterThan(0);
    expect(traces.some(trace => trace.phase === 'start')).toBe(true);
    expect(traces.some(trace => trace.phase === 'server')).toBe(true);
    expect(traces[0]!.sequence).toBe(0);
    for (let i = 1; i < traces.length; i += 1) {
      expect(traces[i]!.sequence).toBeGreaterThan(traces[i - 1]!.sequence);
    }

    running.stop();
  });
});
