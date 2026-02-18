#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const parsed = {
    input: '',
    output: '',
    title: 'Public Repo Compatibility Report',
    maxFailures: 12,
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
    if (arg.startsWith('--title=')) {
      parsed.title = arg.slice('--title='.length).trim() || parsed.title;
      continue;
    }
    if (arg.startsWith('--max-failures=')) {
      parsed.maxFailures = Math.max(1, Number(arg.slice('--max-failures='.length).trim()) || parsed.maxFailures);
      continue;
    }
  }

  return parsed;
}

const CATEGORY_RULES = [
  {
    key: 'module-resolution',
    label: 'Module Resolution',
    patterns: [
      /cannot find module/i,
      /module not found/i,
      /err_module_not_found/i,
      /exports(?:\s+map)?/i,
      /subpath/i,
      /package imports?/i,
    ],
  },
  {
    key: 'runtime-exception',
    label: 'Runtime Exception',
    patterns: [
      /typeerror/i,
      /referenceerror/i,
      /syntaxerror/i,
      /rangeerror/i,
      /unhandled(?:promise)?rejection/i,
    ],
  },
  {
    key: 'network-cors',
    label: 'Network/CORS',
    patterns: [
      /cors/i,
      /failed to fetch/i,
      /network operation failed/i,
      /fetch failed/i,
      /networkerror/i,
      /econn/i,
      /timeout/i,
      /timed out/i,
      /proxy/i,
    ],
  },
  {
    key: 'server-startup',
    label: 'Server Startup',
    patterns: [
      /server ready timeout/i,
      /not ready/i,
      /eaddrinuse/i,
      /probe/i,
      /listen/i,
    ],
  },
];

const STAGE_RULES = [
  {
    key: 'bootstrap',
    label: 'Bootstrap',
    patterns: [
      /strict preflight failed/i,
      /bootstrap\./i,
      /failed to download/i,
      /retrying github archive download/i,
      /timed out after \d+ms[\s\S]*downloading/i,
      /archive/i,
      /npm/i,
      /install/i,
      /network/i,
    ],
  },
  {
    key: 'detect',
    label: 'Detection',
    patterns: [
      /expected .* to be/i,
      /detected kind/i,
      /could not detect a runnable app/i,
    ],
  },
  {
    key: 'start',
    label: 'Server Start',
    patterns: [
      /server ready timeout/i,
      /did not register/i,
      /eaddrinuse/i,
      /listen eacces/i,
    ],
  },
  {
    key: 'probe',
    label: 'Probe',
    patterns: [
      /probe failed/i,
      /status \d{3}/i,
      /body error pattern/i,
      /crawled:/i,
    ],
  },
  {
    key: 'runtime',
    label: 'Runtime',
    patterns: [
      /fatal runtime logs/i,
      /typeerror/i,
      /referenceerror/i,
      /syntaxerror/i,
      /cannot find module/i,
      /module not found/i,
    ],
  },
];

function categorizeFailure(result) {
  const text = `${result.error || ''}\n${(result.logsTail || []).join('\n')}`;
  for (const rule of CATEGORY_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      return rule.key;
    }
  }
  return 'unknown';
}

function classifyFailureStage(result) {
  const text = `${result.error || ''}\n${(result.logsTail || []).join('\n')}`;
  for (const rule of STAGE_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      return rule.key;
    }
  }
  return 'unknown';
}

