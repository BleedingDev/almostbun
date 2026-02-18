import { describe, expect, it } from 'vitest';
import {
  buildRepoFailureDiagnostic,
  RepoRunError,
  getRepoFailureDiagnostic,
} from '../src/repo/failure-diagnostics';

describe('repo failure diagnostics', () => {
  it('classifies strict preflight failures with high confidence', () => {
    const diagnostic = buildRepoFailureDiagnostic({
      error: new Error('Strict preflight failed:\npreflight.workspace.root-missing: missing root'),
      preflightIssues: [
        {
          code: 'preflight.workspace.root-missing',
          severity: 'error',
          message: 'missing root',
        },
      ],
    });

    expect(diagnostic.code).toBe('preflight.strict-failed');
    expect(diagnostic.phase).toBe('preflight');
    expect(diagnostic.confidence).toBeGreaterThan(0.9);
    expect(diagnostic.preflightIssueCodes).toContain('preflight.workspace.root-missing');
  });

  it('classifies module-resolution failures', () => {
    const diagnostic = buildRepoFailureDiagnostic({
      error: new Error("Cannot find module '@acme/missing'"),
    });

    expect(diagnostic.code).toBe('runtime.module-resolution-failed');
    expect(diagnostic.phase).toBe('runtime');
    expect(diagnostic.hints.length).toBeGreaterThan(0);
  });

  it('classifies network failures', () => {
    const diagnostic = buildRepoFailureDiagnostic({
      error: new Error('fetch failed while downloading GitHub archive'),
    });

    expect(diagnostic.code).toBe('bootstrap.network-failed');
    expect(diagnostic.phase).toBe('network');
  });

  it('falls back to unknown classification for unmatched errors', () => {
    const diagnostic = buildRepoFailureDiagnostic({
      error: new Error('weird condition: 0x11'),
    });

    expect(diagnostic.code).toBe('repo.unknown-failure');
    expect(diagnostic.phase).toBe('unknown');
    expect(diagnostic.confidence).toBeLessThan(0.5);
  });

  it('exposes diagnostic payload through RepoRunError', () => {
    const diagnostic = buildRepoFailureDiagnostic({
      error: new Error('server ready timeout after startup'),
    });
    const wrapped = new RepoRunError(diagnostic);

    expect(getRepoFailureDiagnostic(wrapped)?.code).toBe('start.server-startup-failed');
    expect(getRepoFailureDiagnostic(new Error('plain error'))).toBeUndefined();
  });
});
