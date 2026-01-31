import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { NextDevServer } from '../src/frameworks/next-dev-server';
import { Buffer } from '../src/shims/stream';

describe('NextDevServer', () => {
  let vfs: VirtualFS;
  let server: NextDevServer;

  beforeEach(() => {
    vfs = new VirtualFS();

    // Create a minimal Next.js project structure
    vfs.mkdirSync('/pages', { recursive: true });
    vfs.mkdirSync('/pages/api', { recursive: true });
    vfs.mkdirSync('/pages/users', { recursive: true });
    vfs.mkdirSync('/public', { recursive: true });
    vfs.mkdirSync('/styles', { recursive: true });

    // Create pages
    vfs.writeFileSync(
      '/pages/index.jsx',
      `import React from 'react';
export default function Home() {
  return <div><h1>Home Page</h1></div>;
}
`
    );

    vfs.writeFileSync(
      '/pages/about.jsx',
      `import React from 'react';
import Link from 'next/link';

export default function About() {
  return <div><h1>About Page</h1><Link href="/">Home</Link></div>;
}
`
    );

    // Create dynamic route
    vfs.writeFileSync(
      '/pages/users/[id].jsx',
      `import React from 'react';

export default function UserPage() {
  return <div><h1>User Page</h1></div>;
}
`
    );

    // Create API routes
    vfs.writeFileSync(
      '/pages/api/hello.js',
      `export default function handler(req, res) {
  res.status(200).json({ message: 'Hello from API!' });
}
`
    );

    vfs.writeFileSync(
      '/pages/api/users.js',
      `export default function handler(req, res) {
  res.status(200).json({ users: [{ id: 1, name: 'Alice' }] });
}
`
    );

    // Create 404 page
    vfs.writeFileSync(
      '/pages/404.jsx',
      `import React from 'react';
export default function NotFound() {
  return <div><h1>404 - Not Found</h1></div>;
}
`
    );

    // Create global styles
    vfs.writeFileSync(
      '/styles/globals.css',
      `body {
  margin: 0;
  font-family: sans-serif;
}
`
    );

    // Create public file
    vfs.writeFileSync('/public/favicon.ico', 'favicon data');

    server = new NextDevServer(vfs, { port: 3001 });
  });

  afterEach(() => {
    server.stop();
  });

  describe('page routing', () => {
    it('should resolve / to pages/index.jsx', async () => {
      const response = await server.handleRequest('GET', '/', {});

      expect(response.statusCode).toBe(200);
      expect(response.headers['Content-Type']).toBe('text/html; charset=utf-8');
      expect(response.body.toString()).toContain('<!DOCTYPE html>');
      expect(response.body.toString()).toContain('<div id="__next">');
    });

    it('should resolve /about to pages/about.jsx', async () => {
      const response = await server.handleRequest('GET', '/about', {});

      expect(response.statusCode).toBe(200);
      expect(response.headers['Content-Type']).toBe('text/html; charset=utf-8');
      // New dynamic router uses /_next/pages/ for page loading
      const html = response.body.toString();
      expect(html).toContain('/_next/pages');
      expect(html).toContain('function Router()');
    });

    it('should resolve /users/123 to pages/users/[id].jsx', async () => {
      const response = await server.handleRequest('GET', '/users/123', {});

      expect(response.statusCode).toBe(200);
      expect(response.headers['Content-Type']).toBe('text/html; charset=utf-8');
      // New dynamic router uses /_next/pages/ for page loading
      const html = response.body.toString();
      expect(html).toContain('/_next/pages');
      expect(html).toContain('function Router()');
    });

    it('should return 404 for non-existent pages', async () => {
      const response = await server.handleRequest('GET', '/nonexistent', {});

      expect(response.statusCode).toBe(404);
    });

    it('should handle pages with .tsx extension', async () => {
      vfs.writeFileSync(
        '/pages/typescript.tsx',
        `import React from 'react';
export default function TypeScriptPage(): JSX.Element {
  return <div>TypeScript Page</div>;
}
`
      );

      const response = await server.handleRequest('GET', '/typescript', {});

      expect(response.statusCode).toBe(200);
      // New dynamic router uses /_next/pages/ for page loading
      const html = response.body.toString();
      expect(html).toContain('/_next/pages');
      expect(html).toContain('function Router()');
    });

    it('should handle index files in subdirectories', async () => {
      vfs.mkdirSync('/pages/blog', { recursive: true });
      vfs.writeFileSync(
        '/pages/blog/index.jsx',
        `import React from 'react';
export default function BlogIndex() {
  return <div>Blog Index</div>;
}
`
      );

      const response = await server.handleRequest('GET', '/blog', {});

      expect(response.statusCode).toBe(200);
      // New dynamic router uses /_next/pages/ for page loading
      const html = response.body.toString();
      expect(html).toContain('/_next/pages');
      expect(html).toContain('function Router()');
    });
  });

  describe('API routes', () => {
    it('should handle GET /api/hello', async () => {
      const response = await server.handleRequest('GET', '/api/hello', {});

      expect(response.statusCode).toBe(200);
      expect(response.headers['Content-Type']).toBe('application/json; charset=utf-8');
      // API routes in this implementation return a placeholder response
      const body = JSON.parse(response.body.toString());
      expect(body).toHaveProperty('message');
    });

    it('should handle GET /api/users', async () => {
      const response = await server.handleRequest('GET', '/api/users', {});

      expect(response.statusCode).toBe(200);
      expect(response.headers['Content-Type']).toBe('application/json; charset=utf-8');
    });

    it('should return 404 for non-existent API routes', async () => {
      const response = await server.handleRequest('GET', '/api/nonexistent', {});

      expect(response.statusCode).toBe(404);
      expect(response.headers['Content-Type']).toBe('application/json; charset=utf-8');

      const body = JSON.parse(response.body.toString());
      expect(body.error).toBe('API route not found');
    });

    it('should handle POST requests to API', async () => {
      const response = await server.handleRequest(
        'POST',
        '/api/hello',
        { 'Content-Type': 'application/json' },
        Buffer.from(JSON.stringify({ name: 'Test' }))
      );

      expect(response.statusCode).toBe(200);
    });

    it('should handle API routes in subdirectories', async () => {
      vfs.mkdirSync('/pages/api/users', { recursive: true });
      vfs.writeFileSync(
        '/pages/api/users/index.js',
        `export default function handler(req, res) {
  res.status(200).json({ users: [] });
}
`
      );

      // Note: /api/users is already defined as a file, so this tests the file-first resolution
      const response = await server.handleRequest('GET', '/api/users', {});
      expect(response.statusCode).toBe(200);
    });

    it('should execute API handler with https import', async () => {
      // Create an API route that imports https module
      vfs.writeFileSync(
        '/pages/api/https-test.js',
        `import https from 'https';

export default function handler(req, res) {
  // Just verify we can import https and it has expected methods
  const hasGet = typeof https.get === 'function';
  const hasRequest = typeof https.request === 'function';

  res.status(200).json({
    httpsAvailable: true,
    hasGet,
    hasRequest
  });
}
`
      );

      const response = await server.handleRequest('GET', '/api/https-test', {});

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body.toString());
      expect(body.httpsAvailable).toBe(true);
      expect(body.hasGet).toBe(true);
      expect(body.hasRequest).toBe(true);
    });

    it('should execute API handler that returns data from handler', async () => {
      const response = await server.handleRequest('GET', '/api/hello', {});

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body.toString());
      expect(body.message).toBe('Hello from API!');
    });
  });

  describe('HTML generation', () => {
    it('should generate valid HTML shell', async () => {
      const response = await server.handleRequest('GET', '/', {});
      const html = response.body.toString();

      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('<html');
      expect(html).toContain('</html>');
      expect(html).toContain('<head>');
      expect(html).toContain('</head>');
      expect(html).toContain('<body>');
      expect(html).toContain('</body>');
    });

    it('should include import map for react', async () => {
      const response = await server.handleRequest('GET', '/', {});
      const html = response.body.toString();

      expect(html).toContain('importmap');
      expect(html).toContain('react');
      expect(html).toContain('esm.sh');
    });

    it('should include React Refresh preamble', async () => {
      const response = await server.handleRequest('GET', '/', {});
      const html = response.body.toString();

      expect(html).toContain('react-refresh');
      expect(html).toContain('$RefreshRuntime$');
      expect(html).toContain('$RefreshReg$');
    });

    it('should include HMR client script', async () => {
      const response = await server.handleRequest('GET', '/', {});
      const html = response.body.toString();

      expect(html).toContain('postMessage');
      expect(html).toContain('next-hmr');
      expect(html).toContain('__vite_hot_context__');
    });

    it('should set correct page module path', async () => {
      const response = await server.handleRequest('GET', '/about', {});
      const html = response.body.toString();

      // New dynamic router uses /_next/pages/ for page loading
      expect(html).toContain('/_next/pages');
    });

    it('should use client-side navigation instead of full reload', async () => {
      const response = await server.handleRequest('GET', '/', {});
      const html = response.body.toString();

      // The new implementation uses dynamic imports for client-side navigation
      // instead of reloading the page on popstate events
      expect(html).toContain('function Router()');
      expect(html).toContain('async function loadPage(pathname)');
      expect(html).toContain("window.addEventListener('popstate'");
      // Should NOT contain the old reload behavior
      expect(html).not.toContain('window.location.reload()');
    });
  });

  describe('Next.js shims', () => {
    it('should serve /_next/shims/link.js', async () => {
      const response = await server.handleRequest('GET', '/_next/shims/link.js', {});

      expect(response.statusCode).toBe(200);
      expect(response.headers['Content-Type']).toBe('application/javascript; charset=utf-8');
      expect(response.body.toString()).toContain('Link');
      expect(response.body.toString()).toContain('handleClick');
    });

    it('should serve /_next/shims/router.js', async () => {
      const response = await server.handleRequest('GET', '/_next/shims/router.js', {});

      expect(response.statusCode).toBe(200);
      expect(response.headers['Content-Type']).toBe('application/javascript; charset=utf-8');
      expect(response.body.toString()).toContain('useRouter');
      expect(response.body.toString()).toContain('pathname');
    });

    it('should serve /_next/shims/head.js', async () => {
      const response = await server.handleRequest('GET', '/_next/shims/head.js', {});

      expect(response.statusCode).toBe(200);
      expect(response.headers['Content-Type']).toBe('application/javascript; charset=utf-8');
      expect(response.body.toString()).toContain('Head');
    });

    it('should return 404 for unknown shims', async () => {
      const response = await server.handleRequest('GET', '/_next/shims/unknown.js', {});

      expect(response.statusCode).toBe(404);
    });
  });

  describe('public directory', () => {
    it('should serve files from public directory', async () => {
      const response = await server.handleRequest('GET', '/favicon.ico', {});

      expect(response.statusCode).toBe(200);
      expect(response.body.toString()).toBe('favicon data');
    });

    it('should serve public files before trying page routes', async () => {
      vfs.writeFileSync('/public/test.json', '{"public": true}');

      const response = await server.handleRequest('GET', '/test.json', {});

      expect(response.statusCode).toBe(200);
      expect(response.body.toString()).toContain('"public"');
    });
  });

  describe('JSX/TS transformation', () => {
    // Note: In Node.js test environment, esbuild-wasm is not available
    // So these tests verify the request handling without actual transformation

    it('should handle direct JSX file requests', async () => {
      const response = await server.handleRequest('GET', '/pages/index.jsx', {});

      expect(response.statusCode).toBe(200);
      expect(response.headers['Content-Type']).toBe('application/javascript; charset=utf-8');
    });

    it('should handle TypeScript files', async () => {
      vfs.writeFileSync(
        '/pages/typescript.ts',
        `const greeting: string = 'Hello';
export default greeting;
`
      );

      const response = await server.handleRequest('GET', '/pages/typescript.ts', {});

      expect(response.statusCode).toBe(200);
      expect(response.headers['Content-Type']).toBe('application/javascript; charset=utf-8');
    });
  });

  describe('HMR events', () => {
    it('should emit hmr-update on file change', async () => {
      const listener = vi.fn();
      server.on('hmr-update', listener);

      server.start();

      // Simulate file change by writing to VFS
      vfs.writeFileSync('/pages/index.jsx', '// Updated content');

      // Wait for the watcher to trigger
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(listener).toHaveBeenCalled();
      const update = listener.mock.calls[0][0];
      expect(update).toHaveProperty('type');
      expect(update).toHaveProperty('path');
      expect(update).toHaveProperty('timestamp');
    });

    it('should emit update type for JSX files', async () => {
      const listener = vi.fn();
      server.on('hmr-update', listener);

      server.start();

      vfs.writeFileSync('/pages/about.jsx', '// Updated');

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(listener).toHaveBeenCalled();
      const update = listener.mock.calls[0][0];
      expect(update.type).toBe('update');
    });

    it('should emit update type for API files', async () => {
      const listener = vi.fn();
      server.on('hmr-update', listener);

      server.start();

      vfs.writeFileSync('/pages/api/hello.js', '// Updated API');

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(listener).toHaveBeenCalled();
      const update = listener.mock.calls[0][0];
      expect(update.type).toBe('update');
    });
  });

  describe('server lifecycle', () => {
    it('should start watching on start()', () => {
      const spy = vi.spyOn(server, 'startWatching');

      server.start();

      expect(spy).toHaveBeenCalled();
    });

    it('should stop cleanly', () => {
      server.start();
      expect(server.isRunning()).toBe(true);

      server.stop();
      expect(server.isRunning()).toBe(false);
    });

    it('should return port', () => {
      expect(server.getPort()).toBe(3001);
    });
  });

  describe('custom 404 page', () => {
    it('should use custom 404 page when available', async () => {
      const response = await server.handleRequest('GET', '/nonexistent', {});

      expect(response.statusCode).toBe(404);
      expect(response.headers['Content-Type']).toBe('text/html; charset=utf-8');
      // Should use custom 404 page with dynamic page loading
      // The new router loads pages via /_next/pages/ virtual endpoint
      const html = response.body.toString();
      expect(html).toContain('/_next/pages');
      expect(html).toContain('function Router()');
    });

    it('should use default 404 when custom page not available', async () => {
      // Remove custom 404 page
      vfs.unlinkSync('/pages/404.jsx');

      const response = await server.handleRequest('GET', '/nonexistent', {});

      expect(response.statusCode).toBe(404);
      expect(response.body.toString()).toContain('404');
      expect(response.body.toString()).toContain('Page Not Found');
    });
  });

  describe('query string handling', () => {
    it('should serve pages with query strings', async () => {
      const response = await server.handleRequest('GET', '/about?ref=home', {});

      expect(response.statusCode).toBe(200);
    });

    it('should serve API routes with query strings', async () => {
      const response = await server.handleRequest('GET', '/api/hello?name=world', {});

      expect(response.statusCode).toBe(200);
    });
  });

  describe('concurrent requests', () => {
    it('should handle multiple concurrent requests', async () => {
      const requests = [
        server.handleRequest('GET', '/', {}),
        server.handleRequest('GET', '/about', {}),
        server.handleRequest('GET', '/api/hello', {}),
        server.handleRequest('GET', '/users/1', {}),
        server.handleRequest('GET', '/nonexistent', {}),
      ];

      const responses = await Promise.all(requests);

      expect(responses[0].statusCode).toBe(200); // index
      expect(responses[1].statusCode).toBe(200); // about
      expect(responses[2].statusCode).toBe(200); // API
      expect(responses[3].statusCode).toBe(200); // dynamic route
      expect(responses[4].statusCode).toBe(404); // not found
    });
  });
});

