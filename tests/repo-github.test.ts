import { describe, it, expect, vi, afterEach } from 'vitest';
import pako from 'pako';
import { VirtualFS } from '../src/virtual-fs';
import {
  __clearGitHubArchiveCacheForTests,
  importGitHubRepo,
  parseGitHubRepoUrl,
} from '../src/repo/github';

describe('GitHub repo import helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    __clearGitHubArchiveCacheForTests();
  });

  it('parses basic github repository URLs', () => {
    expect(parseGitHubRepoUrl('https://github.com/acme/demo')).toEqual({
      owner: 'acme',
      repo: 'demo',
      ref: 'HEAD',
      sourceUrl: 'https://github.com/acme/demo',
      archiveUrl: 'https://codeload.github.com/acme/demo/tar.gz/HEAD',
    });
  });

  it('parses tree URLs with ref and subdir', () => {
    expect(parseGitHubRepoUrl('https://github.com/acme/demo/tree/main/examples/app')).toEqual({
      owner: 'acme',
      repo: 'demo',
      ref: 'main',
      subdir: 'examples/app',
      sourceUrl: 'https://github.com/acme/demo',
      archiveUrl: 'https://codeload.github.com/acme/demo/tar.gz/main',
    });
  });

  it('parses dotted repo names with deep integration tree subdir', () => {
    expect(
      parseGitHubRepoUrl(
        'https://github.com/web-infra-dev/modern.js/tree/main/tests/integration/routes-tanstack-mf/mf-host'
      )
    ).toEqual({
      owner: 'web-infra-dev',
      repo: 'modern.js',
      ref: 'main',
      subdir: 'tests/integration/routes-tanstack-mf/mf-host',
      sourceUrl: 'https://github.com/web-infra-dev/modern.js',
      archiveUrl: 'https://codeload.github.com/web-infra-dev/modern.js/tar.gz/main',
    });
  });

  it('parses canary branch tree paths used by Next.js examples', () => {
    expect(
      parseGitHubRepoUrl(
        'https://github.com/vercel/next.js/tree/canary/examples/with-context-api'
      )
    ).toEqual({
      owner: 'vercel',
      repo: 'next.js',
      ref: 'canary',
      subdir: 'examples/with-context-api',
      sourceUrl: 'https://github.com/vercel/next.js',
      archiveUrl: 'https://codeload.github.com/vercel/next.js/tar.gz/canary',
    });
  });

  it('parses TanStack router example subdirs from tree URLs', () => {
    expect(
      parseGitHubRepoUrl(
        'https://github.com/TanStack/router/tree/main/examples/react/authenticated-routes'
      )
    ).toEqual({
      owner: 'TanStack',
      repo: 'router',
      ref: 'main',
      subdir: 'examples/react/authenticated-routes',
      sourceUrl: 'https://github.com/TanStack/router',
      archiveUrl: 'https://codeload.github.com/TanStack/router/tar.gz/main',
    });
  });

  it('parses deep Svelte vite-plugin-svelte e2e subdirs from tree URLs', () => {
    expect(
      parseGitHubRepoUrl(
        'https://github.com/sveltejs/vite-plugin-svelte/tree/main/packages/e2e-tests/env'
      )
    ).toEqual({
      owner: 'sveltejs',
      repo: 'vite-plugin-svelte',
      ref: 'main',
      subdir: 'packages/e2e-tests/env',
      sourceUrl: 'https://github.com/sveltejs/vite-plugin-svelte',
      archiveUrl: 'https://codeload.github.com/sveltejs/vite-plugin-svelte/tar.gz/main',
    });
  });

  it('parses tree URLs with hidden .output subdirs from Modern.js deploy artifacts', () => {
    expect(
      parseGitHubRepoUrl(
        'https://github.com/web-infra-dev/modern-js-examples/tree/main/examples/deploy/self-built-node/.output/html/main'
      )
    ).toEqual({
      owner: 'web-infra-dev',
      repo: 'modern-js-examples',
      ref: 'main',
      subdir: 'examples/deploy/self-built-node/.output/html/main',
      sourceUrl: 'https://github.com/web-infra-dev/modern-js-examples',
      archiveUrl: 'https://codeload.github.com/web-infra-dev/modern-js-examples/tar.gz/main',
    });
  });

  it('parses deep Modern.js e2e fixture subdirs with static outputs', () => {
    expect(
      parseGitHubRepoUrl(
        'https://github.com/web-infra-dev/modern.js/tree/main/tests/e2e/builder/cases/html/minify/static'
      )
    ).toEqual({
      owner: 'web-infra-dev',
      repo: 'modern.js',
      ref: 'main',
      subdir: 'tests/e2e/builder/cases/html/minify/static',
      sourceUrl: 'https://github.com/web-infra-dev/modern.js',
      archiveUrl: 'https://codeload.github.com/web-infra-dev/modern.js/tar.gz/main',
    });
  });

  it('parses deep Modern.js dist-html fixture subdirs', () => {
    expect(
      parseGitHubRepoUrl(
        'https://github.com/web-infra-dev/modern.js/tree/main/packages/server/server/tests/fixtures/pure/test-dist/html/main'
      )
    ).toEqual({
      owner: 'web-infra-dev',
      repo: 'modern.js',
      ref: 'main',
      subdir: 'packages/server/server/tests/fixtures/pure/test-dist/html/main',
      sourceUrl: 'https://github.com/web-infra-dev/modern.js',
      archiveUrl: 'https://codeload.github.com/web-infra-dev/modern.js/tar.gz/main',
    });
  });

  it('parses modern-js-examples playwright-report subdir URLs', () => {
    expect(
      parseGitHubRepoUrl(
        'https://github.com/web-infra-dev/modern-js-examples/tree/main/examples/test-playwright/playwright-report'
      )
    ).toEqual({
      owner: 'web-infra-dev',
      repo: 'modern-js-examples',
      ref: 'main',
      subdir: 'examples/test-playwright/playwright-report',
      sourceUrl: 'https://github.com/web-infra-dev/modern-js-examples',
      archiveUrl: 'https://codeload.github.com/web-infra-dev/modern-js-examples/tar.gz/main',
    });
  });

  it('parses github shorthand URLs', () => {
    expect(parseGitHubRepoUrl('github:acme/demo#feature/alpha')).toEqual({
      owner: 'acme',
      repo: 'demo',
      ref: 'feature/alpha',
      sourceUrl: 'https://github.com/acme/demo',
      archiveUrl: 'https://codeload.github.com/acme/demo/tar.gz/feature%2Falpha',
    });
  });

  it('imports github archives into virtual filesystem', async () => {
    const vfs = new VirtualFS();
    const archive = pako.gzip(
      createMinimalTarball({
        'package/README.md': '# Demo',
        'package/examples/app/package.json': '{"name":"app","version":"1.0.0"}',
        'package/examples/app/index.js': 'module.exports = "ok";',
      })
    );

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr === 'https://codeload.github.com/acme/demo/tar.gz/main') {
        return new Response(archive, { status: 200 });
      }
      return new Response('not-found', { status: 404 });
    });

    const result = await importGitHubRepo(
      vfs,
      'https://github.com/acme/demo/tree/main/examples/app',
      { destPath: '/project' }
    );

    expect(result.rootPath).toBe('/project');
    expect(result.projectPath).toBe('/project/examples/app');
    expect(vfs.existsSync('/project/README.md')).toBe(true);
    expect(vfs.existsSync('/project/examples/app/package.json')).toBe(true);
    expect(vfs.readFileSync('/project/examples/app/index.js', 'utf8')).toContain('module.exports');
  });

  it('imports dotted .output subdir projects from tree URLs', async () => {
    const vfs = new VirtualFS();
    const archive = pako.gzip(
      createMinimalTarball({
        'package/examples/deploy/self-built-node/.output/html/main/index.html': '<h1>Hello Modern</h1>',
      })
    );

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr === 'https://codeload.github.com/web-infra-dev/modern-js-examples/tar.gz/main') {
        return new Response(archive, { status: 200 });
      }
      return new Response('not-found', { status: 404 });
    });

    const result = await importGitHubRepo(
      vfs,
      'https://github.com/web-infra-dev/modern-js-examples/tree/main/examples/deploy/self-built-node/.output/html/main',
      { destPath: '/project' }
    );

    expect(result.projectPath).toBe('/project/examples/deploy/self-built-node/.output/html/main');
    expect(vfs.existsSync('/project/examples/deploy/self-built-node/.output/html/main/index.html')).toBe(true);
  });

  it('imports deep e2e static fixture subdirs from tree URLs', async () => {
    const vfs = new VirtualFS();
    const archive = pako.gzip(
      createMinimalTarball({
        'package/tests/e2e/builder/cases/html/minify/static/index.html': '<h1>fixture</h1>',
      })
    );

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr === 'https://codeload.github.com/web-infra-dev/modern.js/tar.gz/main') {
        return new Response(archive, { status: 200 });
      }
      return new Response('not-found', { status: 404 });
    });

    const result = await importGitHubRepo(
      vfs,
      'https://github.com/web-infra-dev/modern.js/tree/main/tests/e2e/builder/cases/html/minify/static',
      { destPath: '/project' }
    );

    expect(result.projectPath).toBe('/project/tests/e2e/builder/cases/html/minify/static');
    expect(vfs.existsSync('/project/tests/e2e/builder/cases/html/minify/static/index.html')).toBe(true);
  });

  it('imports deep dist-html fixture subdirs from tree URLs', async () => {
    const vfs = new VirtualFS();
    const archive = pako.gzip(
      createMinimalTarball({
        'package/packages/server/server/tests/fixtures/pure/test-dist/html/main/index.html': '<h1>dist-html</h1>',
      })
    );

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr === 'https://codeload.github.com/web-infra-dev/modern.js/tar.gz/main') {
        return new Response(archive, { status: 200 });
      }
      return new Response('not-found', { status: 404 });
    });

    const result = await importGitHubRepo(
      vfs,
      'https://github.com/web-infra-dev/modern.js/tree/main/packages/server/server/tests/fixtures/pure/test-dist/html/main',
      { destPath: '/project' }
    );

    expect(result.projectPath).toBe('/project/packages/server/server/tests/fixtures/pure/test-dist/html/main');
    expect(vfs.existsSync('/project/packages/server/server/tests/fixtures/pure/test-dist/html/main/index.html')).toBe(true);
  });

  it('imports playwright-report subdirs from tree URLs', async () => {
    const vfs = new VirtualFS();
    const archive = pako.gzip(
      createMinimalTarball({
        'package/examples/test-playwright/playwright-report/index.html': '<h1>report</h1>',
      })
    );

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr === 'https://codeload.github.com/web-infra-dev/modern-js-examples/tar.gz/main') {
        return new Response(archive, { status: 200 });
      }
      return new Response('not-found', { status: 404 });
    });

    const result = await importGitHubRepo(
      vfs,
      'https://github.com/web-infra-dev/modern-js-examples/tree/main/examples/test-playwright/playwright-report',
      { destPath: '/project' }
    );

    expect(result.projectPath).toBe('/project/examples/test-playwright/playwright-report');
    expect(vfs.existsSync('/project/examples/test-playwright/playwright-report/index.html')).toBe(true);
  });

  it('imports deep Svelte vite-plugin-svelte e2e subdirs from tree URLs', async () => {
    const vfs = new VirtualFS();
    const archive = pako.gzip(
      createMinimalTarball({
        'package/packages/e2e-tests/env/package.json': '{"name":"env","private":true}',
        'package/packages/e2e-tests/env/index.html': '<h1>Hello world!</h1>',
      })
    );

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr === 'https://codeload.github.com/sveltejs/vite-plugin-svelte/tar.gz/main') {
        return new Response(archive, { status: 200 });
      }
      return new Response('not-found', { status: 404 });
    });

    const result = await importGitHubRepo(
      vfs,
      'https://github.com/sveltejs/vite-plugin-svelte/tree/main/packages/e2e-tests/env',
      { destPath: '/project' }
    );

    expect(result.projectPath).toBe('/project/packages/e2e-tests/env');
    expect(vfs.existsSync('/project/packages/e2e-tests/env/index.html')).toBe(true);
    expect(vfs.existsSync('/project/packages/e2e-tests/env/package.json')).toBe(true);
  });

  it('falls back to CORS proxy in browser mode when direct archive fetch fails', async () => {
    const vfs = new VirtualFS();
    const archive = pako.gzip(
      createMinimalTarball({
        'package/package.json': '{"name":"app","version":"1.0.0"}',
      })
    );

    const originalWindow = (globalThis as any).window;
    const originalDocument = (globalThis as any).document;
    const originalLocalStorage = (globalThis as any).localStorage;

    (globalThis as any).window = {};
    (globalThis as any).document = {};
    (globalThis as any).localStorage = {
      getItem: () => null,
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr === 'https://codeload.github.com/acme/demo/tar.gz/HEAD') {
        throw new TypeError('Failed to fetch');
      }
      if (urlStr.startsWith('https://cors.isomorphic-git.org/')) {
        return new Response(archive, { status: 200 });
      }
      return new Response('not-found', { status: 404 });
    });

    try {
      const result = await importGitHubRepo(
        vfs,
        'https://github.com/acme/demo',
        { destPath: '/project' }
      );

      expect(result.projectPath).toBe('/project');
      expect(vfs.existsSync('/project/package.json')).toBe(true);
      const calledUrls = fetchSpy.mock.calls.map(call => String(call[0]));
      expect(calledUrls.some(url => url.startsWith('https://cors.isomorphic-git.org/'))).toBe(true);
    } finally {
      if (originalWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = originalWindow;
      if (originalDocument === undefined) delete (globalThis as any).document;
      else (globalThis as any).document = originalDocument;
      if (originalLocalStorage === undefined) delete (globalThis as any).localStorage;
      else (globalThis as any).localStorage = originalLocalStorage;
    }
  });

  it('uses local same-origin proxy candidate before public proxies in browser mode', async () => {
    const vfs = new VirtualFS();
    const archive = pako.gzip(
      createMinimalTarball({
        'package/package.json': '{"name":"proxied-app","version":"1.0.0"}',
      })
    );

    const originalWindow = (globalThis as any).window;
    const originalDocument = (globalThis as any).document;
    const originalLocalStorage = (globalThis as any).localStorage;
    const originalLocation = (globalThis as any).location;

    (globalThis as any).window = {};
    (globalThis as any).document = {};
    (globalThis as any).location = { origin: 'http://127.0.0.1:4173' };
    (globalThis as any).localStorage = {
      getItem: () => null,
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr === 'https://codeload.github.com/acme/demo/tar.gz/HEAD') {
        throw new TypeError('Failed to fetch');
      }
      if (urlStr.startsWith('http://127.0.0.1:4173/__proxy__?url=')) {
        return new Response(archive, { status: 200 });
      }
      return new Response('not-found', { status: 404 });
    });

    try {
      const result = await importGitHubRepo(vfs, 'https://github.com/acme/demo', {
        destPath: '/project',
      });

      expect(result.projectPath).toBe('/project');
      expect(vfs.existsSync('/project/package.json')).toBe(true);

      const calledUrls = fetchSpy.mock.calls.map(call => String(call[0]));
      expect(calledUrls.some(url =>
        url.startsWith('http://127.0.0.1:4173/__proxy__?url=')
      )).toBe(true);
    } finally {
      if (originalWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = originalWindow;
      if (originalDocument === undefined) delete (globalThis as any).document;
      else (globalThis as any).document = originalDocument;
      if (originalLocalStorage === undefined) delete (globalThis as any).localStorage;
      else (globalThis as any).localStorage = originalLocalStorage;
      if (originalLocation === undefined) delete (globalThis as any).location;
      else (globalThis as any).location = originalLocation;
    }
  });

  it('falls back to GitHub API file import when archive and proxies fail', async () => {
    const vfs = new VirtualFS();

    const originalWindow = (globalThis as any).window;
    const originalDocument = (globalThis as any).document;
    const originalLocalStorage = (globalThis as any).localStorage;

    (globalThis as any).window = {};
    (globalThis as any).document = {};
    (globalThis as any).localStorage = {
      getItem: () => null,
    };

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr === 'https://codeload.github.com/acme/demo/tar.gz/HEAD') {
        throw new TypeError('Failed to fetch');
      }
      if (urlStr.startsWith('https://cors.isomorphic-git.org/')) {
        return new Response('forbidden', { status: 403 });
      }
      if (urlStr.startsWith('https://corsproxy.io/?')) {
        return new Response('forbidden', { status: 403 });
      }
      if (urlStr === 'https://api.github.com/repos/acme/demo/git/trees/HEAD?recursive=1') {
        return new Response(
          JSON.stringify({
            tree: [
              {
                path: 'package.json',
                type: 'blob',
              },
              {
                path: 'src/index.js',
                type: 'blob',
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (urlStr === 'https://raw.githubusercontent.com/acme/demo/HEAD/package.json') {
        return new Response('{"name":"demo"}', { status: 200 });
      }
      if (urlStr === 'https://raw.githubusercontent.com/acme/demo/HEAD/src/index.js') {
        return new Response('module.exports = 123;', { status: 200 });
      }

      return new Response('not-found', { status: 404 });
    });

    try {
      const result = await importGitHubRepo(vfs, 'https://github.com/acme/demo', {
        destPath: '/project',
      });

      expect(result.projectPath).toBe('/project');
      expect(vfs.readFileSync('/project/package.json', 'utf8')).toContain('"name":"demo"');
      expect(vfs.readFileSync('/project/src/index.js', 'utf8')).toContain('module.exports = 123');
    } finally {
      if (originalWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = originalWindow;
      if (originalDocument === undefined) delete (globalThis as any).document;
      else (globalThis as any).document = originalDocument;
      if (originalLocalStorage === undefined) delete (globalThis as any).localStorage;
      else (globalThis as any).localStorage = originalLocalStorage;
    }
  });

  it('retries raw file downloads via CORS proxy during API fallback', async () => {
    const vfs = new VirtualFS();

    const originalWindow = (globalThis as any).window;
    const originalDocument = (globalThis as any).document;
    const originalLocalStorage = (globalThis as any).localStorage;

    (globalThis as any).window = {};
    (globalThis as any).document = {};
    (globalThis as any).localStorage = {
      getItem: () => null,
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr === 'https://codeload.github.com/acme/demo/tar.gz/HEAD') {
        throw new TypeError('Failed to fetch');
      }
      if (urlStr.startsWith('https://cors.isomorphic-git.org/https%3A%2F%2Fcodeload.github.com%2Facme%2Fdemo%2Ftar.gz%2FHEAD')) {
        return new Response('forbidden', { status: 403 });
      }
      if (urlStr.startsWith('https://corsproxy.io/?https%3A%2F%2Fcodeload.github.com%2Facme%2Fdemo%2Ftar.gz%2FHEAD')) {
        return new Response('forbidden', { status: 403 });
      }
      if (urlStr === 'https://api.github.com/repos/acme/demo/git/trees/HEAD?recursive=1') {
        return new Response(
          JSON.stringify({
            tree: [
              { path: 'package.json', type: 'blob' },
              { path: 'src/index.js', type: 'blob' },
            ],
          }),
          { status: 200 }
        );
      }
      if (urlStr === 'https://raw.githubusercontent.com/acme/demo/HEAD/package.json') {
        throw new TypeError('Failed to fetch');
      }
      if (urlStr.startsWith('https://cors.isomorphic-git.org/https%3A%2F%2Fraw.githubusercontent.com%2Facme%2Fdemo%2FHEAD%2Fpackage.json')) {
        return new Response('{"name":"demo"}', { status: 200 });
      }
      if (urlStr === 'https://raw.githubusercontent.com/acme/demo/HEAD/src/index.js') {
        return new Response('module.exports = 321;', { status: 200 });
      }
      return new Response('not-found', { status: 404 });
    });

    try {
      const result = await importGitHubRepo(vfs, 'https://github.com/acme/demo', {
        destPath: '/project',
      });

      expect(result.projectPath).toBe('/project');
      expect(vfs.readFileSync('/project/package.json', 'utf8')).toContain('"name":"demo"');
      expect(vfs.readFileSync('/project/src/index.js', 'utf8')).toContain('module.exports = 321');

      const calledUrls = fetchSpy.mock.calls.map(call => String(call[0]));
      expect(calledUrls.some(url =>
        url.startsWith('https://cors.isomorphic-git.org/https%3A%2F%2Fraw.githubusercontent.com%2Facme%2Fdemo%2FHEAD%2Fpackage.json')
      )).toBe(true);
    } finally {
      if (originalWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = originalWindow;
      if (originalDocument === undefined) delete (globalThis as any).document;
      else (globalThis as any).document = originalDocument;
      if (originalLocalStorage === undefined) delete (globalThis as any).localStorage;
      else (globalThis as any).localStorage = originalLocalStorage;
    }
  });

  it('falls back to GitHub contents API when raw file fetch fails completely', async () => {
    const vfs = new VirtualFS();

    const originalWindow = (globalThis as any).window;
    const originalDocument = (globalThis as any).document;
    const originalLocalStorage = (globalThis as any).localStorage;

    (globalThis as any).window = {};
    (globalThis as any).document = {};
    (globalThis as any).localStorage = {
      getItem: () => null,
    };

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr === 'https://codeload.github.com/acme/demo/tar.gz/HEAD') {
        throw new TypeError('Failed to fetch');
      }
      if (urlStr.startsWith('https://cors.isomorphic-git.org/')) {
        return new Response('forbidden', { status: 403 });
      }
      if (urlStr.startsWith('https://corsproxy.io/?')) {
        return new Response('forbidden', { status: 403 });
      }
      if (urlStr === 'https://api.github.com/repos/acme/demo/git/trees/HEAD?recursive=1') {
        return new Response(
          JSON.stringify({
            tree: [{ path: 'package.json', type: 'blob' }],
          }),
          { status: 200 }
        );
      }
      if (urlStr === 'https://raw.githubusercontent.com/acme/demo/HEAD/package.json') {
        throw new TypeError('Failed to fetch');
      }
      if (urlStr.startsWith('https://cors.isomorphic-git.org/https%3A%2F%2Fraw.githubusercontent.com%2Facme%2Fdemo%2FHEAD%2Fpackage.json')) {
        return new Response('forbidden', { status: 403 });
      }
      if (urlStr.startsWith('https://corsproxy.io/?https%3A%2F%2Fraw.githubusercontent.com%2Facme%2Fdemo%2FHEAD%2Fpackage.json')) {
        return new Response('forbidden', { status: 403 });
      }
      if (urlStr === 'https://api.github.com/repos/acme/demo/contents/package.json?ref=HEAD') {
        return new Response(
          JSON.stringify({
            encoding: 'base64',
            content: Buffer.from('{"name":"via-contents"}', 'utf8').toString('base64'),
          }),
          { status: 200 }
        );
      }
      return new Response('not-found', { status: 404 });
    });

    try {
      const result = await importGitHubRepo(vfs, 'https://github.com/acme/demo', {
        destPath: '/project',
      });

      expect(result.projectPath).toBe('/project');
      expect(vfs.readFileSync('/project/package.json', 'utf8')).toContain('"name":"via-contents"');
    } finally {
      if (originalWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = originalWindow;
      if (originalDocument === undefined) delete (globalThis as any).document;
      else (globalThis as any).document = originalDocument;
      if (originalLocalStorage === undefined) delete (globalThis as any).localStorage;
      else (globalThis as any).localStorage = originalLocalStorage;
    }
  });

  it('reuses archive cache for repeated imports of the same repo/ref', async () => {
    const originalCacheEnabled = process.env.ALMOSTBUN_ENABLE_ARCHIVE_CACHE;
    process.env.ALMOSTBUN_ENABLE_ARCHIVE_CACHE = '1';

    const firstVfs = new VirtualFS();
    const secondVfs = new VirtualFS();
    const archive = pako.gzip(
      createMinimalTarball({
        'package/package.json': '{"name":"cached-demo","version":"1.0.0"}',
      })
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr === 'https://codeload.github.com/acme/demo/tar.gz/main') {
        return new Response(archive, { status: 200 });
      }
      return new Response('not-found', { status: 404 });
    });

    try {
      await importGitHubRepo(firstVfs, 'https://github.com/acme/demo/tree/main', {
        destPath: '/project',
      });
      await importGitHubRepo(secondVfs, 'https://github.com/acme/demo/tree/main', {
        destPath: '/project',
      });
    } finally {
      if (originalCacheEnabled === undefined) {
        delete process.env.ALMOSTBUN_ENABLE_ARCHIVE_CACHE;
      } else {
        process.env.ALMOSTBUN_ENABLE_ARCHIVE_CACHE = originalCacheEnabled;
      }
    }

    expect(firstVfs.existsSync('/project/package.json')).toBe(true);
    expect(secondVfs.existsSync('/project/package.json')).toBe(true);
    const archiveCalls = fetchSpy.mock.calls.filter(
      call => String(call[0]) === 'https://codeload.github.com/acme/demo/tar.gz/main'
    );
    expect(archiveCalls).toHaveLength(1);
  });

  it('can disable archive cache via ALMOSTBUN_ARCHIVE_CACHE_MAX_ENTRIES=0', async () => {
    const originalCacheEnabled = process.env.ALMOSTBUN_ENABLE_ARCHIVE_CACHE;
    const originalMaxEntries = process.env.ALMOSTBUN_ARCHIVE_CACHE_MAX_ENTRIES;
    process.env.ALMOSTBUN_ENABLE_ARCHIVE_CACHE = '1';
    process.env.ALMOSTBUN_ARCHIVE_CACHE_MAX_ENTRIES = '0';

    const firstVfs = new VirtualFS();
    const secondVfs = new VirtualFS();
    const archive = pako.gzip(
      createMinimalTarball({
        'package/package.json': '{"name":"no-cache","version":"1.0.0"}',
      })
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr === 'https://codeload.github.com/acme/demo/tar.gz/main') {
        return new Response(archive, { status: 200 });
      }
      return new Response('not-found', { status: 404 });
    });

    try {
      await importGitHubRepo(firstVfs, 'https://github.com/acme/demo/tree/main', {
        destPath: '/project',
      });
      await importGitHubRepo(secondVfs, 'https://github.com/acme/demo/tree/main', {
        destPath: '/project',
      });
    } finally {
      if (originalCacheEnabled === undefined) {
        delete process.env.ALMOSTBUN_ENABLE_ARCHIVE_CACHE;
      } else {
        process.env.ALMOSTBUN_ENABLE_ARCHIVE_CACHE = originalCacheEnabled;
      }
      if (originalMaxEntries === undefined) {
        delete process.env.ALMOSTBUN_ARCHIVE_CACHE_MAX_ENTRIES;
      } else {
        process.env.ALMOSTBUN_ARCHIVE_CACHE_MAX_ENTRIES = originalMaxEntries;
      }
    }

    const archiveCalls = fetchSpy.mock.calls.filter(
      call => String(call[0]) === 'https://codeload.github.com/acme/demo/tar.gz/main'
    );
    expect(archiveCalls).toHaveLength(2);
  });
});

