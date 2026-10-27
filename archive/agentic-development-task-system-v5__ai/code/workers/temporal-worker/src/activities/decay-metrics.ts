import type { Finding } from '@awb/domain';
import type { DiffLineStats } from '@awb/repository';

/**
 * WSFF "decay" signals for one run. These are the buildable subset — diff size, the
 * reviewed-diff ratio, and review-finding density — sourced from what the challenge phase already has
 * in hand (the reviewed diff + the adversarial findings). Duplication-delta is deliberately omitted:
 * it needs a prior-run baseline / a duplication probe that does not exist yet.
 *
 * This module is pure so it can be unit-tested without git, telemetry, or a running phase.
 */
export interface DecaySignals {
  /** Total added+removed lines in the candidate diff (from `git diff --numstat`). */
  diffLines: number;
  /** Files touched by the candidate diff. */
  filesChanged: number;
  /** Lines of the diff text actually handed to the reviewer. */
  reviewedDiffLines: number;
  /** reviewedDiffLines / diffLines, clamped to [0,1]. 1 when nothing changed (nothing unreviewed). */
  reviewedRatio: number;
  /** Total findings the adversarial reviewer raised. */
  findingCount: number;
  /** Open blocker+high findings — the ones that would block. */
  blockerHighCount: number;
  /** Findings the reviewer tagged `maintainability` (the WSFF axis), regardless of status. */
  maintainabilityFindingCount: number;
  /** Findings per 1000 changed lines — density, comparable across differently-sized runs. */
  findingDensityPerKloc: number;
}

export interface DecayInputs {
  diffLineStats: DiffLineStats;
  /** The exact diff text handed to the reviewer (its line count is the reviewed size). */
  reviewedDiffText: string;
  findings: readonly Finding[];
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  // A trailing newline should not count as an extra empty line.
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
  return normalized.split('\n').length;
}

export function computeDecaySignals(inputs: DecayInputs): DecaySignals {
  const diffLines = inputs.diffLineStats.added + inputs.diffLineStats.removed;
  const reviewedDiffLines = countLines(inputs.reviewedDiffText);
  const reviewedRatio = diffLines === 0 ? 1 : Math.min(1, reviewedDiffLines / diffLines);

  const findingCount = inputs.findings.length;
  const blockerHighCount = inputs.findings.filter(
    (f) => (f.severity === 'blocker' || f.severity === 'high') && f.status === 'open',
  ).length;
  const maintainabilityFindingCount = inputs.findings.filter((f) => f.category === 'maintainability').length;
  const findingDensityPerKloc = diffLines === 0 ? 0 : (findingCount / diffLines) * 1000;

  return {
    diffLines,
    filesChanged: inputs.diffLineStats.filesChanged,
    reviewedDiffLines,
    reviewedRatio,
    findingCount,
    blockerHighCount,
    maintainabilityFindingCount,
    findingDensityPerKloc,
  };
}

/** Flattens the signals into `awb.decay.*` span attributes for the run trace. */
export function decaySpanAttributes(signals: DecaySignals): Record<string, number> {
  return {
    'awb.decay.diff_lines': signals.diffLines,
    'awb.decay.files_changed': signals.filesChanged,
    'awb.decay.reviewed_diff_lines': signals.reviewedDiffLines,
    'awb.decay.reviewed_ratio': signals.reviewedRatio,
    'awb.decay.finding_count': signals.findingCount,
    'awb.decay.blocker_high_count': signals.blockerHighCount,
    'awb.decay.maintainability_finding_count': signals.maintainabilityFindingCount,
    'awb.decay.finding_density_per_kloc': signals.findingDensityPerKloc,
  };
}
