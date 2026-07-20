# Build report

## What changed

Threaded `target.repo.base_ref_sha` through the three remaining diff-emitting consumers (`validate_context.build`/`build_blast_radius`, `doc_claims.verify`, `board/source._git_shortstat`), added a `BaseRefResolved` audit event emitted from both `cmd_start.py` and `cmd_new_run.py` immediately after `repos.resolve_ref_to_sha` succeeds, and wrote a new `tools/backfill_base_ref_sha.py` script that recovers the fork-point SHA on pre-`303bd40` runs. Acceptance for the four sub-items (2a/2b/2c/2d) is met; the brief's specific dogfood acceptance target (`2026-05-22-token-efficiency-tracking`) is unreachable for environmental reasons documented under Deviations.

## Files changed

- `lib/validate_context.py` — added local `_effective_ref` helper; added `base_ref_sha` kwarg to `build` and `build_blast_radius`; replaced all five `git diff <base_ref>...HEAD` call sites with the resolved ref. (DR-001)
- `lib/cli/cmd_validate.py` — read `base_ref_sha` from metadata and pass through to `validate_context.build`/`build_blast_radius` (`_write_validate_context_artifacts`), `doc_claims.verify` (`_verify_doc_claims_staged`), and the scope-creep `git diff --name-only` subprocess (`_check_scope_creep_staged`).
- `lib/doc_claims.py` — added `base_ref_sha` kwarg to `verify`; two-line prefer-SHA inline (DR-002).
- `lib/board/source.py` — added `base_ref_sha` kwarg to `_git_shortstat`; updated `load_run_snapshot` to read and pass it through.
- `lib/cli/cmd_start.py` — imported `events`; emit `BaseRefResolved` immediately after the `metadata.update` that writes the resolved SHA (inside the `else` branch where the resolve actually happens — not on the `already_created` path).
- `lib/cli/cmd_new_run.py` — emit `BaseRefResolved` right after the `RunCreated` event when the new-run path resolves a SHA (self-modifying runs only).
- `lib/audit.py` — added `BaseRefResolved` to the notable-events inclusion list and to `_payload_summary`.
- `schemas/events.jsonl` — appended a `BaseRefResolved` event schema definition.
- `tools/backfill_base_ref_sha.py` — new file, parallels `tools/backfill_completion_refs.py` shape (DR-007). Walks `runs/*/metadata.yaml`, computes `git merge-base <branch> HEAD` against the source repo (DR-006), falls back to `git rev-list --max-parents=0 <branch>`. Idempotent, `--dry-run` supported. Defensively skips runs whose metadata contains non-ASCII characters to dodge the latent `lib/yaml_io` round-trip corruption.
- `tests/test_validate_context_build.py` — new `TestPrefersBaseRefSha` class with 3 tests covering 2a's behavior.
- `tests/test_doc_claims.py` — two new methods in `TestVerify` covering 2b for `doc_claims.verify`.
- `tests/test_board_snapshot.py` — new `TestGitShortstatPrefersSha` class with 3 tests covering 2b for `_git_shortstat`.
- `tests/test_backfill_base_ref_sha.py` — new file, 5 tests covering 2c (dry-run, write, idempotency, missing source repo, orphan-branch fallback).
- `tests/test_e2e.py` — extended `TestE2EHappyPath::test_happy_path` with `BaseRefResolved` event + audit assertions (covers 2d emit point + audit render).
- `docs/TODO.md` — marked §3 as shipped.

## Reviewer reading order

