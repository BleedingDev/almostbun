import { defineConfig } from 'vite';
import { resolve } from 'path';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

const isTest = process.env.VITEST === 'true';
const ALLOWED_PROXY_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'raw.githubusercontent.com',
  'registry.npmjs.org',
]);
export default defineConfig({
  base: '/',
  test: {
    // Exclude e2e tests - they should be run with `npm run test:e2e`
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/e2e/**',
      '**/examples/**/e2e/**',
    ],
  },
  plugins: isTest ? [] : [
    wasm(),
    topLevelAwait(),
    {
      name: 'browser-shims',
      enforce: 'pre',
      resolveId(source) {
        if (source === 'bun') {
          return resolve(__dirname, 'src/shims/bun.ts');
        }
        if (source === 'bun:sqlite') {
          return resolve(__dirname, 'src/shims/bun-sqlite.ts');
        }
        if (source === 'bun:test') {
          return resolve(__dirname, 'src/shims/bun-test.ts');
        }
        if (source === 'bun:ffi') {
          return resolve(__dirname, 'src/shims/bun-ffi.ts');
        }
        if (source === 'bun:jsc') {
          return resolve(__dirname, 'src/shims/bun-jsc.ts');
        }
        if (source === 'node:zlib' || source === 'zlib') {
          return resolve(__dirname, 'src/shims/zlib.ts');
        }
        if (source === 'brotli-wasm/pkg.web/brotli_wasm.js') {
          return resolve(__dirname, 'node_modules/brotli-wasm/pkg.web/brotli_wasm.js');
        }
        if (source === 'brotli-wasm/pkg.web/brotli_wasm_bg.wasm?url') {
          return {
            id: resolve(__dirname, 'node_modules/brotli-wasm/pkg.web/brotli_wasm_bg.wasm') + '?url',
            external: false,
          };
        }
        return null;
      },
    },
    {
      name: 'dev-http-proxy',
      configureServer(server) {
        server.middlewares.use('/__proxy__', async (req, res, next) => {
          try {
            if (req.method !== 'GET') {
              next();
              return;
            }

            const url = new URL(req.url || '', 'http://localhost');
            const targetRaw = url.searchParams.get('url');
            if (!targetRaw) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ error: 'Missing "url" query parameter' }));
              return;
            }

            let targetUrl;
            try {
              targetUrl = new URL(targetRaw);
            } catch {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ error: 'Invalid target URL' }));
              return;
            }

            if (!['http:', 'https:'].includes(targetUrl.protocol)) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ error: 'Unsupported protocol' }));
              return;
            }

            if (!ALLOWED_PROXY_HOSTS.has(targetUrl.hostname)) {
              res.statusCode = 403;
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ error: `Host not allowed: ${targetUrl.hostname}` }));
              return;
            }

            const upstream = await fetch(targetUrl.toString(), {
              method: 'GET',
              headers: {
                'User-Agent': 'almostbun-dev-proxy',
                'Accept': req.headers.accept || '*/*',
              },
            });

            res.statusCode = upstream.status;
            const passthroughHeaders = ['content-type', 'content-length', 'location', 'etag', 'cache-control'];
            for (const headerName of passthroughHeaders) {
              const value = upstream.headers.get(headerName);
              if (value) {
                res.setHeader(headerName, value);
              }
            }
            res.setHeader('Access-Control-Allow-Origin', '*');

            const body = Buffer.from(await upstream.arrayBuffer());
            res.end(body);
          } catch (error) {
            res.statusCode = 502;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            }));
          }
        });
      },
    },
  ],
  define: isTest ? {} : {
    'process.env': {},
    global: 'globalThis',
  },
  server: {
    headers: {
      'Cross-Origin-Embedder-Policy': 'credentialless',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
    fs: {
      allow: [resolve(__dirname, './'), resolve(__dirname, 'node_modules')],
    },
  },
  resolve: {
    alias: isTest ? {} : {
      'node:zlib': resolve(__dirname, 'src/shims/zlib.ts'),
      'zlib': resolve(__dirname, 'src/shims/zlib.ts'),
      'bun': resolve(__dirname, 'src/shims/bun.ts'),
      'bun:sqlite': resolve(__dirname, 'src/shims/bun-sqlite.ts'),
      'bun:test': resolve(__dirname, 'src/shims/bun-test.ts'),
      'bun:ffi': resolve(__dirname, 'src/shims/bun-ffi.ts'),
      'bun:jsc': resolve(__dirname, 'src/shims/bun-jsc.ts'),
      'buffer': 'buffer',
      'process': 'process/browser',
    },
  },
  optimizeDeps: {
    include: isTest ? [] : ['buffer', 'process', 'pako'],
    exclude: ['brotli-wasm', 'convex'],
    esbuildOptions: { target: 'esnext' },
  },
  worker: {
    format: 'es',
  },
  build: {
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        'examples/index': resolve(__dirname, 'examples/index.html'),
        'examples/next-demo': resolve(__dirname, 'examples/next-demo.html'),
        'examples/vite-demo': resolve(__dirname, 'examples/vite-demo.html'),
        'examples/express-demo': resolve(__dirname, 'examples/express-demo.html'),
        'examples/repo-runner': resolve(__dirname, 'examples/repo-runner.html'),
        'docs/index': resolve(__dirname, 'docs/index.html'),
        'docs/core-concepts': resolve(__dirname, 'docs/core-concepts.html'),
        'docs/nextjs-guide': resolve(__dirname, 'docs/nextjs-guide.html'),
        'docs/vite-guide': resolve(__dirname, 'docs/vite-guide.html'),
        'docs/security': resolve(__dirname, 'docs/security.html'),
        'docs/api-reference': resolve(__dirname, 'docs/api-reference.html'),
        'docs/tutorial-editor': resolve(__dirname, 'docs/tutorial-editor.html'),
        'examples/editor-tutorial': resolve(__dirname, 'examples/editor-tutorial.html'),
      },
    },
    outDir: 'dist-site',
  },
  assetsInclude: ['**/*.wasm'],
});