function normalizeReport(raw) {
  const results = Array.isArray(raw.results) ? raw.results : [];
  const totalCases = Number(raw.totalCases) || results.length;
  const passCount = Number(raw.passCount) || results.filter((result) => result.status === 'pass').length;
  const failCount = Number(raw.failCount) || Math.max(0, totalCases - passCount);
  return {
    ...raw,
    totalCases,
    passCount,
    failCount,
    results,
  };
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function buildFunnel(report) {
  const stages = ['bootstrap', 'detect', 'start', 'probe', 'runtime', 'unknown'];
  const dropCounts = new Map(stages.map((stage) => [stage, 0]));
  const failures = report.results.filter((result) => result.status !== 'pass');

  for (const result of failures) {
    const stage = classifyFailureStage(result);
    dropCounts.set(stage, (dropCounts.get(stage) || 0) + 1);
  }

  let survivors = report.totalCases;
  const rows = stages.map((stage) => {
    const dropped = dropCounts.get(stage) || 0;
    survivors = Math.max(0, survivors - dropped);
    const label = STAGE_RULES.find((rule) => rule.key === stage)?.label || 'Unknown';
    return {
      stage,
      label,
      dropped,
      surviving: survivors,
    };
  });

  return rows;
}

function renderSummary(report, title, maxFailures) {
  const safeTotal = Math.max(1, report.totalCases);
  const passRate = ((report.passCount / safeTotal) * 100).toFixed(1);
  const failed = report.results.filter((result) => result.status !== 'pass');
  const durations = report.results
    .map((result) => Number(result.durationMs) || 0)
    .filter((duration) => duration > 0);
  const p50DurationMs = percentile(durations, 50);
  const p90DurationMs = percentile(durations, 90);
  const avgDurationMs = durations.length > 0
    ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
    : 0;
  const funnel = buildFunnel(report);

  const categoryCounts = new Map();
  for (const result of failed) {
    const key = categorizeFailure(result);
    categoryCounts.set(key, (categoryCounts.get(key) || 0) + 1);
  }
  const topCategory = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  const topCategoryLabel = topCategory
    ? (CATEGORY_RULES.find((rule) => rule.key === topCategory[0])?.label || 'Unknown')
    : 'None';

  const stageDropCounts = new Map();
  for (const result of failed) {
    const key = classifyFailureStage(result);
    stageDropCounts.set(key, (stageDropCounts.get(key) || 0) + 1);
  }
  const topDropStageEntry = [...stageDropCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  const topDropStageLabel = topDropStageEntry
    ? (STAGE_RULES.find((rule) => rule.key === topDropStageEntry[0])?.label || 'Unknown')
    : 'None';

  const categoryRows = [...categoryCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => {
      const label = CATEGORY_RULES.find((rule) => rule.key === key)?.label || 'Unknown';
      return `| ${label} | ${count} |`;
    });

  const funnelRows = funnel.map(
    (row) => `| ${row.label} | ${row.dropped} | ${row.surviving} |`
  );

  const failedRows = failed
    .slice(0, maxFailures)
    .map((result) => {
      const errorSummary = (result.error || '')
        .replace(/\s+/g, ' ')
        .slice(0, 140);
      return `| ${result.name} | ${result.detectedKind || 'n/a'} | ${errorSummary || 'No error captured'} |`;
    });

  const lines = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Overview');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | ---: |');
  lines.push(`| Total cases | ${report.totalCases} |`);
  lines.push(`| Passed | ${report.passCount} |`);
  lines.push(`| Failed | ${report.failCount} |`);
  lines.push(`| Pass rate | ${passRate}% |`);
  lines.push(`| Shard | ${Number(report.shardIndex) + 1}/${report.shardTotal || 1} |`);
  lines.push(`| Median duration (p50) | ${p50DurationMs} ms |`);
  lines.push(`| Tail duration (p90) | ${p90DurationMs} ms |`);
  lines.push(`| Average duration | ${avgDurationMs} ms |`);
  lines.push('');

  lines.push('## Business Impact');
  lines.push('');
  lines.push(`- Compatibility conversion: **${passRate}%** of repos reached a runnable and probe-verified state.`);
  lines.push(`- Time-to-value: median case completion is **${p50DurationMs} ms** (p90: **${p90DurationMs} ms**).`);
  lines.push(`- Primary loss driver: **${topDropStageLabel}** stage drop-offs.`);
  lines.push(`- Top technical blocker cluster: **${topCategoryLabel}**.`);
  lines.push('');

  lines.push('## Functional Funnel');
  lines.push('');
  lines.push('| Stage | Drop-offs | Remaining Cases |');
  lines.push('| --- | ---: | ---: |');
  lines.push(...funnelRows);
  lines.push('');

  lines.push('## Failure Categories');
  lines.push('');
  if (categoryRows.length === 0) {
    lines.push('No failing cases.');
  } else {
    lines.push('| Category | Count |');
    lines.push('| --- | ---: |');
    lines.push(...categoryRows);
  }
  lines.push('');

  lines.push(`## Failing Cases (Top ${maxFailures})`);
  lines.push('');
  if (failedRows.length === 0) {
    lines.push('No failing cases.');
  } else {
    lines.push('| Case | Detected Kind | Error |');
    lines.push('| --- | --- | --- |');
    lines.push(...failedRows);
  }
  lines.push('');

  return lines.join('\n');
}

const args = parseArgs(process.argv.slice(2));
if (!args.input) {
  throw new Error('Missing required argument --input=<report.json>');
}

const inputPath = path.resolve(process.cwd(), args.input);
const report = normalizeReport(JSON.parse(fs.readFileSync(inputPath, 'utf8')));
const markdown = renderSummary(report, args.title, args.maxFailures);

if (args.output) {
  const outputPath = path.resolve(process.cwd(), args.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, markdown, 'utf8');
}

process.stdout.write(markdown + '\n');
