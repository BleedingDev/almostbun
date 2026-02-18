import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function writeReport(filePath: string, passCount: number, failCount: number, durations: number[], failureStage = 'probe') {
  const totalCases = passCount + failCount;
  const results = [];
  for (let i = 0; i < passCount; i += 1) {
    results.push({
      name: `pass-${i}`,
      status: 'pass',
      durationMs: durations[i % durations.length] || 1000,
    });
  }
  for (let i = 0; i < failCount; i += 1) {
    const duration = durations[(passCount + i) % durations.length] || 2000;
    const error = failureStage === 'probe'
      ? 'probe failed at / with status 500'
      : "Cannot find module '@acme/missing'";
    results.push({
      name: `fail-${i}`,
      status: 'fail',
      durationMs: duration,
      error,
    });
  }

  fs.writeFileSync(
    filePath,
    JSON.stringify({
      version: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:10:00.000Z',
      totalCases,
      passCount,
      failCount,
      shardIndex: 0,
      shardTotal: 1,
      results,
    }, null, 2),
    'utf8'
  );
}

describe('public repo quality gates scripts', () => {
  it('extracts baseline and passes gates for similar report', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'almostbun-quality-'));
    const baselineSourceReport = path.join(tempDir, 'baseline-report.json');
    const currentReport = path.join(tempDir, 'current-report.json');
    const baselinePath = path.join(tempDir, 'baseline.json');
    const summaryPath = path.join(tempDir, 'gate-summary.md');

    writeReport(baselineSourceReport, 8, 2, [900, 1100, 1300, 2000, 2200], 'probe');
    writeReport(currentReport, 8, 2, [1000, 1200, 1400, 2100, 2300], 'probe');

    const extractScript = path.resolve(process.cwd(), 'scripts/extract-public-repo-baseline.mjs');
    const checkScript = path.resolve(process.cwd(), 'scripts/check-public-repo-quality-gates.mjs');

    execFileSync(
      'node',
      [
        extractScript,
        `--input=${baselineSourceReport}`,
        `--output=${baselinePath}`,
        '--profile=full',
      ],
      { encoding: 'utf8' }
    );

    const output = execFileSync(
      'node',
      [
        checkScript,
        `--input=${currentReport}`,
        `--baseline=${baselinePath}`,
        `--output=${summaryPath}`,
      ],
      { encoding: 'utf8' }
    );

    expect(output).toContain('## Result: PASS');
    expect(fs.existsSync(summaryPath)).toBe(true);
  });

  it('fails gates when metrics regress beyond baseline tolerance', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'almostbun-quality-'));
    const baselineSourceReport = path.join(tempDir, 'baseline-report.json');
    const currentReport = path.join(tempDir, 'current-report.json');
    const baselinePath = path.join(tempDir, 'baseline.json');

    writeReport(baselineSourceReport, 9, 1, [800, 900, 1000, 1500, 1700], 'probe');
    writeReport(currentReport, 3, 7, [3000, 3500, 4000, 4500, 5000], 'runtime');

    const extractScript = path.resolve(process.cwd(), 'scripts/extract-public-repo-baseline.mjs');
    const checkScript = path.resolve(process.cwd(), 'scripts/check-public-repo-quality-gates.mjs');

    execFileSync(
      'node',
      [
        extractScript,
        `--input=${baselineSourceReport}`,
        `--output=${baselinePath}`,
        '--profile=full',
      ],
      { encoding: 'utf8' }
    );

    expect(() =>
      execFileSync(
        'node',
        [
          checkScript,
          `--input=${currentReport}`,
          `--baseline=${baselinePath}`,
        ],
        { encoding: 'utf8' }
      )
    ).toThrow();
  });
});