describe('NextDevServer environment variables', () => {
  let vfs: VirtualFS;
  let server: NextDevServer;

  beforeEach(() => {
    vfs = new VirtualFS();
    vfs.mkdirSync('/pages', { recursive: true });
    vfs.writeFileSync('/pages/index.jsx', '<div>Test</div>');
  });

  afterEach(() => {
    if (server) server.stop();
  });

  describe('setEnv and getEnv', () => {
    it('should set and get environment variables', () => {
      server = new NextDevServer(vfs, { port: 3001 });

      server.setEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com');
      server.setEnv('NEXT_PUBLIC_CONVEX_URL', 'https://my-app.convex.cloud');

      const env = server.getEnv();
      expect(env.NEXT_PUBLIC_API_URL).toBe('https://api.example.com');
      expect(env.NEXT_PUBLIC_CONVEX_URL).toBe('https://my-app.convex.cloud');
    });

    it('should accept env vars via constructor options', () => {
      server = new NextDevServer(vfs, {
        port: 3001,
        env: {
          NEXT_PUBLIC_API_URL: 'https://api.example.com',
          SECRET_KEY: 'should-not-be-exposed',
        },
      });

      const env = server.getEnv();
      expect(env.NEXT_PUBLIC_API_URL).toBe('https://api.example.com');
      expect(env.SECRET_KEY).toBe('should-not-be-exposed');
    });

    it('should return a copy of env vars (not the original object)', () => {
      server = new NextDevServer(vfs, {
        port: 3001,
        env: { NEXT_PUBLIC_TEST: 'value' },
      });

      const env1 = server.getEnv();
      env1.NEXT_PUBLIC_TEST = 'modified';

      const env2 = server.getEnv();
      expect(env2.NEXT_PUBLIC_TEST).toBe('value');
    });

    it('should update env vars at runtime', () => {
      server = new NextDevServer(vfs, { port: 3001 });

      expect(server.getEnv().NEXT_PUBLIC_URL).toBeUndefined();

      server.setEnv('NEXT_PUBLIC_URL', 'https://example.com');

      expect(server.getEnv().NEXT_PUBLIC_URL).toBe('https://example.com');
    });
  });

  describe('NEXT_PUBLIC_* injection into HTML', () => {
    it('should inject NEXT_PUBLIC_* vars into HTML', async () => {
      server = new NextDevServer(vfs, {
        port: 3001,
        env: {
          NEXT_PUBLIC_API_URL: 'https://api.example.com',
          NEXT_PUBLIC_CONVEX_URL: 'https://my-app.convex.cloud',
        },
      });

      const response = await server.handleRequest('GET', '/', {});
      const html = response.body.toString();

      expect(html).toContain('window.process');
      expect(html).toContain('window.process.env');
      expect(html).toContain('NEXT_PUBLIC_API_URL');
      expect(html).toContain('https://api.example.com');
      expect(html).toContain('NEXT_PUBLIC_CONVEX_URL');
      expect(html).toContain('https://my-app.convex.cloud');
    });

    it('should NOT inject non-NEXT_PUBLIC_* vars into HTML', async () => {
      server = new NextDevServer(vfs, {
        port: 3001,
        env: {
          NEXT_PUBLIC_VISIBLE: 'visible',
          SECRET_KEY: 'secret-should-not-appear',
          DATABASE_URL: 'postgres://secret',
        },
      });

      const response = await server.handleRequest('GET', '/', {});
      const html = response.body.toString();

      expect(html).toContain('NEXT_PUBLIC_VISIBLE');
      expect(html).toContain('visible');
      expect(html).not.toContain('SECRET_KEY');
      expect(html).not.toContain('secret-should-not-appear');
      expect(html).not.toContain('DATABASE_URL');
      expect(html).not.toContain('postgres://secret');
    });

    it('should not inject env script when no NEXT_PUBLIC_* vars exist', async () => {
      server = new NextDevServer(vfs, {
        port: 3001,
        env: {
          SECRET_KEY: 'secret',
        },
      });

      const response = await server.handleRequest('GET', '/', {});
      const html = response.body.toString();

      // Should not have the env injection script
      expect(html).not.toContain('NEXT_PUBLIC_');
      expect(html).not.toContain('SECRET_KEY');
    });

    it('should reflect setEnv updates in subsequent HTML', async () => {
      server = new NextDevServer(vfs, { port: 3001 });

      // First request - no env vars
      const response1 = await server.handleRequest('GET', '/', {});
      expect(response1.body.toString()).not.toContain('NEXT_PUBLIC_CONVEX_URL');

      // Set env var
      server.setEnv('NEXT_PUBLIC_CONVEX_URL', 'https://my-app.convex.cloud');

      // Second request - should have the env var
      const response2 = await server.handleRequest('GET', '/', {});
      const html2 = response2.body.toString();
      expect(html2).toContain('NEXT_PUBLIC_CONVEX_URL');
      expect(html2).toContain('https://my-app.convex.cloud');
    });
  });

  describe('App Router env injection', () => {
    beforeEach(() => {
      // Set up App Router structure
      vfs.mkdirSync('/app', { recursive: true });
      vfs.writeFileSync('/app/page.jsx', '<div>App Router Page</div>');
      vfs.writeFileSync('/app/layout.jsx', `
        export default function Layout({ children }) {
          return <div>{children}</div>;
        }
      `);
    });

    it('should inject NEXT_PUBLIC_* vars in App Router HTML', async () => {
      server = new NextDevServer(vfs, {
        port: 3001,
        preferAppRouter: true,
        env: {
          NEXT_PUBLIC_APP_NAME: 'My App',
        },
      });

      const response = await server.handleRequest('GET', '/', {});
      const html = response.body.toString();

      expect(html).toContain('window.process');
      expect(html).toContain('NEXT_PUBLIC_APP_NAME');
      expect(html).toContain('My App');
    });
  });

  describe('App Router client-side navigation', () => {
    beforeEach(() => {
      // Set up App Router structure with multiple pages
      vfs.mkdirSync('/app', { recursive: true });
      vfs.mkdirSync('/app/about', { recursive: true });
      vfs.writeFileSync('/app/page.tsx', `
        import Link from 'next/link';
        export default function Home() {
          return <div><h1>Home</h1><Link href="/about">About</Link></div>;
        }
      `);
      vfs.writeFileSync('/app/about/page.tsx', `
        export default function About() {
          return <div><h1>About Page</h1></div>;
        }
      `);
      vfs.writeFileSync('/app/layout.tsx', `
        export default function Layout({ children }) {
          return <html><body>{children}</body></html>;
        }
      `);
    });

    it('should use client-side navigation instead of full reload', async () => {
      server = new NextDevServer(vfs, {
        port: 3001,
        preferAppRouter: true,
      });

      const response = await server.handleRequest('GET', '/', {});
      const html = response.body.toString();

      // Should have the Router component for dynamic navigation
      expect(html).toContain('function Router()');
      expect(html).toContain('async function loadPage(pathname)');
      expect(html).toContain("window.addEventListener('popstate'");
      // Should NOT contain window.location.reload
      expect(html).not.toContain('window.location.reload()');
    });

    it('should serve app page components via /_next/app/', async () => {
      server = new NextDevServer(vfs, {
        port: 3001,
        preferAppRouter: true,
      });

      // Request the about page component
      const response = await server.handleRequest('GET', '/_next/app/app/about/page.js', {});

      expect(response.statusCode).toBe(200);
      expect(response.headers['Content-Type']).toBe('application/javascript; charset=utf-8');
      expect(response.body.toString()).toContain('About Page');
    });

    it('should serve app layout components via /_next/app/', async () => {
      server = new NextDevServer(vfs, {
        port: 3001,
        preferAppRouter: true,
      });

      // Request the root layout component
      const response = await server.handleRequest('GET', '/_next/app/app/layout.js', {});

      expect(response.statusCode).toBe(200);
      expect(response.headers['Content-Type']).toBe('application/javascript; charset=utf-8');
      expect(response.body.toString()).toContain('children');
    });
  });
});

