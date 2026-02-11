/**
 * Node.js child_process module shim
 * Uses just-bash for command execution in browser with VirtualFS adapter
 */

// Polyfill process for just-bash (it expects Node.js environment)
if (typeof globalThis.process === 'undefined') {
  (globalThis as any).process = {
    env: {
      HOME: '/home/user',
      USER: 'user',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      NODE_ENV: 'development',
    },
    cwd: () => '/',
    platform: 'linux',
    version: 'v18.0.0',
    versions: { node: '18.0.0' },
    stdout: { write: () => {} },
    stderr: { write: () => {} },
  };
}

import { Bash, defineCommand } from 'just-bash';
import type { CommandContext, ExecResult as JustBashExecResult } from 'just-bash';
import { EventEmitter } from './events';
import { Readable, Writable, Buffer } from './stream';
import type { VirtualFS } from '../virtual-fs';
import { VirtualFSAdapter } from './vfs-adapter';
import { Runtime } from '../runtime';
import type { PackageJson } from '../types/package-json';

// Singleton bash instance - uses VFS adapter for two-way file sync
let bashInstance: Bash | null = null;
let vfsAdapter: VirtualFSAdapter | null = null;
let currentVfs: VirtualFS | null = null;

// Module-level streaming callbacks for long-running commands (e.g. vitest watch)
// Set by container.run() before calling exec, cleared after
let _streamStdout: ((data: string) => void) | null = null;
let _streamStderr: ((data: string) => void) | null = null;
let _abortSignal: AbortSignal | null = null;

/**
 * Set streaming callbacks for the next command execution.
 * Used by container.run() to enable streaming output from custom commands.
 */
export function setStreamingCallbacks(opts: {
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  signal?: AbortSignal;
}): void {
  _streamStdout = opts.onStdout || null;
  _streamStderr = opts.onStderr || null;
  _abortSignal = opts.signal || null;
}

/**
 * Clear streaming callbacks after command execution.
 */
export function clearStreamingCallbacks(): void {
  _streamStdout = null;
  _streamStderr = null;
  _abortSignal = null;
}

/**
 * Initialize the child_process shim with a VirtualFS instance
 * Creates a single Bash instance with VirtualFSAdapter for efficient file access
 */
