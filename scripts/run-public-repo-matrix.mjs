#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';

function parseArgs(argv) {
  const parsed = {
    names: '',
    report: '',
    strictLogs: false,
  };

  for (const arg of argv) {
    if (arg === '--strict-logs') {
      parsed.strictLogs = true;
      continue;
    }
    if (arg.startsWith('--names=')) {
      parsed.names = arg.slice('--names='.length).trim();
      continue;
    }
    if (arg.startsWith('--report=')) {
      parsed.report = arg.slice('--report='.length).trim();
      continue;
    }
  }

  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const reportPath = args.report
  ? path.resolve(process.cwd(), args.report)
  : path.resolve(process.cwd(), 'test-results/public-repo-matrix-report.json');

const env = {
  ...process.env,
  RUN_PUBLIC_REPO_MATRIX: '1',
  PUBLIC_REPO_MATRIX_REPORT_PATH: reportPath,
};

if (args.names) {
  env.PUBLIC_REPO_MATRIX_NAMES = args.names;
}
if (args.strictLogs) {
  env.PUBLIC_REPO_STRICT_LOG_VALIDATION = '1';
}

const child = spawn(
  'npm',
  ['run', 'test:run', '--', 'tests/repo-public-compat.test.ts'],
  {
    stdio: 'inherit',
    env,
  }
);

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