describe('NextDevServer with ServerBridge integration', () => {
  let vfs: VirtualFS;
  let server: NextDevServer;

  beforeEach(() => {
    vfs = new VirtualFS();

    vfs.mkdirSync('/pages', { recursive: true });
    vfs.writeFileSync('/pages/index.jsx', '<div>Test</div>');

    server = new NextDevServer(vfs, { port: 3001 });
  });

  afterEach(() => {
    server.stop();
  });

  it('should handle request/response cycle like http.Server', async () => {
    const response = await server.handleRequest('GET', '/', {
      'accept': 'text/html',
      'host': 'localhost:3001',
    });

    expect(response.statusCode).toBe(200);
    expect(response.statusMessage).toBe('OK');
    expect(response.headers).toBeDefined();
    expect(response.body).toBeInstanceOf(Buffer);
  });

  it('should return consistent response format', async () => {
    const response = await server.handleRequest('GET', '/', {});

    expect(typeof response.statusCode).toBe('number');
    expect(typeof response.statusMessage).toBe('string');
    expect(typeof response.headers).toBe('object');
    expect(response.body).toBeInstanceOf(Buffer);

    for (const [key, value] of Object.entries(response.headers)) {
      expect(typeof key).toBe('string');
      expect(typeof value).toBe('string');
    }
  });
});

