# Review

## Decision

approve

## Did the implementation satisfy the brief?

Yes. The brief specified Option (a) — an additive `metadata.target.repo.base_ref_sha` field captured at `/start` time, with a lazy `git rev-parse` fallback inside the worktree for runs that predate the field. Implementation matches both halves. Both `count_generated` and `count_accepted` were updated (DR-004 — brief was generous and let the implementer extend the fix to `count_accepted`; done). The schema change is additive (description string added; old `metadata.yaml` files continue to validate via `metadata.py:_validate`'s shallow check).

The acceptance criterion "tests/test_metrics_lines.py has a regression test that pins the symbolic-ref behavior" is satisfied by `TestBaseRefShaResolution::test_generated_with_base_ref_sha_pins_symbolic_head` — the test explicitly passes `base_ref="HEAD"` + a captured SHA and asserts non-zero count. The bad-ref fallback test (`test_generated_lazy_resolver_falls_back_on_bad_ref`) pins the no-regression contract.

## Did it accidentally expand scope?

No. The diff (`git diff --stat`) is 7 files, 163 insertions, 5 deletions. Every file change traces directly to a numbered item in the plan's "Files likely to change" section. No unrelated files touched. Adjacent `base_ref` consumers explicitly marked out-of-scope in the plan (`lib/board/source.py`, `lib/doc_claims.py`, `lib/audit.py`) remain untouched.

## Are there fragile assumptions?

- **ASM-001 (rev-parse race)**: Acceptable inherent local-tool race; `worktree add` immediately follows the rev-parse in the same command and no concurrent writer is expected in a local-only workflow.
- **ASM-002 (schema laxity)**: Confirmed correct by inspection — `metadata.py:_validate` only enforces top-level keys + status enum, so the additive nested field is safe.
- **R-2 (lazy resolver against `base_ref="HEAD"`)**: This is fundamental and documented. The fallback for *pre-existing* runs whose `base_ref` is the literal `"HEAD"` and whose worktree has advanced will resolve `HEAD` to the worktree's *current* HEAD inside the worktree — producing 0, same as before. New runs (post-this-fix) capture the SHA at `/start` and report correctly. The brief explicitly called the dogfood-run recompute "best-effort", and `qa/report.md` documents why this specific dogfood case can't be recovered without a one-shot backfill that the brief explicitly excluded.
- **DR-005 fallback chain**: `base_ref_sha` → lazy rev-parse → symbolic ref. The third leg matches today's behavior, so no regression is possible. Confirmed by `test_generated_lazy_resolver_falls_back_on_bad_ref`.

## Are there missing tests?

No critical gaps. The two functions that changed have:

- `count_generated`: 4 tests covering captured-SHA path (`test_generated_with_base_ref_sha_pins_symbolic_head`), lazy-resolver branch case (`test_generated_lazy_resolver_uses_symbolic_branch`), bad-ref fallback (`test_generated_lazy_resolver_falls_back_on_bad_ref`), and the pre-existing `test_generated_lines_from_log` / `test_generated_zero_when_no_commits` / `test_generated_includes_artifact_writes` (regressions against the existing happy path).
- `count_accepted`: parallel test `test_accepted_with_base_ref_sha_pins_symbolic_head`, plus the pre-existing three tests still pass against the new signature.
- `resolve_ref_to_sha`: 3 tests (HEAD / branch / missing-ref-raises).
- `cmd_start.py` SHA capture is exercised end-to-end by `tests/test_e2e.py` (which drives `/start` through to terminal states) — confirmed by full-suite pass.

What's *not* tested:
- A unit test asserting `cmd_start` writes the field. Acceptable: the E2E tests cover this transitively (if the field weren't written, the metrics-rebuild test would catch it next pass), and a unit test on `cmd_start` would mostly be testing `metadata.update`'s mutator pattern.
- A test against a deleted source-repo at `/start` (would surface as the new `fail(f"failed to resolve base_ref ...")` line). Out of scope — same shape as every other `RepoError` failure in `cmd_start`.

## Are there security / data loss / migration risks?

- **No security risk.** No new I/O, no new inputs, no new permissions. Pure additive metadata.
- **No data loss risk.** Schema is additive. Old `metadata.yaml` files are read but never rewritten by this change. `metrics --rebuild` writes only `metrics.jsonl` (already true pre-change).
- **Migration**: Lazy resolver inside `lines.py` handles old runs transparently. No script needed. R-2 caveat: lazy resolver against `base_ref="HEAD"` on a worktree-with-commits can't recover the right count for *pre-existing* runs — those still report 0, same as before, no regression.

## What should the human review first?

1. `lib/repos.py:53-62` — `resolve_ref_to_sha`. Confirm the `_git_strict` choice + the `len(sha) < 7` guard match the codebase's defensive style.
2. `lib/cli/cmd_start.py:59-65` — placement of the rev-parse: it runs *before* `create_worktree` against the **source repo** (DR-002). This is the only correct place; the worktree doesn't exist yet, and resolving later inside the worktree would have R-2's failure mode.
3. `lib/metrics/lines.py:_effective_ref` — three-leg fallback chain. The key invariant: if both legs fail, we fall back to the symbolic ref (today's behavior — never a regression).
4. `schemas/run-metadata.yaml` — confirm the field description is honest about the field being optional and about the lazy-resolver migration story.
5. `tests/test_metrics_lines.py::TestBaseRefShaResolution` — the regression test the brief explicitly asked for, plus the bad-ref no-crash test.

## Blast radius

depth 1 (changed files):
- `lib/repos.py`
- `lib/cli/cmd_start.py`
- `lib/metrics/lines.py`
- `lib/metrics/writer.py`
- `schemas/run-metadata.yaml`
- `tests/test_metrics_lines.py`
- `tests/test_repos.py`

depth 2 (production callers of changed symbols, scoped to `lib/`):
- `repos.resolve_ref_to_sha` → `lib/cli/cmd_start.py:64` (only caller).
- `lines.count_generated` → `lib/metrics/writer.py:214` (only production caller).
- `lines.count_accepted` → `lib/metrics/writer.py:229` (only production caller).
- `_effective_ref` (new private) → `lines.py` internal only.

depth 3 (callers of `metrics.writer.write_metrics`):
- `lib/cli/cmd_metrics.py` (the `metrics` subcommand) — invoked at every `metrics <id>`, `metrics --all`, `metrics --rebuild`. Plus the hook calls from `cmd_validate`, `cmd_complete`, `cmd_abandon`, `cmd_followups` (per the pass-1 LOG.md note in `docs/TODO.md` §1). All consume the new shape transparently since the `base_ref_sha` kwarg has a `None` default.

No depth-2 or depth-3 callers fall outside the brief's expected scope (`lib/metrics/`, `lib/cli/`, `schemas/`, `tests/`). No scope creep.

## Findings

### F-001 (informational, non-blocking)

- **Severity**: minor / informational
- **Where**: `lib/metrics/lines.py:_effective_ref`
- **Issue**: The lazy fallback inside the worktree resolves `HEAD` to the worktree's *current* HEAD, which makes `<resolved-HEAD>..HEAD` empty on any pre-existing run whose `base_ref="HEAD"` and whose worktree has advanced. This is the R-2 limitation documented in `plan.md` and `qa/report.md`. Not a code bug — a fundamental property of the symbolic ref. For pre-existing runs (e.g. `2026-05-22-token-efficiency-tracking`), recovering the right number requires either a one-shot backfill (out of scope per brief non-goals) or re-recording `merge-base` against a stable ref.
- **Suggested fix**: None for this PR. A follow-up TODO could land a `tools/backfill_base_ref_sha.py` that walks `runs/*/metadata.yaml`, runs `git merge-base <worktree-branch> master` inside each worktree, and writes `base_ref_sha`. Captured in `follow-ups.md` for the next stage.