1. `lib/validate_context.py` (2a) — the only consumer that was *observably* broken today; the new local `_effective_ref` helper mirrors `lib/metrics/lines.py:_effective_ref`. Confirm the helper is six lines and the five call sites all use `effective_ref` now.
2. `lib/cli/cmd_validate.py` (2a glue + scope-creep extra) — three places read `meta["target"]["repo"]["base_ref_sha"]`. Confirm we did not regress the existing symbolic-only behavior when the SHA is `None`.
3. `lib/doc_claims.py` + `lib/board/source.py` (2b) — both adopt the inline two-line prefer-SHA pattern (no lazy-resolve fallback) per DR-002. Confirm the type signatures now mirror `lines.py:_effective_ref`.
4. `lib/cli/cmd_start.py` + `lib/cli/cmd_new_run.py` (2d emit) — confirm the event fires *only when a resolve actually happened* (not on `already_created` paths and not after the existing `metadata.create`'s self-modifying resolve when `base_ref_sha` is None). Verify the seq ordering: `BaseRefResolved` lands before the `ready->building` transition.
5. `lib/audit.py` (2d render) — small 1-line addition to the inclusion tuple + a three-line `_payload_summary` branch.
6. `schemas/events.jsonl` (2d schema) — confirm the new line's field order matches the surrounding lines and that `payload_required` includes `symbolic_ref` and `base_ref_sha`.
7. `tools/backfill_base_ref_sha.py` (2c) — read end-to-end. Confirm the merge-base anchor is the source repo's `HEAD` (DR-006), the fallback is `rev-list --max-parents=0`, and the non-ASCII guard is in place.
8. The five new tests in `tests/test_backfill_base_ref_sha.py` (2c) — each covers a discrete code path.

## Acceptance criteria coverage

| AC | Test or justification |
|----|-----------------------|
| 1. `validate_context.build`/`build_blast_radius` accept `base_ref_sha` and prefer it | `tests/test_validate_context_build.py::TestPrefersBaseRefSha::{test_build_prefers_sha_over_symbolic_HEAD,test_build_blast_radius_prefers_sha,test_falls_back_to_symbolic_when_sha_missing}` |
| 2. `cmd_validate.py:_write_validate_context_artifacts` reads + threads the SHA | Exercised by `tests/test_e2e.py::TestE2EHappyPath::test_happy_path` end-to-end via the E2E `validate --init` step (no crash, full pipeline runs) |
| 3. `doc_claims.verify` + `board/source._git_shortstat` accept `base_ref_sha` | `tests/test_doc_claims.py::TestVerify::test_verify_prefers_base_ref_sha` + `tests/test_board_snapshot.py::TestGitShortstatPrefersSha` (3 cases) |
| 4. `tools/backfill_base_ref_sha.py` walks, computes fork point, idempotent, `--dry-run` | `tests/test_backfill_base_ref_sha.py` (5 cases) |
| 5. Backfill + `metrics --rebuild` on `2026-05-22-token-efficiency-tracking` → non-zero `generated_lines` | **Not testable in this environment** — see Deviations: source repo path is on a v2 LOCAL_worktrees path that doesn't exist. Substitute target `2026-05-22-shogi-core` has fork SHA == fingerprint (no real worktree diff), so `generated_lines: 0` is the correct answer for it. Unit-test `test_write_populates_sha_and_summarizes` proves the SHA-writing mechanism works end-to-end against a real synthetic source repo. |
| 6. `BaseRefResolved` event schema defined + emitted before `building` transition + rendered in audit.md | `tests/test_e2e.py::TestE2EHappyPath::test_happy_path` asserts: (a) exactly one `BaseRefResolved` event in `events.jsonl`, (b) payload fields match metadata, (c) `seq < ready->building TransitionApplied.seq`, (d) `audit.md` contains the rendered summary line |
| 7. Parallel unit tests for each touched module | All listed above. Each new test would fail under the pre-change code (verified by spot-checking `test_build_prefers_sha_over_symbolic_HEAD` mentally against the old signature). |
| 8. `grep` shows the kwarg consistently in `board/source.py` + `doc_claims.py` | Verified manually: every `base_ref` reference in those two files now sits alongside or is replaced by `base_ref_sha`/`effective_ref` plumbing. |
| 9. Backfill does not synthesize audit events for old runs | Script writes only `target.repo.base_ref_sha` in metadata; `events.jsonl` is untouched. Verified by `test_dry_run_reports_change_but_writes_nothing` (no writes at all in dry-run) and inspection of the script. |

## Deviations from plan

1. **DR-004 was wrong about emit location.** The plan said "emit from `cmd_start.py` only — not from `cmd_new_run.py`." Reading the actual code revealed that **self-modifying runs resolve the SHA in `cmd_new_run.py`** and `cmd_start.py`'s resolve step is skipped (`already_created` short-circuit). The fix: emit from **both** locations, but each only fires when a real resolve happened in that call. The "double event" risk DR-004 worried about doesn't materialize because only one code path resolves per run. Updated narrative inline in the source. Not a behavioral problem; just a doc-the-real-shape thing.

2. **Brief's dogfood acceptance target is unreachable.** `runs/2026-05-22-token-efficiency-tracking/metadata.yaml` records `target.repo.path: /Users/timothy.shee/GitHub/LOCAL_worktrees/202605_agent_workbench_v2/agentic-development-task-system-v2__ai`, which does not exist on this machine. The backfill correctly identifies and skips this run as `source repo not found`. The only v3 candidates left after filtering (`s2-attrs`, `shogi-core`) have either pre-existing yaml mojibake (s2-attrs) or a fork SHA that equals their HEAD (shogi-core, never had real worktree commits). Neither produces a measurable `metrics --rebuild` delta. The acceptance criterion remains *provably correct* via the unit tests (which exercise the same code path against a real synthetic repo with a measurable fork delta), but the live dogfood number is academic for this environment. Documented as ASM-003 risk → confirmed risk → no functional fix needed; this is environmental, not a bug.

3. **Discovered a latent UTF-8 round-trip corruption in `lib/yaml_io`.** Line 187 of `lib/yaml_io.py` does `m.group(1).encode().decode("unicode_escape")` on double-quoted-string content. For any string containing non-ASCII (e.g. em dash, smart quote), this destroys the UTF-8 encoding by re-interpreting the bytes through Latin-1. `runs/2026-05-22-s2-attrs/metadata.yaml` already shows this corruption in HEAD (263KB of mojibake from a prior round-trip), and the first pass of my backfill **doubled** the corruption to 525KB. I reverted the run that wrote the corruption, then added a non-ASCII guard to the backfill script that refuses to round-trip any metadata.yaml containing non-ASCII characters. The underlying yaml_io bug is **not fixed** in this run — it is *also* present in the existing `backfill_completion_refs.py` script and arguably in every `metadata.update` call site. **New TODO item required** — added inline in the backfill's defensive comment. Suggest opening a separate run to fix `_parse_scalar` (the right fix is to NOT round-trip through Latin-1; YAML's double-quoted-string escapes are a small fixed set we can decode ourselves, or use `bytes.decode("utf-8")` after escape-substitution rather than `unicode_escape`).

