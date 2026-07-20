# Fix generated_lines for base_ref="HEAD" runs

`lib/metrics/lines.py:count_generated()` runs `git log --numstat <base_ref>..HEAD` to sum `+` lines across the worktree's commit history. The workbench config defaults `base_ref: HEAD` (`agent-workbench.yaml:14`), and `metadata.target.repo.base_ref` is stored as that literal string. The dotted range `HEAD..HEAD` resolves to "no commits" — so `generated_lines` reports 0 for every run that uses the default, regardless of how many commits the builder landed.

Observed on the token-efficiency pass-1 dogfood run: 3 commits with ~2.4k inserted lines across them; `generated_lines: 0`. Same gap will hit every future run that doesn't override `base_ref`.

## Tasks

- Capture a resolved SHA at `/start`. `lib/cli/cmd_start.py` already calls `git worktree add` — extend the call site to `git rev-parse <base_ref>` first and persist the result. Two options:
  - (a) Add a new field `metadata.target.repo.base_ref_sha` (schema change in `schemas/run-metadata.yaml`).
  - (b) Rewrite `metadata.target.repo.base_ref` in place at `/start` from the literal `"HEAD"` to the resolved SHA. No schema change but loses the "what was the symbolic ref originally" information.

  Prefer (a) — schema is additive, the symbolic ref stays readable.
- Prefer the resolved SHA in `lines.py`. `count_generated()` and `count_accepted()` both take `base_ref`. Update callers to pass `base_ref_sha if present else base_ref`. Add a one-line fallback comment.
- Regression test. `tests/test_metrics_lines.py` already covers `count_generated` via a tmp repo. Add a case that constructs the run-metadata path with `base_ref="HEAD"` and asserts the resolved SHA from `base_ref_sha` produces a non-zero count.
- Backfill for existing runs. Existing `runs/*/metadata.yaml` files don't have `base_ref_sha`. A one-shot script (or a lazy resolver in `lines.py` that calls `git rev-parse` inside the worktree if `base_ref_sha` is missing) handles them. Lazy resolver is simpler — recommended.

## Design principles

- Don't break the `base_ref: HEAD` config default — many runs are still active against it. The fix is to resolve at use-time (or at start-time), not to forbid the symbolic form.
- Schema changes additive only. No rewrites of existing `metadata.yaml` files.

## Acceptance

- A new run created with the default `base_ref: HEAD` reports a non-zero `generated_lines` once any commits land on the worktree branch.
- The token-efficiency pass-1 dogfood run (`2026-05-22-token-efficiency-tracking`) reports non-zero `generated_lines` after the lazy resolver lands — either via re-running `metrics --record` on the existing run, or via a one-shot backfill.
- `tests/test_metrics_lines.py` has a regression test that pins the symbolic-ref behavior.

## Non-goals

Changing the default `base_ref`; making the metrics writer infer the base from `git merge-base`; supporting non-git worktrees.

## Origin

Discovered during the token-efficiency pass-1 dogfood run (`runs/2026-05-22-token-efficiency-tracking/stages/6_followups/follow-ups.md` § "Fix generated_lines for base_ref=\"HEAD\" runs"). Promoted from per-run follow-up to workbench-level TODO so it's actioned outside the original run. Per docs/TODO.md §3.