export function initChildProcess(vfs: VirtualFS): void {
  currentVfs = vfs;
  vfsAdapter = new VirtualFSAdapter(vfs);

  // Create custom 'node' command that runs JS files using the Runtime
  const nodeCommand = defineCommand('node', async (args, ctx) => {
    if (!currentVfs) {
      return { stdout: '', stderr: 'VFS not initialized\n', exitCode: 1 };
    }

    const scriptPath = args[0];
    if (!scriptPath) {
      return { stdout: '', stderr: 'Usage: node <script.js> [args...]\n', exitCode: 1 };
    }

    // Resolve the script path
    const resolvedPath = scriptPath.startsWith('/')
      ? scriptPath
      : `${ctx.cwd}/${scriptPath}`.replace(/\/+/g, '/');

    try {
      // Check if file exists
      if (!currentVfs.existsSync(resolvedPath)) {
        return { stdout: '', stderr: `Error: Cannot find module '${resolvedPath}'\n`, exitCode: 1 };
      }

      let stdout = '';
      let stderr = '';

      // Create a runtime with the current environment
      const runtime = new Runtime(currentVfs, {
        cwd: ctx.cwd,
        env: ctx.env,
        onConsole: (method, consoleArgs) => {
          const msg = consoleArgs.map(a => String(a)).join(' ') + '\n';
          if (method === 'error') {
            stderr += msg;
          } else {
            stdout += msg;
          }
        },
      });

      // Set up process.argv for the script
      const processShim = (globalThis as any).process || {};
      const originalArgv = processShim.argv;
      processShim.argv = ['node', resolvedPath, ...args.slice(1)];
      (globalThis as any).process = processShim;

      try {
        // Run the script
        runtime.runFile(resolvedPath);
        return { stdout, stderr, exitCode: 0 };
      } finally {
        // Restore original argv
        processShim.argv = originalArgv;
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { stdout: '', stderr: `Error: ${errorMsg}\n`, exitCode: 1 };
    }
  });

  // Create custom 'convex' command that runs the Convex CLI
  const convexCommand = defineCommand('convex', async (args, ctx) => {
    if (!currentVfs) {
      return { stdout: '', stderr: 'VFS not initialized\n', exitCode: 1 };
    }

    // Find the Convex CLI bundle
    const cliBundlePath = '/node_modules/convex/dist/cli.bundle.cjs';
    if (!currentVfs.existsSync(cliBundlePath)) {
      return { stdout: '', stderr: 'Convex CLI not found. Run: npm install convex\n', exitCode: 1 };
    }

    let stdout = '';
    let stderr = '';

    try {
      // Create a runtime with the current environment
      const runtime = new Runtime(currentVfs, {
        cwd: ctx.cwd,
        env: ctx.env,
        onConsole: (method, consoleArgs) => {
          const msg = consoleArgs.map(a => String(a)).join(' ') + '\n';
          if (method === 'error') {
            stderr += msg;
          } else {
            stdout += msg;
          }
        },
      });

      // Set up process.argv for the CLI
      const processShim = (globalThis as any).process || {};
      const originalArgv = processShim.argv;
      const originalEnv = { ...processShim.env };

      processShim.argv = ['node', 'convex', ...args];
      processShim.env = { ...processShim.env, ...ctx.env };
      (globalThis as any).process = processShim;

      try {
        // Run the CLI bundle
        runtime.runFile(cliBundlePath);
        return { stdout, stderr, exitCode: 0 };
      } finally {
        // Restore original state
        processShim.argv = originalArgv;
        processShim.env = originalEnv;
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { stdout, stderr: stderr + `Error: ${errorMsg}\n`, exitCode: 1 };
    }
  });

  // Create custom 'npm' command that runs scripts from package.json
  const npmCommand = defineCommand('npm', async (args, ctx) => {
    if (!currentVfs) {
      return { stdout: '', stderr: 'VFS not initialized\n', exitCode: 1 };
    }

    const subcommand = args[0];

    if (!subcommand || subcommand === 'help' || subcommand === '--help') {
      return {
        stdout: 'Usage: npm <command>\n\nCommands:\n  run <script>   Run a script from package.json\n  start          Run the start script\n  test           Run the test script\n  install [pkg]  Install packages\n  ls             List installed packages\n',
        stderr: '',
        exitCode: 0,
      };
    }

    switch (subcommand) {
      case 'run':
      case 'run-script':
        return handleNpmRun(args.slice(1), ctx);
      case 'start':
        return handleNpmRun(['start'], ctx);
      case 'test':
      case 't':
      case 'tst':
        return handleNpmRun(['test'], ctx);
      case 'install':
      case 'i':
      case 'add':
        return handleNpmInstall(args.slice(1), ctx);
      case 'ls':
      case 'list':
        return handleNpmList(ctx);
      default:
        return {
          stdout: '',
          stderr: `npm ERR! Unknown command: "${subcommand}"\n`,
          exitCode: 1,
        };
    }
  });

  /**
   * Find test files in the given directory (recursive, skips node_modules)
   */
  function findTestFiles(dir: string): string[] {
    const testFiles: string[] = [];
    const testPattern = /\.(test|spec)\.(js|ts|jsx|tsx|mjs|cjs)$/;

    function walk(currentDir: string) {
      try {
        const entries = currentVfs!.readdirSync(currentDir);
        for (const entry of entries) {
          if (entry === 'node_modules' || entry === '.git') continue;
          const fullPath = `${currentDir}/${entry}`.replace(/\/+/g, '/');
          try {
            const stat = currentVfs!.statSync(fullPath);
            if (stat.isDirectory()) {
              walk(fullPath);
            } else if (testPattern.test(entry)) {
              testFiles.push(fullPath);
            }
          } catch {
            // Skip files that can't be stat'd
          }
        }
      } catch {
        // Directory doesn't exist or can't be read
      }
    }

    walk(dir);
    return testFiles.sort();
  }

  // Vitest shim code — uses real @vitest/expect for assertions
  // Written to VFS so require('vitest') resolves naturally through Runtime
  const vitestShimCode = `
// Vitest shim for almostnode — uses real @vitest/expect for assertions
var expectModule = require('@vitest/expect');

// Register jest-like matchers (.toBe, .toContain, etc.) on chai
expectModule.chai.use(expectModule.JestChaiExpect);
expectModule.chai.use(expectModule.JestExtend);

var chaiExpect = expectModule.chai.expect;

// Results collector
var results = globalThis.__vitestResults;

function expect(actual) {
  return chaiExpect(actual);
}
expect.assertions = function() {};
expect.hasAssertions = function() {};

function describe(name, fn) {
  var suite = { name: name, tests: [], passed: 0, failed: 0 };
  results.suites.push(suite);
  var prevSuite = results.current;
  results.current = suite;
  try { fn(); } finally { results.current = prevSuite; }
}

function it(name, fn) {
  var suite = results.current || { name: '', tests: [], passed: 0, failed: 0 };
  if (!results.current) results.suites.push(suite);
  var testEntry = { name: name, passed: false, error: null, duration: 0 };
  suite.tests.push(testEntry);
  if (globalThis.__vitestBeforeEach) {
    try { globalThis.__vitestBeforeEach(); } catch(e) {}
  }
  var start = Date.now();
  try {
    fn();
    testEntry.passed = true;
    testEntry.duration = Date.now() - start;
    suite.passed++;
  } catch(e) {
    testEntry.error = e && e.message ? e.message : String(e);
    testEntry.duration = Date.now() - start;
    suite.failed++;
  }
  if (globalThis.__vitestAfterEach) {
    try { globalThis.__vitestAfterEach(); } catch(e) {}
  }
}

function vi_fn() {
  var f = function() { f.mock.calls.push(Array.prototype.slice.call(arguments)); return undefined; };
  f.mock = { calls: [] };
  f.mockReturnValue = function(v) { var orig = f; f = function() { orig.mock.calls.push(Array.prototype.slice.call(arguments)); return v; }; f.mock = orig.mock; return f; };
  f.mockImplementation = function(impl) { var orig = f; f = function() { orig.mock.calls.push(Array.prototype.slice.call(arguments)); return impl.apply(null, arguments); }; f.mock = orig.mock; return f; };
  return f;
}

module.exports = {
  describe: describe,
  it: it,
  test: it,
  expect: expect,
  vi: { fn: vi_fn },
  beforeAll: function(fn) { fn(); },
  afterAll: function() {},
  beforeEach: function(fn) { globalThis.__vitestBeforeEach = fn; },
  afterEach: function(fn) { globalThis.__vitestAfterEach = fn; },
  suite: describe,
};
`;

  /**
   * Write the vitest shim to VFS so require('vitest') resolves to our wrapper.
   * Must be called once before running tests. Separated from runTestsOnce()
   * to avoid triggering VFS watchers during watch mode re-runs.
   */
  function writeVitestShim(): void {
    currentVfs!.writeFileSync('/node_modules/vitest/index.cjs', vitestShimCode);
    currentVfs!.writeFileSync('/node_modules/vitest/dist/index.js', vitestShimCode);
  }

  /**
   * Run all test files once and return formatted output.
   * Reusable by both batch mode (vitest run) and watch mode (vitest).
   * Does NOT write to VFS — call writeVitestShim() before the first run.
   */
  function runTestsOnce(testFiles: string[], ctx: CommandContext): { stdout: string; stderr: string; exitCode: number } {
    let stdout = '';
    let stderr = '';
    const startTime = Date.now();

    let totalTests = 0;
    let totalPassed = 0;
    let totalFailed = 0;
    let filesPassed = 0;
    let filesFailed = 0;
    const failures: Array<{ file: string; suite: string; test: string; error: string }> = [];

    stdout += '\n';

    for (const testFile of testFiles) {
      if (!currentVfs!.existsSync(testFile)) {
        stderr += `File not found: ${testFile}\n`;
        filesFailed++;
        continue;
      }

      const runtime = new Runtime(currentVfs!, {
        cwd: ctx.cwd,
        env: { ...ctx.env, NODE_ENV: 'test' },
        onConsole: (method: string, consoleArgs: unknown[]) => {
          const msg = consoleArgs.map(a => String(a)).join(' ') + '\n';
          if (method === 'error' || method === 'warn') {
            stderr += msg;
          } else {
            stdout += msg;
          }
        },
      });

      (globalThis as any).__vitestResults = { suites: [], current: null };

      try {
        runtime.runFile(testFile);

        const results = (globalThis as any).__vitestResults;
        let filePassed = true;

        for (const suite of results.suites) {
          for (const test of suite.tests) {
            totalTests++;
            if (test.passed) {
              totalPassed++;
              const suiteName = suite.name ? `${suite.name} > ` : '';
              stdout += ` \x1b[32m✓\x1b[0m ${suiteName}${test.name} \x1b[2m${test.duration}ms\x1b[0m\n`;
            } else {
              totalFailed++;
              filePassed = false;
              const suiteName = suite.name ? `${suite.name} > ` : '';
              stdout += ` \x1b[31m✗\x1b[0m ${suiteName}${test.name} \x1b[2m${test.duration}ms\x1b[0m\n`;
              failures.push({
                file: testFile,
                suite: suite.name,
                test: test.name,
                error: test.error || 'Unknown error',
              });
            }
          }
        }

        if (filePassed) filesPassed++;
        else filesFailed++;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        stderr += `Error running ${testFile}: ${errorMsg}\n`;
        filesFailed++;
      }
    }

    // Print failure details
    if (failures.length > 0) {
      stdout += '\n';
      for (const f of failures) {
        stdout += ` \x1b[31mFAIL\x1b[0m ${f.suite ? f.suite + ' > ' : ''}${f.test}\n`;
        stdout += `   ${f.error}\n\n`;
      }
    }

    // Print summary
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    const totalFiles = filesPassed + filesFailed;
    stdout += '\n';

    if (filesFailed > 0) {
      stdout += ` Test Files  \x1b[31m${filesFailed} failed\x1b[0m`;
      if (filesPassed > 0) stdout += ` | \x1b[32m${filesPassed} passed\x1b[0m`;
      stdout += ` (${totalFiles})\n`;
    } else {
      stdout += ` Test Files  \x1b[32m${filesPassed} passed\x1b[0m (${totalFiles})\n`;
    }

    if (totalFailed > 0) {
      stdout += `      Tests  \x1b[31m${totalFailed} failed\x1b[0m`;
      if (totalPassed > 0) stdout += ` | \x1b[32m${totalPassed} passed\x1b[0m`;
      stdout += ` (${totalTests})\n`;
    } else {
      stdout += `      Tests  \x1b[32m${totalPassed} passed\x1b[0m (${totalTests})\n`;
    }

    stdout += `   Duration  ${duration}s\n`;

    return { stdout, stderr, exitCode: totalFailed > 0 ? 1 : 0 };
  }

  // Create custom 'vitest' command that runs tests using real vitest packages
  // Uses @vitest/runner for describe/it/test and @vitest/expect for assertions
  // Supports: vitest run (batch), vitest / vitest watch (watch mode with VFS watchers)
  const vitestCommand = defineCommand('vitest', async (args, ctx) => {
    if (!currentVfs) {
      return { stdout: '', stderr: 'VFS not initialized\n', exitCode: 1 };
    }

    // Check if vitest is installed (we need @vitest/runner and @vitest/expect)
    if (!currentVfs.existsSync('/node_modules/@vitest/runner/package.json') ||
        !currentVfs.existsSync('/node_modules/@vitest/expect/package.json')) {
      return {
        stdout: '',
        stderr: 'vitest not installed. Run: npm install vitest\n',
        exitCode: 1,
      };
    }

    // Parse args: "vitest run" (batch), "vitest" or "vitest watch" (watch mode)
    const subcommand = args[0];
    const isRunMode = subcommand === 'run' || subcommand === '--run';
    const isWatchMode = !subcommand || subcommand === 'watch' || subcommand === '--watch';

    if (subcommand && !isRunMode && !isWatchMode) {
      // Allow file paths as direct args (no subcommand)
      const looksLikeFile = subcommand.includes('.') || subcommand.startsWith('/') || subcommand.startsWith('./');
      if (!looksLikeFile) {
        return {
          stdout: '',
          stderr: `Unknown command: vitest ${subcommand}\nSupported: vitest run [file], vitest watch, vitest [file]\n`,
          exitCode: 1,
        };
      }
    }

    // Find test files: specific file from args, or discover *.test.* / *.spec.* files
    const specificFile = args.find(a => !a.startsWith('-') && a !== 'run' && a !== 'watch');
    const testFiles = specificFile
      ? [specificFile.startsWith('/') ? specificFile : `${ctx.cwd}/${specificFile}`.replace(/\/+/g, '/')]
      : findTestFiles(ctx.cwd);

    if (testFiles.length === 0) {
      return {
        stdout: '',
        stderr: 'No test files found.\nVitest looks for files matching: *.test.{js,ts,jsx,tsx}, *.spec.{js,ts,jsx,tsx}\n',
        exitCode: 1,
      };
    }

    // Write vitest shim once before any test runs
    writeVitestShim();

    // Batch mode: run once and return
    if (isRunMode) {
      return runTestsOnce(testFiles, ctx);
    }

    // Watch mode: run tests, watch VFS for changes, re-run on change
    const initialResult = runTestsOnce(testFiles, ctx);

    // If no streaming callback, fall back to batch mode
    if (!_streamStdout) {
      return initialResult;
    }

    // Stream initial results
    _streamStdout(initialResult.stdout);
    if (_streamStderr && initialResult.stderr) {
      _streamStderr(initialResult.stderr);
    }

    _streamStdout('\n\x1b[2m[watch] waiting for file changes...\x1b[0m\n');

    // Set up VFS watcher for re-running on file changes
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let isRerunning = false;

    const watcher = currentVfs.watch('/', { recursive: true }, (_eventType: string, filename: string | null) => {
      if (!filename || filename.includes('node_modules')) return;
      if (isRerunning) return; // Guard against re-entrant triggers
      // Debounce rapid changes (e.g. editor saves)
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        isRerunning = true;
        try {
          // Re-discover test files in case new ones were added
          const currentTestFiles = specificFile ? testFiles : findTestFiles(ctx.cwd);
          if (currentTestFiles.length === 0) return;

          if (_streamStdout) {
            _streamStdout('\n\x1b[2m[watch] re-running tests...\x1b[0m\n');
          }
          const result = runTestsOnce(currentTestFiles, ctx);
          if (_streamStdout) _streamStdout(result.stdout);
          if (_streamStderr && result.stderr) _streamStderr(result.stderr);
          if (_streamStdout) {
            _streamStdout('\n\x1b[2m[watch] waiting for file changes...\x1b[0m\n');
          }
        } finally {
          isRerunning = false;
        }
      }, 300);
    });

    // Wait for abort signal to stop watching
    return new Promise<JustBashExecResult>((resolve) => {
      if (_abortSignal) {
        _abortSignal.addEventListener('abort', () => {
          if (debounceTimer) clearTimeout(debounceTimer);
          watcher.close();
          if (_streamStdout) {
            _streamStdout('\n\x1b[2m[watch] stopped\x1b[0m\n');
          }
          resolve({ stdout: '', stderr: '', exitCode: 0 });
        });
      }
      // If no abort signal, the command will hang forever — this is intentional
      // for long-running watch mode. Callers should always provide a signal.
    });
  });

  bashInstance = new Bash({
    fs: vfsAdapter,
    cwd: '/',
    env: {
      HOME: '/home/user',
      USER: 'user',
      PATH: '/usr/local/bin:/usr/bin:/bin:/node_modules/.bin',
      NODE_ENV: 'development',
    },
    customCommands: [nodeCommand, convexCommand, npmCommand, vitestCommand],
  });
}

