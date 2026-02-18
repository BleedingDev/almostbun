export type RepoSecurityPolicyPreset = 'compat' | 'balanced' | 'strict';
export type RepoSecurityPolicyMode = 'enforce' | 'report-only';
export type RepoSecurityPolicySeverity = 'info' | 'warning' | 'error';

export interface RepoSecurityPolicyOptions {
  preset?: RepoSecurityPolicyPreset;
  mode?: RepoSecurityPolicyMode;
  overrides?: Record<string, RepoSecurityPolicySeverity>;
}

export interface RepoSecurityPolicyEscalation {
  code: string;
  from: RepoSecurityPolicySeverity;
  to: RepoSecurityPolicySeverity;
  path?: string;
}

export interface RepoSecurityPolicyEvaluation {
  preset: RepoSecurityPolicyPreset;
  mode: RepoSecurityPolicyMode;
  baselineErrorCount: number;
  effectiveErrorCount: number;
  suppressedErrorCount: number;
  escalationCount: number;
  escalations: RepoSecurityPolicyEscalation[];
}

type PolicyIssue = {
  code: string;
  severity: RepoSecurityPolicySeverity;
  path?: string;
};

const SEVERITY_RANK: Record<RepoSecurityPolicySeverity, number> = {
  info: 0,
  warning: 1,
  error: 2,
};

const PRESET_ESCALATIONS: Record<RepoSecurityPolicyPreset, Record<string, RepoSecurityPolicySeverity>> = {
  compat: {},
  balanced: {
    'preflight.exports.subpath-missing': 'error',
    'preflight.native.unsupported': 'error',
  },
  strict: {
    'preflight.exports.subpath-missing': 'error',
    'preflight.native.unsupported': 'error',
    'preflight.native.fallback-available': 'warning',
  },
};

export function resolveRepoSecurityPolicyPreset(value: string | undefined): RepoSecurityPolicyPreset {
  const normalized = (value || 'compat').trim().toLowerCase();
  if (normalized === 'balanced') {
    return 'balanced';
  }
  if (normalized === 'strict') {
    return 'strict';
  }
  return 'compat';
}

export function resolveRepoSecurityPolicyMode(value: string | undefined): RepoSecurityPolicyMode {
  const normalized = (value || 'enforce').trim().toLowerCase();
  if (normalized === 'report-only' || normalized === 'report') {
    return 'report-only';
  }
  return 'enforce';
}

function pickHigherSeverity(
  left: RepoSecurityPolicySeverity,
  right: RepoSecurityPolicySeverity | undefined
): RepoSecurityPolicySeverity {
  if (!right) {
    return left;
  }
  return SEVERITY_RANK[right] > SEVERITY_RANK[left] ? right : left;
}

export function applyRepoSecurityPolicy<TIssue extends PolicyIssue>(
  issues: TIssue[],
  options: RepoSecurityPolicyOptions = {}
): {
  issues: TIssue[];
  hasErrors: boolean;
  policy: RepoSecurityPolicyEvaluation;
} {
  const preset = options.preset || 'compat';
  const mode = options.mode || 'enforce';
  const presetEscalations = PRESET_ESCALATIONS[preset];
  const overrideEscalations = options.overrides || {};
  const escalations: RepoSecurityPolicyEscalation[] = [];

  const baselineErrorCount = issues.filter((issue) => issue.severity === 'error').length;
  const adjustedIssues = issues.map((issue) => {
    const targetSeverity = pickHigherSeverity(
      pickHigherSeverity(issue.severity, presetEscalations[issue.code]),
      overrideEscalations[issue.code]
    );
    if (targetSeverity !== issue.severity) {
      escalations.push({
        code: issue.code,
        from: issue.severity,
        to: targetSeverity,
        path: issue.path,
      });
      return {
        ...issue,
        severity: targetSeverity,
      };
    }
    return issue;
  });

  const effectiveErrorCount = adjustedIssues.filter((issue) => issue.severity === 'error').length;
  const suppressedErrorCount =
    mode === 'report-only'
      ? Math.max(0, effectiveErrorCount - baselineErrorCount)
      : 0;

  return {
    issues: adjustedIssues,
    hasErrors: mode === 'report-only' ? baselineErrorCount > 0 : effectiveErrorCount > 0,
    policy: {
      preset,
      mode,
      baselineErrorCount,
      effectiveErrorCount,
      suppressedErrorCount,
      escalationCount: escalations.length,
      escalations,
    },
  };
}