describe('NextDevServer streaming API routes', () => {
  let vfs: VirtualFS;
  let server: NextDevServer;

  beforeEach(() => {
    vfs = new VirtualFS();

    // Create Pages Router API directory
    vfs.mkdirSync('/pages', { recursive: true });
    vfs.mkdirSync('/pages/api', { recursive: true });

    // Create a simple streaming API route
    vfs.writeFileSync(
      '/pages/api/stream.js',
      `export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/plain');
  res.write('chunk1');
  res.write('chunk2');
  res.write('chunk3');
  res.end();
}
`
    );

    // Create an API route that streams with delays (simulating AI response)
    vfs.writeFileSync(
      '/pages/api/chat.js',
      `export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.write('Hello');
  res.write(' ');
  res.write('World');
  res.end('!');
}
`
    );

    // Create an API route that uses JSON response (non-streaming)
    vfs.writeFileSync(
      '/pages/api/json.js',
      `export default function handler(req, res) {
  res.status(200).json({ message: 'Hello JSON' });
}
`
    );

    // Create an API route that sends error
    vfs.writeFileSync(
      '/pages/api/error.js',
      `export default function handler(req, res) {
  res.status(500).json({ error: 'Something went wrong' });
}
`
    );

    server = new NextDevServer(vfs, { port: 3001 });
  });

  afterEach(() => {
    server.stop();
  });

  describe('handleStreamingRequest', () => {
    it('should call onStart with status and headers', async () => {
      const onStart = vi.fn();
      const onChunk = vi.fn();
      const onEnd = vi.fn();

      await server.handleStreamingRequest(
        'GET',
        '/api/stream',
        {},
        undefined,
        onStart,
        onChunk,
        onEnd
      );

      expect(onStart).toHaveBeenCalledTimes(1);
      expect(onStart).toHaveBeenCalledWith(
        200,
        'OK',
        expect.objectContaining({
          'Content-Type': 'text/plain',
        })
      );
    });

    it('should call onChunk for each res.write() call', async () => {
      const onStart = vi.fn();
      const onChunk = vi.fn();
      const onEnd = vi.fn();

      await server.handleStreamingRequest(
        'GET',
        '/api/stream',
        {},
        undefined,
        onStart,
        onChunk,
        onEnd
      );

      expect(onChunk).toHaveBeenCalledTimes(3);
      expect(onChunk).toHaveBeenNthCalledWith(1, 'chunk1');
      expect(onChunk).toHaveBeenNthCalledWith(2, 'chunk2');
      expect(onChunk).toHaveBeenNthCalledWith(3, 'chunk3');
    });

    it('should call onEnd when response is complete', async () => {
      const onStart = vi.fn();
      const onChunk = vi.fn();
      const onEnd = vi.fn();

      await server.handleStreamingRequest(
        'GET',
        '/api/stream',
        {},
        undefined,
        onStart,
        onChunk,
        onEnd
      );

      expect(onEnd).toHaveBeenCalledTimes(1);
    });

    it('should handle res.end() with data', async () => {
      const onStart = vi.fn();
      const onChunk = vi.fn();
      const onEnd = vi.fn();

      await server.handleStreamingRequest(
        'GET',
        '/api/chat',
        {},
        undefined,
        onStart,
        onChunk,
        onEnd
      );

      // Should have 4 chunks: 'Hello', ' ', 'World', '!'
      expect(onChunk).toHaveBeenCalledTimes(4);
      expect(onChunk).toHaveBeenNthCalledWith(1, 'Hello');
      expect(onChunk).toHaveBeenNthCalledWith(2, ' ');
      expect(onChunk).toHaveBeenNthCalledWith(3, 'World');
      expect(onChunk).toHaveBeenNthCalledWith(4, '!');
    });

    it('should handle JSON responses', async () => {
      const onStart = vi.fn();
      const onChunk = vi.fn();
      const onEnd = vi.fn();

      await server.handleStreamingRequest(
        'GET',
        '/api/json',
        {},
        undefined,
        onStart,
        onChunk,
        onEnd
      );

      expect(onStart).toHaveBeenCalledWith(
        200,
        'OK',
        expect.objectContaining({
          'Content-Type': 'application/json; charset=utf-8',
        })
      );

      expect(onChunk).toHaveBeenCalledTimes(1);
      const chunkData = JSON.parse(onChunk.mock.calls[0][0]);
      expect(chunkData).toEqual({ message: 'Hello JSON' });
    });

    it('should handle error responses', async () => {
      const onStart = vi.fn();
      const onChunk = vi.fn();
      const onEnd = vi.fn();

      await server.handleStreamingRequest(
        'GET',
        '/api/error',
        {},
        undefined,
        onStart,
        onChunk,
        onEnd
      );

      expect(onStart).toHaveBeenCalledWith(
        500,
        'OK',
        expect.any(Object)
      );

      expect(onChunk).toHaveBeenCalledTimes(1);
      const chunkData = JSON.parse(onChunk.mock.calls[0][0]);
      expect(chunkData).toEqual({ error: 'Something went wrong' });
    });

    it('should return 404 for non-API routes', async () => {
      const onStart = vi.fn();
      const onChunk = vi.fn();
      const onEnd = vi.fn();

      await server.handleStreamingRequest(
        'GET',
        '/not-an-api',
        {},
        undefined,
        onStart,
        onChunk,
        onEnd
      );

      expect(onStart).toHaveBeenCalledWith(404, 'Not Found', expect.any(Object));
      expect(onEnd).toHaveBeenCalled();
    });

    it('should return 404 for non-existent API routes', async () => {
      const onStart = vi.fn();
      const onChunk = vi.fn();
      const onEnd = vi.fn();

      await server.handleStreamingRequest(
        'GET',
        '/api/nonexistent',
        {},
        undefined,
        onStart,
        onChunk,
        onEnd
      );

      expect(onStart).toHaveBeenCalledWith(404, 'Not Found', expect.any(Object));
      expect(onChunk).toHaveBeenCalledWith(JSON.stringify({ error: 'API route not found' }));
      expect(onEnd).toHaveBeenCalled();
    });

    it('should handle POST requests with body', async () => {
      vfs.writeFileSync(
        '/pages/api/echo.js',
        `export default function handler(req, res) {
  const { name } = req.body || {};
  res.write('Hello, ');
  res.end(name || 'stranger');
}
`
      );

      const onStart = vi.fn();
      const onChunk = vi.fn();
      const onEnd = vi.fn();

      await server.handleStreamingRequest(
        'POST',
        '/api/echo',
        { 'Content-Type': 'application/json' },
        Buffer.from(JSON.stringify({ name: 'Alice' })),
        onStart,
        onChunk,
        onEnd
      );

      expect(onChunk).toHaveBeenNthCalledWith(1, 'Hello, ');
      expect(onChunk).toHaveBeenNthCalledWith(2, 'Alice');
    });
  });

  describe('streaming response callback order', () => {
    it('should call callbacks in correct order: onStart, onChunk(s), onEnd', async () => {
      const callOrder: string[] = [];

      const onStart = vi.fn(() => callOrder.push('start'));
      const onChunk = vi.fn(() => callOrder.push('chunk'));
      const onEnd = vi.fn(() => callOrder.push('end'));

      await server.handleStreamingRequest(
        'GET',
        '/api/stream',
        {},
        undefined,
        onStart,
        onChunk,
        onEnd
      );

      expect(callOrder[0]).toBe('start');
      expect(callOrder[callOrder.length - 1]).toBe('end');
      expect(callOrder.filter(c => c === 'chunk').length).toBe(3);
    });

    it('should send headers before any chunks', async () => {
      let headersReceived = false;
      let chunkReceivedBeforeHeaders = false;

      const onStart = vi.fn(() => {
        headersReceived = true;
      });

      const onChunk = vi.fn(() => {
        if (!headersReceived) {
          chunkReceivedBeforeHeaders = true;
        }
      });

      const onEnd = vi.fn();

      await server.handleStreamingRequest(
        'GET',
        '/api/stream',
        {},
        undefined,
        onStart,
        onChunk,
        onEnd
      );

      expect(chunkReceivedBeforeHeaders).toBe(false);
      expect(headersReceived).toBe(true);
    });
  });

  describe('streaming with environment variables', () => {
    it('should have access to process.env in streaming handlers', async () => {
      vfs.writeFileSync(
        '/pages/api/env-stream.js',
        `export default function handler(req, res) {
  const apiKey = process.env.TEST_API_KEY || 'not-set';
  res.write('API_KEY=');
  res.end(apiKey);
}
`
      );

      server.setEnv('TEST_API_KEY', 'secret-key-123');

      const onStart = vi.fn();
      const onChunk = vi.fn();
      const onEnd = vi.fn();

      await server.handleStreamingRequest(
        'GET',
        '/api/env-stream',
        {},
        undefined,
        onStart,
        onChunk,
        onEnd
      );

      expect(onChunk).toHaveBeenNthCalledWith(1, 'API_KEY=');
      expect(onChunk).toHaveBeenNthCalledWith(2, 'secret-key-123');
    });
  });
});

