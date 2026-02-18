import type { PreflightIssue } from './preflight';

export type RepoFailurePhase =
  | 'bootstrap'
  | 'preflight'
  | 'detect'
  | 'start'
  | 'runtime'
  | 'network'
  | 'unknown';

export interface RepoFailureHint {
  id: string;
  title: string;
  detail: string;
  action: string;
  confidence: number;
}

export interface RepoFailureDiagnostic {
  code: string;
  phase: RepoFailurePhase;
  message: string;
  likelyCause: string;
  confidence: number;
  hints: RepoFailureHint[];
  rawMessage: string;
  preflightIssueCodes: string[];
}

export interface BuildRepoFailureDiagnosticOptions {
  error: unknown;
  preflightIssues?: PreflightIssue[];
}

const MODULE_RESOLUTION_REGEX = /Cannot find module|Module not found|ERR_MODULE_NOT_FOUND/i;
const NETWORK_REGEX = /fetch failed|Failed to fetch|NetworkError|ECONN|timeout|ETIMEDOUT|ENOTFOUND/i;
const STARTUP_REGEX = /server ready timeout|not ready|EADDRINUSE|listen EACCES/i;

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.message}${error.stack ? `\n${error.stack}` : ''}`;
  }
  return String(error);
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function makeHint(
  id: string,
  title: string,
  detail: string,
  action: string,
  confidence: number
): RepoFailureHint {
  return {
    id,
    title,
    detail,
    action,
    confidence: clampConfidence(confidence),
  };
}

export function buildRepoFailureDiagnostic(
  options: BuildRepoFailureDiagnosticOptions
): RepoFailureDiagnostic {
  const { error, preflightIssues = [] } = options;
  const rawMessage = stringifyError(error);
  const errorMessage = error instanceof Error ? error.message : String(error);
  const preflightIssueCodes = preflightIssues.map((issue) => issue.code);

  if (/Strict preflight failed/i.test(errorMessage)) {
    return {
      code: 'preflight.strict-failed',
      phase: 'preflight',
      message: 'Strict preflight checks failed before runtime startup.',
      likelyCause: 'Blocking preflight errors were found in project metadata or dependency setup.',
      confidence: 0.95,
      hints: [
        makeHint(
          'inspect-preflight-errors',
          'Inspect Preflight Errors',
          'Preflight raised one or more blocking issues that were intentionally treated as fatal.',
          'Review the preflight error list and fix each item before retrying bootstrap.',
          0.98
        ),
        makeHint(
          'retry-warn-mode',
          'Retry With warn Mode',
          'Warn mode can confirm whether runtime startup proceeds after non-fatal issues are surfaced.',
          'Retry with preflightMode="warn" to validate if issues are hard blockers or only advisory.',
          0.78
        ),
      ],
      rawMessage,
      preflightIssueCodes,
    };
  }

  if (MODULE_RESOLUTION_REGEX.test(errorMessage)) {
    return {
      code: 'runtime.module-resolution-failed',
      phase: 'runtime',
      message: 'Module resolution failed while bootstrapping or executing project code.',
      likelyCause: 'A dependency, subpath export, or workspace package could not be resolved in the VFS runtime.',
      confidence: 0.9,
      hints: [
        makeHint(
          'reinstall-dependencies',
          'Reinstall Dependencies',
          'Missing modules are commonly caused by partial installs or lockfile mismatches.',
          'Re-run install from project root and ensure lockfile + package.json are in sync.',
          0.86
        ),
        makeHint(
          'check-subpath-exports',
          'Check Subpath Exports',
          'Subpath imports can fail when package exports do not expose the referenced entry.',
          'Verify the package exports map for the failing import and switch to a supported subpath.',
          0.84
        ),
      ],
      rawMessage,
      preflightIssueCodes,
    };
  }

  if (STARTUP_REGEX.test(errorMessage)) {
    return {
      code: 'start.server-startup-failed',
      phase: 'start',
      message: 'Project server failed to reach ready state.',
      likelyCause: 'Port conflicts, startup crashes, or readiness probe mismatch.',
      confidence: 0.79,
      hints: [
        makeHint(
          'increase-ready-timeout',
          'Increase Ready Timeout',
          'Some projects need more time to build before the readiness probe succeeds.',
          'Raise serverReadyTimeoutMs and retry to distinguish slow startup from hard failures.',
          0.74
        ),
        makeHint(
          'inspect-startup-logs',
          'Inspect Startup Logs',
          'The crash usually appears before readiness timeout triggers.',
          'Inspect bootstrap/start logs for the first uncaught error near server start.',
          0.83
        ),
      ],
      rawMessage,
      preflightIssueCodes,
    };
  }

  if (NETWORK_REGEX.test(errorMessage)) {
    return {
      code: 'bootstrap.network-failed',
      phase: 'network',
      message: 'Network operation failed while fetching project data or dependencies.',
      likelyCause: 'Transient network outage, host restrictions, or upstream service throttling.',
      confidence: 0.82,
      hints: [
        makeHint(
          'retry-bootstrap',
          'Retry Bootstrap',
          'Transient network errors are common during archive and package fetches.',
          'Retry the operation and confirm outbound access to GitHub and npm hosts.',
          0.8
        ),
        makeHint(
          'verify-proxy-policy',
          'Verify Proxy/Host Policy',
          'Restricted host allowlists can block required artifact endpoints.',
          'Confirm your network/proxy policy permits required hosts for repo and package downloads.',
          0.73
        ),
      ],
      rawMessage,
      preflightIssueCodes,
    };
  }

  const nativeUnsupportedIssues = preflightIssues.filter(
    (issue) => issue.code === 'preflight.native.unsupported'
  );
  if (nativeUnsupportedIssues.length > 0) {
    return {
      code: 'preflight.native-unsupported',
      phase: 'preflight',
      message: 'Project depends on native modules with limited browser-runtime support.',
      likelyCause: 'One or more dependencies require native bindings without compatible fallback shims.',
      confidence: 0.77,
      hints: [
        makeHint(
          'swap-native-dependency',
          'Swap Native Dependency',
          'Native packages are often incompatible with browser-based runtimes unless a shim exists.',
          'Replace native packages with browser-compatible alternatives or add explicit fallback modules.',
          0.8
        ),
      ],
      rawMessage,
      preflightIssueCodes,
    };
  }

  return {
    code: 'repo.unknown-failure',
    phase: 'unknown',
    message: 'Bootstrap/run failed with an uncategorized error.',
    likelyCause: 'The failure pattern does not match current diagnostics rules.',
    confidence: 0.35,
    hints: [
      makeHint(
        'collect-trace',
        'Collect Trace Data',
        'Unknown failures need trace + log context to classify accurately.',
        'Capture trace events and logs, then add a targeted diagnostic rule for this signature.',
        0.62
      ),
    ],
    rawMessage,
    preflightIssueCodes,
  };
}

export class RepoRunError extends Error {
  code: string;
  diagnostic: RepoFailureDiagnostic;

  constructor(diagnostic: RepoFailureDiagnostic, cause?: unknown) {
    super(`${diagnostic.message} (${diagnostic.code})`);
    this.name = 'RepoRunError';
    this.code = diagnostic.code;
    this.diagnostic = diagnostic;
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export function getRepoFailureDiagnostic(error: unknown): RepoFailureDiagnostic | undefined {
  if (error instanceof RepoRunError) {
    return error.diagnostic;
  }
  if (error && typeof error === 'object' && 'diagnostic' in error) {
    const maybe = (error as { diagnostic?: unknown }).diagnostic;
    if (maybe && typeof maybe === 'object' && 'code' in (maybe as object)) {
      return maybe as RepoFailureDiagnostic;
    }
  }
  return undefined;
}
