import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

describe('public repo report summary script', () => {
  it('renders business impact and functional funnel sections', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'almostbun-report-'));
    const reportPath = path.join(tempDir, 'report.json');

    const report = {
      version: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:10:00.000Z',
      totalCases: 5,
      passCount: 2,
      failCount: 3,
      shardIndex: 0,
      shardTotal: 1,
      results: [
        { name: 'pass-1', status: 'pass', durationMs: 1200, detectedKind: 'vite' },
        { name: 'pass-2', status: 'pass', durationMs: 1800, detectedKind: 'next' },
        {
          name: 'probe-fail-1',
          status: 'fail',
          durationMs: 2200,
          detectedKind: 'vite',
          error: 'probe failed at / with status 500; body preview: crash',
        },
        {
          name: 'probe-fail-2',
          status: 'fail',
          durationMs: 2600,
          detectedKind: 'next',
          error: 'probe failed at /api with status 404; body error pattern: missing',
        },
        {
          name: 'runtime-fail',
          status: 'fail',
          durationMs: 3400,
          detectedKind: 'node-script',
          error: "Cannot find module '@acme/missing'",
        },
      ],
    };

    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    const scriptPath = path.resolve(process.cwd(), 'scripts/summarize-public-repo-report.mjs');

    const output = execFileSync(
      'node',
      [scriptPath, `--input=${reportPath}`, '--title=Matrix'],
      {
        encoding: 'utf8',
      }
    );

    expect(output).toContain('## Business Impact');
    expect(output).toContain('## Functional Funnel');
    expect(output).toContain('Compatibility conversion: **40.0%**');
    expect(output).toContain('| Probe | 2 | 3 |');
  });
});
