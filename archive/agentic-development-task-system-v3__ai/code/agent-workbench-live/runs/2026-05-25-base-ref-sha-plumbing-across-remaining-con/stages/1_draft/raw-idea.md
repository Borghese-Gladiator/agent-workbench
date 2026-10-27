# base_ref_sha plumbing across remaining consumers, audit trail, and backfill

From `docs/TODO.md` §3.

`303bd40` added `target.repo.base_ref_sha` to `metadata.yaml` and threaded the prefer-SHA / lazy-resolve / fallback pattern into `lib/metrics/lines.py`. Three other consumers still take a symbolic `base_ref` and produce wrong or empty output when the recorded value is `"HEAD"`; a backfill tool for pre-fix runs is also unwritten, and the audit log doesn't record the resolved SHA at all.

## 2a. `lib/validate_context.py` — empty diff against worktree branch HEAD

`validate_context.build` and `build_blast_radius` take `base_ref: str` and shell out `git diff <base_ref>...HEAD` literally. With `base_ref="HEAD"`, that resolves to the worktree HEAD vs. itself — the diff is empty even when the worktree has real commits. Downstream: the reviewer's blast-radius narrative is fed an empty file list and validate-context.md's "Files changed" block reads `(no files changed yet)`.

- [ ] Add a `base_ref_sha: str | None = None` kwarg to `validate_context.build` and `build_blast_radius`. Prefer the SHA when present; fall back to symbolic `base_ref` lazy-resolve when missing. Mirror `lib/metrics/lines.py:_effective_ref`.
- [ ] Thread the SHA through `cmd_validate.py:_write_validate_context_artifacts` (read `meta["target"]["repo"]["base_ref_sha"]` alongside `base_ref`).
- [ ] Confirm the diff target is the worktree path (it already is) and that the SHA was originally captured against the source repo (it was).
- [ ] Unit test against a synthetic two-commit worktree — would fail today, pass after.

## 2b. `lib/board/source.py:_git_shortstat` and `lib/doc_claims.py:_verify`

Both still take symbolic `base_ref`. Neither is *broken* in the same observable way as 2a (the triple-dot diff produces *a* number when `base_ref="HEAD"`), but the type signature has drifted: `lines.py` knows about `base_ref_sha`, these two don't. Pure type-symmetry / consistency play.

- [ ] Add `base_ref_sha` kwarg to `_git_shortstat` and `verify`; lazy-fallback chain identical to `lines.py:_effective_ref`.
- [ ] Update call sites (`board/source.py:566` and the `doc_claims.verify` call in `cmd_validate.py`).
- [ ] Parallel unit tests in `tests/test_board_snapshot.py` and `tests/test_doc_claims.py`.

## 2c. Backfill tool for pre-`303bd40` runs

`tools/backfill_completion_refs.py` exists for merge SHAs; no equivalent for `base_ref_sha`. Runs like `2026-05-22-token-efficiency-tracking` whose `base_ref: "HEAD"` was captured before this run still report `generated_lines: 0` even after a `metrics --rebuild` (the lazy resolver inside the worktree can't recover the original fork point once HEAD has advanced).

- [ ] Write `tools/backfill_base_ref_sha.py`. Walk `runs/*/metadata.yaml`. For each entry with symbolic `target.repo.base_ref` and missing `target.repo.base_ref_sha`, compute the fork point — preferred: `git merge-base <target.worktree.branch_name> <agent-workbench.yaml-default-base-ref>`; fall back to `git rev-list --max-parents=0 <branch>` when merge-base fails. Write via `metadata.update`. Idempotent. `--dry-run` flag.
- [ ] After the script lands, run it once on this repo and verify `agent-workbench metrics --rebuild` against the pass-1 dogfood run reports non-zero `generated_lines` (TODO §3 acceptance from the prior fix-generated-lines TODO).

## 2d. `BaseRefResolved` event

The resolved SHA only lives in `metadata.yaml`. The audit trail (`events.jsonl`) records the transition with `base_ref: "HEAD"` symbolic and nothing else. Two consequences: (1) line counts can't be re-derived from the audit log alone, (2) drift between `metadata.yaml` and the original resolved SHA is undetectable.

- [ ] Add `BaseRefResolved` to `schemas/events.jsonl` with payload `{symbolic_ref, sha, source_repo_path}`.
- [ ] Emit from `cmd_start.py` immediately after `repos.resolve_ref_to_sha` succeeds, before the `building` transition.
- [ ] Surface in `lib/audit.py`'s `audit.md` render.
- [ ] Forward-only. Don't synthesize events for old runs — pair with the backfill tool (2c), which writes metadata only.

## Acceptance

- `validate-context.md` "Files changed" block lists real worktree-branch commits for any run whose metadata carries `base_ref_sha`.
- `agent-workbench metrics --rebuild` against `2026-05-22-token-efficiency-tracking` reports a non-zero `generated_lines` after the backfill script runs.
- `events.jsonl` for new runs contains a `BaseRefResolved` event between the `planning → ready` and `ready → building` transitions.
- Grep for `base_ref:` in `lib/board/source.py` + `lib/doc_claims.py` finds calls that also accept `base_ref_sha`.
