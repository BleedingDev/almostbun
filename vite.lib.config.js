import { defineConfig } from 'vite';
import { resolve } from 'path';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

export default defineConfig({
  plugins: [
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
  ],
  define: {
    'process.env': {},
    global: 'globalThis',
  },
  resolve: {
    alias: {
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
  worker: {
    format: 'es',
    plugins: () => [
      wasm(),
      topLevelAwait(),
    ],
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        'vite-plugin': resolve(__dirname, 'src/vite-plugin.ts'),
        'next-plugin': resolve(__dirname, 'src/next-plugin.ts'),
      },
      name: 'JustNode',
      formats: ['es', 'cjs'],
      fileName: (format, entryName) => `${entryName}.${format === 'es' ? 'mjs' : 'cjs'}`,
    },
    rollupOptions: {
      external: [
        'brotli-wasm',
        'pako',
        'comlink',
        'just-bash',
        'resolve.exports',
        'brotli',
        // Node.js built-ins for vite-plugin
        'fs',
        'path',
        'url',
        'vite',
      ],
      output: {
        globals: {
          'brotli-wasm': 'brotliWasm',
          'pako': 'pako',
          'comlink': 'Comlink',
          'just-bash': 'justBash',
          'resolve.exports': 'resolveExports',
        },
      },
    },
    sourcemap: true,
    minify: false,
  },
  assetsInclude: ['**/*.wasm'],
});