/**
 * Read and parse package.json from the VFS
 */
function readPackageJson(cwd: string): { pkgJson: PackageJson; error?: undefined } | { pkgJson?: undefined; error: JustBashExecResult } {
  const pkgJsonPath = `${cwd}/package.json`.replace(/\/+/g, '/');

  if (!currentVfs!.existsSync(pkgJsonPath)) {
    return {
      error: {
        stdout: '',
        stderr: 'npm ERR! no package.json found\n',
        exitCode: 1,
      },
    };
  }

  try {
    const pkgJson = JSON.parse(currentVfs!.readFileSync(pkgJsonPath, 'utf8')) as PackageJson;
    return { pkgJson };
  } catch {
    return {
      error: {
        stdout: '',
        stderr: 'npm ERR! Failed to parse package.json\n',
        exitCode: 1,
      },
    };
  }
}

/**
 * Handle `npm run [script]` — execute a script from package.json
 */
async function handleNpmRun(args: string[], ctx: CommandContext): Promise<JustBashExecResult> {
  const scriptName = args[0];

  // "npm run" with no script name: list available scripts
  if (!scriptName) {
    return listScripts(ctx);
  }

  const result = readPackageJson(ctx.cwd);
  if (result.error) return result.error;
  const pkgJson = result.pkgJson;

  const scripts = pkgJson.scripts || {};
  const scriptCommand = scripts[scriptName];

  if (!scriptCommand) {
    const available = Object.keys(scripts);
    let msg = `npm ERR! Missing script: "${scriptName}"\n`;
    if (available.length > 0) {
      msg += '\nnpm ERR! Available scripts:\n';
      for (const name of available) {
        msg += `npm ERR!   ${name}\n`;
        msg += `npm ERR!     ${scripts[name]}\n`;
      }
    }
    return { stdout: '', stderr: msg, exitCode: 1 };
  }

  if (!ctx.exec) {
    return {
      stdout: '',
      stderr: 'npm ERR! Script execution not available in this context\n',
      exitCode: 1,
    };
  }

  // Set up npm-specific environment variables
  const npmEnv: Record<string, string> = {
    ...ctx.env,
    npm_lifecycle_event: scriptName,
  };
  if (pkgJson.name) npmEnv.npm_package_name = pkgJson.name;
  if (pkgJson.version) npmEnv.npm_package_version = pkgJson.version;

  let allStdout = '';
  let allStderr = '';
  const label = `${pkgJson.name || ''}@${pkgJson.version || ''}`;

  // Run pre<script> if it exists
  const preScript = scripts[`pre${scriptName}`];
  if (preScript) {
    allStderr += `\n> ${label} pre${scriptName}\n> ${preScript}\n\n`;
    const preResult = await ctx.exec(preScript, { cwd: ctx.cwd, env: npmEnv });
    allStdout += preResult.stdout;
    allStderr += preResult.stderr;
    if (preResult.exitCode !== 0) {
      return { stdout: allStdout, stderr: allStderr, exitCode: preResult.exitCode };
    }
  }

  // Run the main script
  allStderr += `\n> ${label} ${scriptName}\n> ${scriptCommand}\n\n`;
  const mainResult = await ctx.exec(scriptCommand, { cwd: ctx.cwd, env: npmEnv });
  allStdout += mainResult.stdout;
  allStderr += mainResult.stderr;

  if (mainResult.exitCode !== 0) {
    return { stdout: allStdout, stderr: allStderr, exitCode: mainResult.exitCode };
  }

  // Run post<script> if it exists
  const postScript = scripts[`post${scriptName}`];
  if (postScript) {
    allStderr += `\n> ${label} post${scriptName}\n> ${postScript}\n\n`;
    const postResult = await ctx.exec(postScript, { cwd: ctx.cwd, env: npmEnv });
    allStdout += postResult.stdout;
    allStderr += postResult.stderr;
    if (postResult.exitCode !== 0) {
      return { stdout: allStdout, stderr: allStderr, exitCode: postResult.exitCode };
    }
  }

  return { stdout: allStdout, stderr: allStderr, exitCode: 0 };
}

