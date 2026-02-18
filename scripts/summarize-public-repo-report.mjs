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
      /networkerror/i,
      /econn/i,
      /timeout/i,
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

function categorizeFailure(result) {
  const text = `${result.error || ''}\n${(result.logsTail || []).join('\n')}`;
  for (const rule of CATEGORY_RULES) {
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

function renderSummary(report, title, maxFailures) {
  const safeTotal = Math.max(1, report.totalCases);
  const passRate = ((report.passCount / safeTotal) * 100).toFixed(1);
  const failed = report.results.filter((result) => result.status !== 'pass');

  const categoryCounts = new Map();
  for (const result of failed) {
    const key = categorizeFailure(result);
    categoryCounts.set(key, (categoryCounts.get(key) || 0) + 1);
  }

  const categoryRows = [...categoryCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => {
      const label = CATEGORY_RULES.find((rule) => rule.key === key)?.label || 'Unknown';
      return `| ${label} | ${count} |`;
    });

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
