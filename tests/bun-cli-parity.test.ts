import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Runtime } from '../src/runtime';
import { VirtualFS } from '../src/virtual-fs';

type ParityFixture = {
  name: string;
  entry: string;
  files: Record<string, string>;
};

const FIXTURES: ParityFixture[] = [
  {
    name: 'exports-subpath-require',
    entry: 'entry.cjs',
    files: {
      'entry.cjs': `
const root = require('cond-pkg');
const feature = require('cond-pkg/feature');
module.exports = { root, feature };
if (require.main === module) {
  console.log(JSON.stringify(module.exports));
}
`,
      'node_modules/cond-pkg/package.json': JSON.stringify({
        name: 'cond-pkg',
        exports: {
          '.': {
            require: './require.js',
            default: './default.js',
          },
          './feature': {
            require: './feature-require.js',
            default: './feature-default.js',
          },
        },
      }),
      'node_modules/cond-pkg/require.js': 'module.exports = "require-root";',
      'node_modules/cond-pkg/default.js': 'module.exports = "default-root";',
      'node_modules/cond-pkg/feature-require.js': 'module.exports = "feature-require";',
      'node_modules/cond-pkg/feature-default.js': 'module.exports = "feature-default";',
    },
  },
  {
    name: 'main-resolution-precedence',
    entry: 'entry.cjs',
    files: {
      'entry.cjs': `
const value = require('main-pkg');
module.exports = { value };
if (require.main === module) {
  console.log(JSON.stringify(module.exports));
}
`,
      'node_modules/main-pkg/package.json': JSON.stringify({
        name: 'main-pkg',
        main: 'dist/index.cjs',
        module: 'dist/index.mjs',
      }),
      'node_modules/main-pkg/dist/index.cjs': 'module.exports = "from-main-cjs";',
      'node_modules/main-pkg/dist/index.mjs': 'export default "from-module-mjs";',
    },
  },
  {
    name: 'json-and-relative',
    entry: 'entry.cjs',
    files: {
      'entry.cjs': `
const data = require('./data.json');
const helper = require('./lib/helper');
module.exports = { data, helper };
if (require.main === module) {
  console.log(JSON.stringify(module.exports));
}
`,
      'data.json': JSON.stringify({ ok: true, count: 3 }),
      'lib/helper.js': 'module.exports = { greeting: "hello", sum: 2 + 3 };',
    },
  },
];

function isBunAvailable(): boolean {
  const result = spawnSync('bun', ['--version'], {
    encoding: 'utf8',
  });
  return !result.error && result.status === 0;
}

function normalizeForComparison(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe.skipIf(process.env.RUN_BUN_CLI_PARITY !== '1')('bun cli parity', () => {
  it(
    'matches Bun CLI outputs for resolver-heavy fixtures',
    async () => {
      if (!isBunAvailable()) {
        throw new Error('RUN_BUN_CLI_PARITY=1 requires Bun to be installed and available in PATH');
      }

      for (const fixture of FIXTURES) {
        const tempDir = await mkdtemp(path.join(tmpdir(), 'almostbun-parity-'));
        try {
          for (const [relativePath, content] of Object.entries(fixture.files)) {
            const absPath = path.join(tempDir, relativePath);
            await mkdir(path.dirname(absPath), { recursive: true });
            await writeFile(absPath, content, 'utf8');
          }

          const bunResult = spawnSync('bun', [fixture.entry], {
            cwd: tempDir,
            encoding: 'utf8',
          });

          if (bunResult.error) {
            throw bunResult.error;
          }
          expect(bunResult.status, `bun failed for fixture ${fixture.name}: ${bunResult.stderr}`).toBe(0);

          const bunOutputRaw = bunResult.stdout.trim().split('\n').filter(Boolean).at(-1) || '';
          const bunOutput = bunOutputRaw ? JSON.parse(bunOutputRaw) : null;

          const vfs = new VirtualFS();
          for (const [relativePath, content] of Object.entries(fixture.files)) {
            vfs.writeFileSync(path.posix.join('/project', relativePath).replace(/\\/g, '/'), content);
          }

          const runtime = new Runtime(vfs, { cwd: '/project' });
          const runtimeResult = runtime.runFile(path.posix.join('/project', fixture.entry));
          const runtimeOutput = normalizeForComparison(runtimeResult.exports);

          expect(runtimeOutput).toEqual(bunOutput);
        } finally {
          await rm(tempDir, { recursive: true, force: true });
        }
      }
    },
    60_000
  );
});