/**
 * List available scripts from package.json (when `npm run` is called with no args)
 */
function listScripts(ctx: CommandContext): JustBashExecResult {
  const result = readPackageJson(ctx.cwd);
  if (result.error) return result.error;
  const pkgJson = result.pkgJson;

  const scripts = pkgJson.scripts || {};
  const names = Object.keys(scripts);

  if (names.length === 0) {
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  const lifecycle = ['prestart', 'start', 'poststart', 'pretest', 'test', 'posttest', 'prestop', 'stop', 'poststop'];
  const lifecyclePresent = names.filter(n => lifecycle.includes(n));
  const customPresent = names.filter(n => !lifecycle.includes(n));

  let output = `Lifecycle scripts included in ${pkgJson.name || ''}:\n`;
  for (const name of lifecyclePresent) {
    output += `  ${name}\n    ${scripts[name]}\n`;
  }
  if (customPresent.length > 0) {
    output += '\navailable via `npm run-script`:\n';
    for (const name of customPresent) {
      output += `  ${name}\n    ${scripts[name]}\n`;
    }
  }

  return { stdout: output, stderr: '', exitCode: 0 };
}

/**
 * Handle `npm install [pkg]` — bridge to PackageManager
 */
async function handleNpmInstall(args: string[], ctx: CommandContext): Promise<JustBashExecResult> {
  const { PackageManager } = await import('../npm/index');
  const pm = new PackageManager(currentVfs!, { cwd: ctx.cwd });

  let stdout = '';

  try {
    const pkgArgs = args.filter(a => !a.startsWith('-'));
    if (pkgArgs.length === 0) {
      // npm install (no package name) -> install from package.json
      const installResult = await pm.installFromPackageJson({
        onProgress: (msg: string) => { stdout += msg + '\n'; },
      });
      stdout += `added ${installResult.added.length} packages\n`;
    } else {
      // npm install <pkg> [<pkg> ...]
      for (const arg of pkgArgs) {
        const installResult = await pm.install(arg, {
          save: true,
          onProgress: (msg: string) => { stdout += msg + '\n'; },
        });
        stdout += `added ${installResult.added.length} packages\n`;
      }
    }
    return { stdout, stderr: '', exitCode: 0 };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { stdout, stderr: `npm ERR! ${msg}\n`, exitCode: 1 };
  }
}

/**
 * Handle `npm ls` — list installed packages
 */
async function handleNpmList(ctx: CommandContext): Promise<JustBashExecResult> {
  const { PackageManager } = await import('../npm/index');
  const pm = new PackageManager(currentVfs!, { cwd: ctx.cwd });
  const packages = pm.list();
  const entries = Object.entries(packages);

  if (entries.length === 0) {
    return { stdout: '(empty)\n', stderr: '', exitCode: 0 };
  }

  let output = `${ctx.cwd}\n`;
  for (const [name, version] of entries) {
    output += `+-- ${name}@${version}\n`;
  }
  return { stdout: output, stderr: '', exitCode: 0 };
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  encoding?: BufferEncoding | 'buffer';
  timeout?: number;
  maxBuffer?: number;
  shell?: string | boolean;
}

export interface ExecResult {
  stdout: string | Buffer;
  stderr: string | Buffer;
}

export type ExecCallback = (
  error: Error | null,
  stdout: string | Buffer,
  stderr: string | Buffer
) => void;

/**
 * Execute a command in a shell
 */
export function exec(
  command: string,
  optionsOrCallback?: ExecOptions | ExecCallback,
  callback?: ExecCallback
): ChildProcess {
  let options: ExecOptions = {};
  let cb: ExecCallback | undefined;

  if (typeof optionsOrCallback === 'function') {
    cb = optionsOrCallback;
  } else if (optionsOrCallback) {
    options = optionsOrCallback;
    cb = callback;
  }

  const child = new ChildProcess();

  // Execute asynchronously
  (async () => {
    if (!bashInstance) {
      const error = new Error('child_process not initialized');
      child.emit('error', error);
      if (cb) cb(error, '', '');
      return;
    }

    try {
      const result = await bashInstance!.exec(command, {
        cwd: options.cwd,
        env: options.env,
      });

      const stdout = result.stdout || '';
      const stderr = result.stderr || '';

      // Emit data events
      if (stdout) {
        child.stdout?.push(Buffer.from(stdout));
      }
      child.stdout?.push(null);

      if (stderr) {
        child.stderr?.push(Buffer.from(stderr));
      }
      child.stderr?.push(null);

      // Emit close/exit
      child.emit('close', result.exitCode, null);
      child.emit('exit', result.exitCode, null);

      if (cb) {
        if (result.exitCode !== 0) {
          const error = new Error(`Command failed: ${command}`);
          (error as any).code = result.exitCode;
          cb(error, stdout, stderr);
        } else {
          cb(null, stdout, stderr);
        }
      }
    } catch (error) {
      child.emit('error', error);
      if (cb) cb(error as Error, '', '');
    }
  })();

  return child;
}

/**
 * Execute a command synchronously
 */
export function execSync(
  command: string,
  options?: ExecOptions
): string | Buffer {
  if (!bashInstance) {
    throw new Error('child_process not initialized');
  }

  // Note: just-bash exec is async, so we can't truly do sync execution
  // This is a limitation of the browser environment
  // For now, throw an error suggesting to use exec() instead
  throw new Error(
    'execSync is not supported in browser environment. Use exec() with async/await or callbacks instead.'
  );
}

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  shell?: boolean | string;
  stdio?: 'pipe' | 'inherit' | 'ignore' | Array<'pipe' | 'inherit' | 'ignore'>;
}

