import fs from 'node:fs';
import path from 'node:path';

export const CATEGORY_RULES = [
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

export const STAGE_RULES = [
  {
    key: 'bootstrap',
    label: 'Bootstrap',
    patterns: [
      /strict preflight failed/i,
      /failed to download/i,
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

const STAGE_KEYS = [...STAGE_RULES.map((rule) => rule.key), 'unknown'];

export function readJson(inputPath) {
  const absolutePath = path.resolve(process.cwd(), inputPath);
  return JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
}

export function writeJson(outputPath, payload) {
  const absolutePath = path.resolve(process.cwd(), outputPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

export function normalizeReport(raw) {
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

function classifyWithRules(result, rules, defaultKey) {
  const text = `${result.error || ''}\n${(result.logsTail || []).join('\n')}`;
  for (const rule of rules) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      return rule.key;
    }
  }
  return defaultKey;
}

export function categorizeFailure(result) {
  return classifyWithRules(result, CATEGORY_RULES, 'unknown');
}

export function classifyFailureStage(result) {
  return classifyWithRules(result, STAGE_RULES, 'unknown');
}

export function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function computeReportMetrics(reportLike) {
  const report = normalizeReport(reportLike);
  const failures = report.results.filter((result) => result.status !== 'pass');
  const durations = report.results
    .map((result) => Number(result.durationMs) || 0)
    .filter((duration) => duration > 0);
  const passRatePct = report.totalCases > 0
    ? (report.passCount / report.totalCases) * 100
    : 0;

  const failureCategoryCounts = {};
  for (const result of failures) {
    const key = categorizeFailure(result);
    failureCategoryCounts[key] = (failureCategoryCounts[key] || 0) + 1;
  }

  const stageDropOffCounts = {};
  for (const stageKey of STAGE_KEYS) {
    stageDropOffCounts[stageKey] = 0;
  }
  for (const result of failures) {
    const stageKey = classifyFailureStage(result);
    stageDropOffCounts[stageKey] = (stageDropOffCounts[stageKey] || 0) + 1;
  }

  let remaining = report.totalCases;
  const funnel = STAGE_KEYS.map((stageKey) => {
    const dropped = stageDropOffCounts[stageKey] || 0;
    remaining = Math.max(0, remaining - dropped);
    return {
      stage: stageKey,
      dropped,
      remaining,
    };
  });

  return {
    totalCases: report.totalCases,
    passCount: report.passCount,
    failCount: report.failCount,
    passRatePct,
    avgDurationMs: durations.length > 0
      ? durations.reduce((sum, value) => sum + value, 0) / durations.length
      : 0,
    p50DurationMs: percentile(durations, 50),
    p90DurationMs: percentile(durations, 90),
    failureCategoryCounts,
    stageDropOffCounts,
    funnel,
  };
}