function createMinimalTarball(files: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];

  for (const [filename, content] of Object.entries(files)) {
    const contentBytes = encoder.encode(content);
    const header = new Uint8Array(512);

    const nameBytes = encoder.encode(filename);
    header.set(nameBytes.slice(0, 100), 0);
    header.set(encoder.encode('0000644\0'), 100);
    header.set(encoder.encode('0000000\0'), 108);
    header.set(encoder.encode('0000000\0'), 116);

    const sizeOctal = contentBytes.length.toString(8).padStart(11, '0') + ' ';
    header.set(encoder.encode(sizeOctal), 124);
    header.set(encoder.encode('00000000000\0'), 136);
    header.set(encoder.encode('        '), 148);
    header[156] = 48;

    let checksum = 0;
    for (let i = 0; i < 512; i++) {
      checksum += header[i];
    }
    const checksumStr = checksum.toString(8).padStart(6, '0') + '\0 ';
    header.set(encoder.encode(checksumStr), 148);

    chunks.push(header);

    const paddedSize = Math.ceil(contentBytes.length / 512) * 512;
    const paddedContent = new Uint8Array(paddedSize);
    paddedContent.set(contentBytes);
    chunks.push(paddedContent);
  }

  chunks.push(new Uint8Array(1024));

  const totalSize = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}
