#!/usr/bin/env node

import path from 'node:path';
import {
  readJson,
  writeJson,
  normalizeReport,
  computeReportMetrics,
} from './public-repo-report-metrics.mjs';

function parseArgs(argv) {
  const parsed = {
    input: '',
    output: '',
    profile: 'full',
    label: '',
    passRateTolerancePct: 3,
    failCountDelta: 5,
    p90Multiplier: 1.25,
    p90SlackMs: 20_000,
    stageSlack: 5,
  };

  for (const arg of argv) {
    if (arg.startsWith('--input=')) {
      parsed.input = arg.slice('--input='.length).trim();
      continue;
    }
    if (arg.startsWith('--output=')) {
      parsed.output = arg.slice('--output='.length).trim();
      continue;
    }
    if (arg.startsWith('--profile=')) {
      parsed.profile = arg.slice('--profile='.length).trim() || parsed.profile;
      continue;
    }
    if (arg.startsWith('--label=')) {
      parsed.label = arg.slice('--label='.length).trim();
      continue;
    }
    if (arg.startsWith('--pass-rate-tolerance=')) {
      parsed.passRateTolerancePct = Number(arg.slice('--pass-rate-tolerance='.length)) || parsed.passRateTolerancePct;
      continue;
    }
    if (arg.startsWith('--fail-delta=')) {
      parsed.failCountDelta = Number(arg.slice('--fail-delta='.length)) || parsed.failCountDelta;
      continue;
    }
    if (arg.startsWith('--p90-multiplier=')) {
      parsed.p90Multiplier = Number(arg.slice('--p90-multiplier='.length)) || parsed.p90Multiplier;
      continue;
    }
    if (arg.startsWith('--p90-slack-ms=')) {
      parsed.p90SlackMs = Number(arg.slice('--p90-slack-ms='.length)) || parsed.p90SlackMs;
      continue;
    }
    if (arg.startsWith('--stage-slack=')) {
      parsed.stageSlack = Number(arg.slice('--stage-slack='.length)) || parsed.stageSlack;
      continue;
    }
  }

  return parsed;
}

const args = parseArgs(process.argv.slice(2));
if (!args.input) {
  throw new Error('Missing required --input=<report.json>');
}
if (!args.output) {
  throw new Error('Missing required --output=<baseline.json>');
}

const reportPath = path.resolve(process.cwd(), args.input);
const report = normalizeReport(readJson(reportPath));
const metrics = computeReportMetrics(report);

const maxP90DurationMs = Math.max(
  1,
  Math.round(metrics.p90DurationMs * args.p90Multiplier + args.p90SlackMs)
);

const baseline = {
  version: 1,
  generatedAt: new Date().toISOString(),
  profile: args.profile,
  label: args.label || `${args.profile}-baseline`,
  sourceReportPath: path.relative(process.cwd(), reportPath),
  sourceReport: {
    generatedAt: report.generatedAt || null,
    completedAt: report.completedAt || null,
    caseTimeoutMs: report.caseTimeoutMs || null,
    retries: report.retries || null,
    shardTotal: report.shardTotal || 1,
  },
  metrics: {
    totalCases: metrics.totalCases,
    passCount: metrics.passCount,
    failCount: metrics.failCount,
    passRatePct: Number(metrics.passRatePct.toFixed(2)),
    p50DurationMs: Math.round(metrics.p50DurationMs),
    p90DurationMs: Math.round(metrics.p90DurationMs),
    avgDurationMs: Math.round(metrics.avgDurationMs),
    stageDropOffCounts: metrics.stageDropOffCounts,
    failureCategoryCounts: metrics.failureCategoryCounts,
  },
  gates: {
    minPassRatePct: Number(Math.max(0, metrics.passRatePct - args.passRateTolerancePct).toFixed(2)),
    maxFailCount: Math.max(0, metrics.failCount + Math.max(0, Math.floor(args.failCountDelta))),
    maxP90DurationMs,
    maxStageDropOffCounts: {
      probe: Math.max(0, (metrics.stageDropOffCounts.probe || 0) + Math.max(0, Math.floor(args.stageSlack))),
      runtime: Math.max(0, (metrics.stageDropOffCounts.runtime || 0) + Math.max(0, Math.floor(args.stageSlack))),
      unknown: Math.max(0, (metrics.stageDropOffCounts.unknown || 0) + Math.max(0, Math.floor(args.stageSlack))),
    },
  },
};

writeJson(args.output, baseline);
console.log(`Baseline written: ${path.resolve(process.cwd(), args.output)}`);
