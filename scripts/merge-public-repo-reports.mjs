#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const parsed = {
    inputsDir: '',
    output: '',
  };

  for (const arg of argv) {
    if (arg.startsWith('--inputs-dir=')) {
      parsed.inputsDir = arg.slice('--inputs-dir='.length).trim();
      continue;
    }
    if (arg.startsWith('--output=')) {
      parsed.output = arg.slice('--output='.length).trim();
      continue;
    }
  }

  return parsed;
}

function readReports(dirPath) {
  const entries = fs.readdirSync(dirPath)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => path.join(dirPath, entry));

  if (entries.length === 0) {
    throw new Error(`No JSON reports found in ${dirPath}`);
  }

  return entries.map((entryPath) => {
    const report = JSON.parse(fs.readFileSync(entryPath, 'utf8'));
    return {
      source: path.basename(entryPath),
      report,
    };
  });
}

function mergeReports(items) {
  const merged = {
    version: 1,
    generatedAt: items[0]?.report?.generatedAt || new Date().toISOString(),
    completedAt: new Date().toISOString(),
    totalCases: 0,
    passCount: 0,
    failCount: 0,
    strictLogValidation: false,
    caseTimeoutMs: 0,
    retries: 0,
    shardIndex: 0,
    shardTotal: items.length,
    results: [],
    sources: items.map((item) => item.source),
  };

  for (const { report } of items) {
    const results = Array.isArray(report.results) ? report.results : [];
    merged.totalCases += Number(report.totalCases) || results.length;
    merged.passCount += Number(report.passCount) || results.filter((result) => result.status === 'pass').length;
    merged.failCount += Number(report.failCount) || results.filter((result) => result.status !== 'pass').length;
    merged.strictLogValidation = merged.strictLogValidation || report.strictLogValidation === true;
    merged.caseTimeoutMs = Math.max(merged.caseTimeoutMs, Number(report.caseTimeoutMs) || 0);
    merged.retries = Math.max(merged.retries, Number(report.retries) || 0);
    merged.results.push(...results);
  }

  return merged;
}

const args = parseArgs(process.argv.slice(2));
if (!args.inputsDir) {
  throw new Error('Missing required argument --inputs-dir=<dir>');
}
if (!args.output) {
  throw new Error('Missing required argument --output=<merged-report.json>');
}

const inputsDirPath = path.resolve(process.cwd(), args.inputsDir);
const outputPath = path.resolve(process.cwd(), args.output);
const merged = mergeReports(readReports(inputsDirPath));
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
console.log(`Merged ${merged.sources.length} reports into ${outputPath}`);
