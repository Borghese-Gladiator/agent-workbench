/**
 * Over-reach guard (TASK-113). A run can commit a catastrophic over-reach — one dogfood task whose
 * contract implied a single 182-line file produced a 726-file, +27k/−10k commit that swept the
 * retired `archive/` tree and half of `packages/`, with the whole prompt pasted as the commit
 * message. Nothing flagged it. On the autonomy path (draft-PR-terminal, no human gate) that would
 * open a PR proposing to rewrite the repo.
 *
 * This module is a pure predicate over an already-computed diff (changed paths + file count) plus
 * the change's declared scope (the plan's expected paths + contract size). It is intentionally free
 * of git/fs/IO so it is trivially testable; the caller (the implement phase) supplies the diff.
 */

export type TaskSize = 'S' | 'M' | 'L';

/**
 * Path prefixes a task must never write to: the retired v4 system, build output, and dependency
 * trees. Matched case-sensitively against forward-slash repo-relative paths (git's own path format).
 *
 * Deliberately does NOT include lockfiles. Writing `pnpm-lock.yaml` is the normal, correct
 * consequence of a task that adds a dependency, and this predicate cannot tell that apart from a
 * gratuitous regeneration — with no contract field to grant an exception, protecting lockfiles would
 * hard-block every dependency-adding task. The file-count ceiling below still catches the runaway
 * case where a lockfile churn comes bundled with a repo-wide sweep.
 */
export const DEFAULT_PROTECTED_PREFIXES: readonly string[] = ['archive/', 'dist/', 'node_modules/'];

/**
 * The most files a change of a given size is expected to touch before the diff is "surprisingly
 * large" relative to its contract. A ceiling, not a target — it only trips on gross over-reach
 * (the 726-file case), so legitimately broad refactors within a size are unaffected. Also used as
 * the floor when the plan declares few/no expected paths (a plan may under-specify `likelyPaths`).
 */
export const SIZE_FILE_CEILING: Record<TaskSize, number> = {
  S: 25,
  M: 80,
  L: 200,
};

/**
 * How many times the plan's own expected-path count a diff may exceed before it is over-reach.
 * Compared against the larger of (expected-path count, size ceiling) so a thin plan can't force a
 * false positive.
 */
export const EXPECTED_PATHS_MULTIPLIER = 4;

export interface OverReachInput {
  /** Repo-relative, forward-slash changed paths (e.g. from `git diff --name-only base..candidate`). */
  changedPaths: readonly string[];
  /** The plan's aggregated expected paths (`PlanSlice.likelyPaths`), if any. */
  expectedPaths?: readonly string[];
  /** Contract size, drives the absolute file ceiling. Defaults to 'M' when unknown. */
  size?: TaskSize;
  /** Override the protected prefixes (defaults to {@link DEFAULT_PROTECTED_PREFIXES}). */
  protectedPrefixes?: readonly string[];
  /**
   * Paths allowed despite matching a protected prefix. Caller-supplied only — no contract field
   * feeds this yet, so the production caller (the implement phase) leaves it empty; it exists as the
   * seam for threading an explicit contract allowance through later.
   */
  allowedProtectedPaths?: readonly string[];
}

export interface OverReachResult {
  /** True when the diff is within scope (maps directly onto `diffWithinApprovedScope`). */
  withinScope: boolean;
  /** Human-readable reasons the diff was judged over-reach (empty when `withinScope`). */
  reasons: string[];
  /** Changed paths that hit a protected prefix (subset of `changedPaths`). */
  protectedHits: string[];
  /** The file-count ceiling applied. */
  ceiling: number;
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * Judges whether an implement diff has over-reached its contract's scope. Two independent triggers:
 *  1. it writes to a protected tree (`archive/`, `dist/`, lockfiles, …) the contract didn't allow, or
 *  2. its file count grossly exceeds what the size + plan imply (> ceiling AND > multiplier × expected).
 * Either trigger flips `withinScope` to false with a specific reason; the caller blocks on it.
 */
export function evaluateOverReach(input: OverReachInput): OverReachResult {
  const protectedPrefixes = input.protectedPrefixes ?? DEFAULT_PROTECTED_PREFIXES;
  const allowed = new Set((input.allowedProtectedPaths ?? []).map(normalize));
  const changed = input.changedPaths.map(normalize);
  const size = input.size ?? 'M';

  const protectedHits = changed.filter((p) => {
    if (allowed.has(p)) return false;
    return protectedPrefixes.some((prefix) => p === normalize(prefix) || p.startsWith(normalize(prefix)));
  });

  const expectedCount = input.expectedPaths?.length ?? 0;
  const ceiling = Math.max(SIZE_FILE_CEILING[size], expectedCount * EXPECTED_PATHS_MULTIPLIER);

  const reasons: string[] = [];
  if (protectedHits.length > 0) {
    const sample = protectedHits.slice(0, 5).join(', ');
    reasons.push(
      `diff writes to ${protectedHits.length} protected path(s) not named by the contract (e.g. ${sample})`,
    );
  }
  if (changed.length > ceiling) {
    reasons.push(
      `diff touches ${changed.length} files, far beyond the ~${ceiling} expected for a ${size} task` +
        (expectedCount > 0 ? ` with ${expectedCount} planned path(s)` : ''),
    );
  }

  return {
    withinScope: reasons.length === 0,
    reasons,
    protectedHits,
    ceiling,
  };
}
