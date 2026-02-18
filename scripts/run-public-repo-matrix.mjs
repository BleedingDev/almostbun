#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SENTINEL_CASES_PATH = path.join(SCRIPT_DIR, 'public-repo-sentinel-cases.json');

function parseNameList(raw) {
  return raw
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function readNamesFromFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const trimmed = content.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error(`Expected array in names file: ${filePath}`);
    }
    return parsed.map((item) => String(item).trim()).filter(Boolean);
  }
  return parseNameList(content);
}

function parseArgs(argv) {
  const parsed = {
    profile: 'full',
    names: '',
    namesFile: '',
    report: '',
    strictLogs: false,
    shardIndex: '',
    shardTotal: '',
    artifactsDir: '',
    captureScreenshots: false,
  };

  for (const arg of argv) {
    if (arg === '--strict-logs') {
      parsed.strictLogs = true;
      continue;
    }
    if (arg === '--screenshots') {
      parsed.captureScreenshots = true;
      continue;
    }
    if (arg.startsWith('--profile=')) {
      parsed.profile = arg.slice('--profile='.length).trim() || 'full';
      continue;
    }
    if (arg.startsWith('--names=')) {
      parsed.names = arg.slice('--names='.length).trim();
      continue;
    }
    if (arg.startsWith('--names-file=')) {
      parsed.namesFile = arg.slice('--names-file='.length).trim();
      continue;
    }
    if (arg.startsWith('--report=')) {
      parsed.report = arg.slice('--report='.length).trim();
      continue;
    }
    if (arg.startsWith('--shard-index=')) {
      parsed.shardIndex = arg.slice('--shard-index='.length).trim();
      continue;
    }
    if (arg.startsWith('--shard-total=')) {
      parsed.shardTotal = arg.slice('--shard-total='.length).trim();
      continue;
    }
    if (arg.startsWith('--shard=')) {
      const value = arg.slice('--shard='.length).trim();
      const [index, total] = value.split('/', 2);
      parsed.shardIndex = index?.trim() || '';
      parsed.shardTotal = total?.trim() || '';
      continue;
    }
    if (arg.startsWith('--artifacts-dir=')) {
      parsed.artifactsDir = arg.slice('--artifacts-dir='.length).trim();
      continue;
    }
  }

  return parsed;
}

const args = parseArgs(process.argv.slice(2));
if (!['full', 'sentinel'].includes(args.profile)) {
  throw new Error(`Unsupported --profile value "${args.profile}". Use "full" or "sentinel".`);
}

let resolvedNames = args.names;
if (!resolvedNames && args.namesFile) {
  const namesPath = path.resolve(process.cwd(), args.namesFile);
  resolvedNames = readNamesFromFile(namesPath).join(',');
}
if (!resolvedNames && args.profile === 'sentinel') {
  resolvedNames = readNamesFromFile(DEFAULT_SENTINEL_CASES_PATH).join(',');
}

const reportPath = args.report
  ? path.resolve(process.cwd(), args.report)
  : path.resolve(process.cwd(), 'test-results/public-repo-matrix-report.json');

const env = {
  ...process.env,
  RUN_PUBLIC_REPO_MATRIX: '1',
  PUBLIC_REPO_MATRIX_REPORT_PATH: reportPath,
  PUBLIC_REPO_MATRIX_PROFILE: args.profile,
};

if (resolvedNames) {
  env.PUBLIC_REPO_MATRIX_NAMES = resolvedNames;
}
if (args.strictLogs) {
  env.PUBLIC_REPO_STRICT_LOG_VALIDATION = '1';
}
if (args.shardIndex) {
  env.PUBLIC_REPO_MATRIX_SHARD_INDEX = args.shardIndex;
}
if (args.shardTotal) {
  env.PUBLIC_REPO_MATRIX_SHARD_TOTAL = args.shardTotal;
}
if (args.artifactsDir) {
  env.PUBLIC_REPO_MATRIX_ARTIFACTS_DIR = path.resolve(process.cwd(), args.artifactsDir);
}
if (args.captureScreenshots) {
  env.PUBLIC_REPO_CAPTURE_SCREENSHOTS = '1';
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