/**
 * Spawn a new process
 */
export function spawn(
  command: string,
  args?: string[] | SpawnOptions,
  options?: SpawnOptions
): ChildProcess {
  let spawnArgs: string[] = [];
  let spawnOptions: SpawnOptions = {};

  if (Array.isArray(args)) {
    spawnArgs = args;
    spawnOptions = options || {};
  } else if (args) {
    spawnOptions = args;
  }

  const child = new ChildProcess();

  // Build the full command
  const fullCommand = spawnArgs.length > 0
    ? `${command} ${spawnArgs.map(arg =>
        arg.includes(' ') ? `"${arg}"` : arg
      ).join(' ')}`
    : command;

  // Execute asynchronously
  (async () => {
    if (!bashInstance) {
      const error = new Error('child_process not initialized');
      child.emit('error', error);
      return;
    }

    try {
      const result = await bashInstance!.exec(fullCommand, {
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
      });

      const stdout = result.stdout || '';
      const stderr = result.stderr || '';

      // Emit data events
      if (stdout) {
        child.stdout?.push(Buffer.from(stdout));
      }
      child.stdout?.push(null);

      if (stderr) {
        child.stderr?.push(Buffer.from(stderr));
      }
      child.stderr?.push(null);

      // Emit close/exit
      child.emit('close', result.exitCode, null);
      child.emit('exit', result.exitCode, null);
    } catch (error) {
      child.emit('error', error);
    }
  })();

  return child;
}

