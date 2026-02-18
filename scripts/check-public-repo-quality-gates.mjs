#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import {
  readJson,
  normalizeReport,
  computeReportMetrics,
} from './public-repo-report-metrics.mjs';

function parseArgs(argv) {
  const parsed = {
    input: '',
    baseline: '',
    output: '',
    mode: 'enforce',
  };

  for (const arg of argv) {
    if (arg.startsWith('--input=')) {
      parsed.input = arg.slice('--input='.length).trim();
      continue;
    }
    if (arg.startsWith('--baseline=')) {
      parsed.baseline = arg.slice('--baseline='.length).trim();
      continue;
    }
    if (arg.startsWith('--output=')) {
      parsed.output = arg.slice('--output='.length).trim();
      continue;
    }
    if (arg.startsWith('--mode=')) {
      parsed.mode = arg.slice('--mode='.length).trim() || parsed.mode;
      continue;
    }
  }

  return parsed;
}

function formatCheckLine(name, passed, actual, expected) {
  const status = passed ? 'PASS' : 'FAIL';
  return `- [${status}] ${name}: actual=${actual}, expected=${expected}`;
}

const args = parseArgs(process.argv.slice(2));
if (!args.input) {
  throw new Error('Missing required --input=<report.json>');
}
if (!args.baseline) {
  throw new Error('Missing required --baseline=<baseline.json>');
}

const reportPath = path.resolve(process.cwd(), args.input);
const baselinePath = path.resolve(process.cwd(), args.baseline);
const report = normalizeReport(readJson(reportPath));
const baseline = readJson(baselinePath);
const metrics = computeReportMetrics(report);

const checks = [];
checks.push({
  name: 'Pass rate',
  actual: Number(metrics.passRatePct.toFixed(2)),
  expected: `>= ${baseline.gates.minPassRatePct}`,
  passed: metrics.passRatePct >= baseline.gates.minPassRatePct,
});
checks.push({
  name: 'Fail count',
  actual: metrics.failCount,
  expected: `<= ${baseline.gates.maxFailCount}`,
  passed: metrics.failCount <= baseline.gates.maxFailCount,
});
checks.push({
  name: 'p90 duration (ms)',
  actual: Math.round(metrics.p90DurationMs),
  expected: `<= ${baseline.gates.maxP90DurationMs}`,
  passed: metrics.p90DurationMs <= baseline.gates.maxP90DurationMs,
});

const stageGateLimits = baseline.gates.maxStageDropOffCounts || {};
for (const [stageKey, maxValue] of Object.entries(stageGateLimits)) {
  const actual = metrics.stageDropOffCounts?.[stageKey] || 0;
  checks.push({
    name: `Stage drop-off: ${stageKey}`,
    actual,
    expected: `<= ${maxValue}`,
    passed: actual <= maxValue,
  });
}

const failedChecks = checks.filter((check) => !check.passed);
const gatePassed = failedChecks.length === 0;
const mode = args.mode === 'report-only' ? 'report-only' : 'enforce';

const lines = [];
lines.push('# Public Repo Quality Gates');
lines.push('');
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push(`Mode: ${mode}`);
lines.push(`Report: ${path.relative(process.cwd(), reportPath)}`);
lines.push(`Baseline: ${path.relative(process.cwd(), baselinePath)}`);
lines.push('');
lines.push('## Current Metrics');
lines.push('');
lines.push(`- Total cases: ${metrics.totalCases}`);
lines.push(`- Pass count: ${metrics.passCount}`);
lines.push(`- Fail count: ${metrics.failCount}`);
lines.push(`- Pass rate: ${metrics.passRatePct.toFixed(2)}%`);
lines.push(`- p50 duration: ${Math.round(metrics.p50DurationMs)} ms`);
lines.push(`- p90 duration: ${Math.round(metrics.p90DurationMs)} ms`);
lines.push('');
lines.push('## Gate Checks');
lines.push('');
for (const check of checks) {
  lines.push(formatCheckLine(check.name, check.passed, check.actual, check.expected));
}
lines.push('');
lines.push(`## Result: ${gatePassed ? 'PASS' : 'FAIL'}`);
if (!gatePassed && mode === 'report-only') {
  lines.push('Report-only mode is enabled, so failures do not fail the process.');
}
lines.push('');

const markdown = lines.join('\n');
process.stdout.write(markdown);
if (!markdown.endsWith('\n')) {
  process.stdout.write('\n');
}

if (args.output) {
  const outputPath = path.resolve(process.cwd(), args.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, markdown + '\n', 'utf8');
}

if (!gatePassed && mode !== 'report-only') {
  process.exit(1);
}