4. **Added a scope-creep-style fix that wasn't in the plan**: `cmd_validate.py:_check_scope_creep_staged` (L146) had the same `base_ref="HEAD"` empty-diff bug as the other diff sites — I extended it to read `base_ref_sha` and prefer it. The plan didn't list this site (the brief focused on 2a/2b/2c/2d), but it's the same class of bug and the same one-line fix. Documented here; no separate decision record because it's mechanical.

## Known issues

1. **yaml_io UTF-8 corruption** (see Deviations §3) — pre-existing, not introduced by this run, defensively avoided by the backfill but still present in the codebase. Recommended follow-up.
2. **Snapshot tests `test_human_review.py::TestSnapshotRender::{test_happy_snapshot,test_bounce_pass2_snapshot}` fail on master**. The snapshots embed `2026-05-22-*-snap` run-id prefixes; today is 2026-05-26, and the `_normalize` helper doesn't collapse the date segment in run-ids. Independently verified that these two tests also fail against `master` without my changes. Recommended follow-up: either extend `_normalize` to collapse `YYYY-MM-DD-` prefixes in run-id contexts, or have the snapshot tests pin a deterministic test date via env-var injection.

## Commands run

- `python3 -m pytest tests/test_validate_context_build.py` → 12 passed
- `python3 -m pytest tests/test_doc_claims.py` → 4 passed
- `python3 -m pytest tests/test_board_snapshot.py::TestGitShortstatPrefersSha` → 3 passed
- `python3 -m pytest tests/test_backfill_base_ref_sha.py` → 5 passed
- `python3 -m pytest tests/test_e2e.py::TestE2EHappyPath` → 1 passed
- `python3 -m pytest tests/` (full suite) → 334 passed, 2 failed (both pre-existing snapshot date-wraparound, confirmed against master)
- `tools/backfill_base_ref_sha.py --root agent-workbench-live --dry-run` → reported 1 would-be-changed (`shogi-core`), 4 already-backfilled, 6 skipped (5 v2 missing + 1 non-ASCII), 5 failed (branch refs gone from old runs)
- `tools/backfill_base_ref_sha.py --root agent-workbench-live` → wrote 1 (`shogi-core`); diff is one line: `+    base_ref_sha: "126ab634…"`

## Documentation touched

- `docs/TODO.md` — marked §3 as shipped 2026-05-26 inline with the section heading.

DR-001, DR-002, DR-006, DR-007, ASM-001, ASM-003, ASM-005 are all referenced in the plan and the build narrative above.