/**
 * Spawn a new process synchronously
 */
export function spawnSync(
  command: string,
  args?: string[],
  options?: SpawnOptions
): { stdout: Buffer; stderr: Buffer; status: number; error?: Error } {
  throw new Error(
    'spawnSync is not supported in browser environment. Use spawn() instead.'
  );
}

/**
 * Execute a file
 */
export function execFile(
  file: string,
  args?: string[] | ExecOptions | ExecCallback,
  options?: ExecOptions | ExecCallback,
  callback?: ExecCallback
): ChildProcess {
  let execArgs: string[] = [];
  let execOptions: ExecOptions = {};
  let cb: ExecCallback | undefined;

  if (Array.isArray(args)) {
    execArgs = args;
    if (typeof options === 'function') {
      cb = options;
    } else if (options) {
      execOptions = options;
      cb = callback;
    }
  } else if (typeof args === 'function') {
    cb = args;
  } else if (args) {
    execOptions = args;
    cb = options as ExecCallback;
  }

  const command = execArgs.length > 0 ? `${file} ${execArgs.join(' ')}` : file;
  return exec(command, execOptions, cb);
}

/**
 * Fork is not supported in browser
 */
export function fork(): never {
  throw new Error('fork is not supported in browser environment');
}

/**
 * ChildProcess class
 */
export class ChildProcess extends EventEmitter {
  pid: number;
  connected: boolean = false;
  killed: boolean = false;
  exitCode: number | null = null;
  signalCode: string | null = null;
  spawnargs: string[] = [];
  spawnfile: string = '';

  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;

  constructor() {
    super();
    this.pid = Math.floor(Math.random() * 10000) + 1000;
    this.stdin = new Writable();
    this.stdout = new Readable();
    this.stderr = new Readable();
  }

  kill(signal?: string): boolean {
    this.killed = true;
    this.emit('exit', null, signal || 'SIGTERM');
    return true;
  }

  disconnect(): void {
    this.connected = false;
  }

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    // IPC not supported
    if (callback) callback(new Error('IPC not supported'));
    return false;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

export default {
  exec,
  execSync,
  execFile,
  spawn,
  spawnSync,
  fork,
  ChildProcess,
  initChildProcess,
  setStreamingCallbacks,
  clearStreamingCallbacks,
};
