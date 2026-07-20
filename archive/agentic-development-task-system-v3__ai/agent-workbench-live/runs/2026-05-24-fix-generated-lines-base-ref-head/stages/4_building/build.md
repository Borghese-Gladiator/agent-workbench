# Build report

## What changed

Per TODO §3: `lib/metrics/lines.py:count_generated()` runs `git log --numstat <base_ref>..HEAD` where `base_ref` is the literal string `"HEAD"` for default-config runs. `HEAD..HEAD` resolves to zero commits, so `generated_lines` reported 0 for every run that used the default. Fix is two-part: (a) capture a resolved 40-char SHA at `/start` time as a new optional `metadata.target.repo.base_ref_sha` field; (b) prefer that SHA in `lib/metrics/lines.py`, with a lazy `git rev-parse <base_ref>` inside the worktree as the fallback for runs that predate the field. `count_accepted` got the same treatment (same bug, same shape).

## Files changed

- `agent-workbench-live/lib/repos.py` — new `resolve_ref_to_sha(repo_path, ref)` helper that wraps `git rev-parse --verify`, raises `RepoError` on failure.
- `agent-workbench-live/lib/cli/cmd_start.py` — resolves `base_ref` to a SHA against the source repo *before* `git worktree add`; persists via the existing `_m(d)` mutator alongside `worktree.path` / `worktree.created`. Failure surfaces as a clean `fail(..., 2)`.
- `agent-workbench-live/lib/metrics/lines.py` — both `count_generated` and `count_accepted` gain an optional `base_ref_sha` kwarg. New `_effective_ref(worktree_path, base_ref, base_ref_sha)` returns the SHA if present; else lazy `git rev-parse --verify <base_ref>` inside the worktree; else the symbolic ref (today's behavior — strict-improvement fallback).
- `agent-workbench-live/lib/metrics/writer.py` — reads `repo.base_ref_sha` next to `repo.base_ref` and passes both through to `count_generated` and `count_accepted`.
- `agent-workbench-live/schemas/run-metadata.yaml` — adds optional `target.repo.base_ref_sha` field (string or null) with description; adds `base_ref_sha: null` to the illustrative `template:` block.
- `agent-workbench-live/tests/test_metrics_lines.py` — new `TestBaseRefShaResolution` class: 4 tests covering symbolic-`HEAD`-with-captured-SHA, lazy-resolver branch case, bad-ref fallback (no crash), and the `count_accepted` parallel.
- `agent-workbench-live/tests/test_repos.py` — new `TestResolveRefToSha` class: 3 tests (HEAD → full SHA, branch name → full SHA, missing ref raises).

## Reviewer reading order

1. `lib/repos.py` — the new helper. One function, mirrors the style of `resolve_parent_branch` directly above it.
2. `lib/metrics/lines.py` — the `_effective_ref` helper + the two consumers. The fallback chain is the load-bearing piece; confirm it's strictly an improvement.
3. `lib/cli/cmd_start.py` — placement of the rev-parse call (before `create_worktree`, with the captured SHA persisted by extending the existing `_m(d)` mutator so the audit log is consistent).
4. `lib/metrics/writer.py` — passes the new field through to both consumers.
5. `schemas/run-metadata.yaml` — additive only; the `template:` block also gets `base_ref_sha: null` for documentation honesty.
6. `tests/test_metrics_lines.py` — the regression test the brief explicitly called for is `test_generated_with_base_ref_sha_pins_symbolic_head`. The bad-ref fallback test pins the no-regression contract.
7. `tests/test_repos.py` — `TestResolveRefToSha` is small (3 tests) and parallels `TestResolveParentBranch`.

## Acceptance criteria coverage

| AC | Test or justification |
|----|-----------------------|
| New run with default `base_ref: HEAD` reports non-zero `generated_lines` once commits land | `tests/test_metrics_lines.py::TestBaseRefShaResolution::test_generated_with_base_ref_sha_pins_symbolic_head` — `base_ref="HEAD"` + captured SHA → 3 lines from the follow-up commit |
| `count_accepted` parallel | `tests/test_metrics_lines.py::TestBaseRefShaResolution::test_accepted_with_base_ref_sha_pins_symbolic_head` — same shape; 3 lines accepted |
| Lazy resolver works for pre-existing runs (no `base_ref_sha`) | `tests/test_metrics_lines.py::TestBaseRefShaResolution::test_generated_lazy_resolver_uses_symbolic_branch` — `base_ref="main"`, no SHA → 2 lines from feature branch |
| Bad-ref fallback never crashes | `tests/test_metrics_lines.py::TestBaseRefShaResolution::test_generated_lazy_resolver_falls_back_on_bad_ref` — `base_ref="nonexistent-ref-xyz"` returns 0 cleanly |
| `resolve_ref_to_sha` helper round-trips and raises sensibly | `tests/test_repos.py::TestResolveRefToSha` (3 tests) |
| Existing `metadata.yaml` files still validate (no field rewrites) | `metadata.py:_validate` only enforces top-level + status enum (verified by inspection); the new field is additive in the YAML schema; full pre-existing test suite still passes (240 vs 233 baseline, all new tests are additive) |
| Dogfood-run recompute (QA-3) | See `qa/report.md` — exercised against this run's own `metrics --rebuild`. Result is documented per R-2: the lazy resolver against `base_ref="HEAD"` resolves to the worktree's *current* HEAD on runs whose `base_ref_sha` was not captured at `/start`, so the count is 0 by construction. New runs (post-this-fix) will report correctly. |

## Deviations from plan

- None. Plan and implementation match.
- The QA-3 "dogfood run reports non-zero" acceptance criterion is documented as expected-given-R-2 in `qa/report.md`. The brief noted it as best-effort; the plan's DR-005 + R-2 spelled out exactly why a `base_ref="HEAD"` run without a captured SHA can't be recomputed via the lazy resolver alone.

## Known issues

- None functional. Per R-2: for pre-existing runs whose `metadata.target.repo.base_ref` is the literal `"HEAD"` and whose worktree HEAD has since advanced (i.e. this run, and the dogfood run `2026-05-22-token-efficiency-tracking`), the lazy resolver inside the worktree resolves `HEAD` to the worktree's current HEAD, producing 0 — the same as before. New runs from now on capture the SHA at `/start` and get the right number. A one-shot backfill (out of scope per the brief's non-goals) would compute `git merge-base <branch> <symbolic-ref>` and write `base_ref_sha` into each old `metadata.yaml`.

## Commands run

- `python -m pytest tests/ -q` — baseline (master): 233 passed + 2 pre-existing date-baked snapshot failures; post-fix: 240 passed (+7 new) + same 2 pre-existing failures.
- `python -m pytest tests/test_metrics_lines.py tests/test_repos.py -v` — targeted: 33 passed.
- Smoke check: `repos.resolve_ref_to_sha('<source-repo>', 'HEAD')` returns the master HEAD SHA (`098c24a52328fe2db78f636a7976bb1ee303d614`), confirming the `/start` capture path resolves correctly against a real repo. Matches `git merge-base agent/fix-generated-lines-base-ref-head master`.

## Documentation touched

none needed — the change is internal-only and has no user-facing surface beyond the line-count numbers in `agent-workbench metrics`. The brief documents the field semantics; `schemas/run-metadata.yaml` describes the field for any reader.
