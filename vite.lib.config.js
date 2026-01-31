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
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'JustNode',
      formats: ['es', 'cjs'],
      fileName: (format) => `index.${format === 'es' ? 'mjs' : 'cjs'}`,
    },
    rollupOptions: {
      external: [
        'brotli-wasm',
        'pako',
        'comlink',
        'just-bash',
        'resolve.exports',
        'brotli',
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