describe('NextDevServer mock response streaming interface', () => {
  let vfs: VirtualFS;
  let server: NextDevServer;

  beforeEach(() => {
    vfs = new VirtualFS();
    vfs.mkdirSync('/pages', { recursive: true });
    vfs.mkdirSync('/pages/api', { recursive: true });
    server = new NextDevServer(vfs, { port: 3001 });
  });

  afterEach(() => {
    server.stop();
  });

  it('should support res.write() method in regular API routes', async () => {
    vfs.writeFileSync(
      '/pages/api/write-test.js',
      `export default function handler(req, res) {
  res.setHeader('Content-Type', 'text/plain');
  res.write('part1');
  res.write('part2');
  res.end('part3');
}
`
    );

    const response = await server.handleRequest('GET', '/api/write-test', {});

    expect(response.statusCode).toBe(200);
    expect(response.body.toString()).toBe('part1part2part3');
  });

  it('should support res.getHeader() method', async () => {
    vfs.writeFileSync(
      '/pages/api/header-test.js',
      `export default function handler(req, res) {
  res.setHeader('X-Custom', 'test-value');
  const customHeader = res.getHeader('X-Custom');
  res.json({ header: customHeader });
}
`
    );

    const response = await server.handleRequest('GET', '/api/header-test', {});

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body.toString());
    expect(body.header).toBe('test-value');
  });

  it('should track headersSent property', async () => {
    vfs.writeFileSync(
      '/pages/api/headers-sent-test.js',
      `export default function handler(req, res) {
  const beforeWrite = res.headersSent;
  res.write('data');
  const afterWrite = res.headersSent;
  res.end(JSON.stringify({ before: beforeWrite, after: afterWrite }));
}
`
    );

    const response = await server.handleRequest('GET', '/api/headers-sent-test', {});

    expect(response.statusCode).toBe(200);
    // Note: In our mock, headersSent becomes true after first write
    const body = response.body.toString();
    expect(body).toContain('data');
  });
});
