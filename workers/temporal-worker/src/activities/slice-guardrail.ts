/**
 * The default per-slice diff cap ("amplify, don't automate"). When a slice's committed diff
 * exceeds either bound, the builder forces a human checkpoint instead of continuing — the antidote to
 * WSFF's 2000-line-dump anti-pattern. Named constants so the caps are tunable in one place; overridable
 * per run via env. OFF for the mock path (deterministic tests never trip it), ON for a real-agent path.
 */
export const DEFAULT_SLICE_DIFF_LINE_CAP = 400;
export const DEFAULT_SLICE_DIFF_FILE_CAP = 20;

export interface SliceDiffCap {
  enabled: boolean;
  lineCap: number;
  fileCap: number;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Resolves the slice-diff cap for a run. `realPath` comes from the RuntimeProfile
 * (`usesRealAgent`) — never a runtime string. On a real-agent path the guardrail is on by
 * default and the bounds are env-overridable (`AWB_SLICE_DIFF_LINE_CAP` / `AWB_SLICE_DIFF_FILE_CAP`);
 * set `AWB_SLICE_DIFF_CAP=0` to disable it. On the mock path it is always off.
 */
export function resolveSliceDiffCap(realPath: boolean): SliceDiffCap {
  if (!realPath || process.env.AWB_SLICE_DIFF_CAP === '0') {
    return { enabled: false, lineCap: DEFAULT_SLICE_DIFF_LINE_CAP, fileCap: DEFAULT_SLICE_DIFF_FILE_CAP };
  }
  return {
    enabled: true,
    lineCap: intFromEnv('AWB_SLICE_DIFF_LINE_CAP', DEFAULT_SLICE_DIFF_LINE_CAP),
    fileCap: intFromEnv('AWB_SLICE_DIFF_FILE_CAP', DEFAULT_SLICE_DIFF_FILE_CAP),
  };
}

export interface SliceDiffStat {
  changedLines: number;
  changedFiles: number;
}

/**
 * Whether a slice's diff exceeds the cap. Pure — takes the resolved cap + the measured diff
 * so it is trivially unit-testable. A disabled cap never trips.
 */
export function sliceDiffExceedsCap(cap: SliceDiffCap, stat: SliceDiffStat): boolean {
  if (!cap.enabled) return false;
  return stat.changedLines > cap.lineCap || stat.changedFiles > cap.fileCap;
}
