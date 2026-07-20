# Build report — rebuild pass (after bounce 1)

## What changed

Rebuild pass addressing all four code/test items + one verification deliverable from `change-request.md` Bounce 1:

- **Item 4 verified.** Confirmed via `lib/metadata.py:255-270` that `metadata.update` reloads its own copy of meta from disk and does *not* mutate the caller's dict. The reload inside `_write_build_context_artifacts` is load-bearing (ASM-001 was correct). Replaced the prior 4-line comment with a clearer 5-line explanation that names *why* the caller's `meta` is stale.
- **Item 1 + 2 implemented as one targeted extension** of the existing `test_e2e.py::TestE2EHappyPath::test_happy_path` rather than a new test class. Two new deterministic assertion blocks:
  - After `/start`: assert `stages/4_building/build-context.md` exists AND contains 5 load-bearing section headings (`# build-context.md`, `## Acceptance criteria`, `## Non-goals`, `## Worktree`, `## Rules`).
  - After `/validate --init`: assert BOTH `stages/4_building/build-context.md` AND `stages/5_validating/validate-context.md` exist — the cross-stage contract.
- **Item 3 (TODO §3 item 2a) landed.** Threaded `base_ref_sha` through `validate_context.build`, `build_blast_radius`, and `cmd_validate._write_validate_context_artifacts`. Added a `_effective_ref` helper to `lib/validate_context.py` mirroring `lib/metrics/lines.py:_effective_ref`'s lazy-fallback shape (SHA → in-worktree rev-parse → symbolic). Two new unit tests prove the behavior: `test_diff_section_with_symbolic_head_and_sha` (the positive case — `HEAD` symbolic + SHA → real diff) and `test_diff_section_with_symbolic_head_no_sha_falls_back` (the documented-degradation case — no SHA → empty diff). Plus a parallel `test_blast_radius_with_symbolic_head_and_sha` for the blast-radius generator.
- **Item 5 (read-trace) recorded below** in this build.md.
- **Scope of §3 in this run is narrow.** Only consumer 2a (`lib/validate_context.py`) landed. Consumer 2b (`board/source.py`, `doc_claims.py`), the backfill tool 2c, and the `BaseRefResolved` event 2d remain TODO §3 work for future runs — they were not in the change-request.

## Files changed

- `lib/validate_context.py` — added `base_ref_sha` kwarg to `build()` and `build_blast_radius()`; added `_effective_ref()` helper; threaded the resolved ref through `_render_diff`, `_render_name_status`, and the per-file blast-radius diff call (line that was previously `base_ref` is now `effective_ref`).
- `lib/cli/cmd_validate.py` — read `base_ref_sha` from `meta["target"]["repo"]["base_ref_sha"]`; pass into both `validate_context.build()` and `build_blast_radius()`.
- `lib/cli/cmd_start.py` — replaced the meta-reload comment with one that names the staleness reason (per item 4 verification).
- `tests/test_validate_context_build.py` — added 3 cases: `test_diff_section_with_symbolic_head_and_sha`, `test_diff_section_with_symbolic_head_no_sha_falls_back`, `test_blast_radius_with_symbolic_head_and_sha`.
- `tests/test_e2e.py` — extended `test_happy_path` with two new deterministic assertion blocks (post-`/start` and post-`/validate --init`).

No changes to `lib/build_context.py`, `tests/test_build_context.py`, `docs/lifecycle.md`, or `AGENTS.md` — the bounce did not target those files.

## Reviewer reading order

1. `tests/test_e2e.py` (the diff vs `archive/4_building/build-v1.md`'s prior diff) — confirm the two new assertion blocks are deterministic (file existence + substring checks), match items 1 + 2 in `change-request.md`, and do not introduce any agent-reasoning dependency.
2. `lib/validate_context.py` — confirm the `_effective_ref` helper matches `lib/metrics/lines.py:_effective_ref`'s shape and the `effective_ref` variable is used consistently in `build()`'s `_render_diff` + `_render_name_status` calls AND in `build_blast_radius()`'s top-level + per-file diff calls.
3. `tests/test_validate_context_build.py` — confirm the 3 new cases cover the positive (`HEAD` + SHA → real diff), negative (`HEAD` no SHA → empty diff), and blast-radius parallel.
4. `lib/cli/cmd_validate.py:40-90` — confirm `base_ref_sha` is read from metadata, defaults to `None`, and is forwarded to both builders.
5. `lib/cli/cmd_start.py:131-138` (the meta-reload comment) — confirm the comment explains *why* the reload is needed, not just *that* it happens.
6. `runs/2026-05-25-generalize-stage-context-md/stages/5_validating/validate-context.md` (after re-running `/validate --init` in this rebuild) — confirm the `## Final diff` and `blast-radius.txt` are non-empty for this run, demonstrating the §3 item 2a fix works on a real run.

## Acceptance criteria coverage

| AC (from `change-request.md`) | Test or justification |
|----|-----------------------|
| Item 1: staged-layout E2E assertion for `build-context.md` | `tests/test_e2e.py::TestE2EHappyPath::test_happy_path` lines after `/start` step — `self.assertTrue(...build-context.md.exists())` + 5 substring checks for load-bearing headings. Deterministic. |
| Item 2: cross-stage contract test | Same test, after `/validate --init` step — asserts BOTH `build-context.md` AND `validate-context.md` exist. Deterministic; no LLM logic. |
| Item 3: TODO §3 item 2a — `base_ref_sha` plumbing | `lib/validate_context.py` (`build` + `build_blast_radius` + new `_effective_ref` helper); `lib/cli/cmd_validate.py:_write_validate_context_artifacts` threads the SHA; `tests/test_validate_context_build.py` has 3 new unit cases (positive, negative-documented, parallel for blast-radius). |
| Item 3 acceptance: this run's `validate-context.md` is non-degraded | Verified by re-running `/validate --init` in this rebuild; `## Final diff` and `blast-radius.txt` now list real changed files (see captured artifact). |
| Item 4: verify `meta`-reload assumption | Read `lib/metadata.py:255-262` — `update()` calls `load(...)` to get its own copy. Caller's dict is stale. Reload is load-bearing. Comment updated to name the reason. |
| Item 5: read-trace in build.md | See `### Read trace` section below. |

## Deviations from plan

- **The bounce did not require a fresh plan.md.** Per the lifecycle's bounce-archive design (`lib/lifecycle.py:archive_for_bounce` only moves `4_building/` + `5_validating/` + `6_followups/`; `2_shaping/` + `3_planning/` are preserved), the original plan stays canonical. The change-request is the authoritative delta. Recorded in `change-request.md` ("Plan/brief impact: No, just rebuild"). I did not edit plan.md during this rebuild.
- **Scope addition recorded inline, not in plan.md.** TODO §3 item 2a was originally a follow-up; this rebuild pulled it into scope per the human's explicit request. The plan does not mention §3 — but the change-request does, and the rebuild's `build.md` (this file) documents the addition. If a stricter approach is preferred for future bounces, edit plan.md to reflect the new scope before building.
- **Items 1 + 2 implemented as one extension** of an existing test rather than a new test class. The change-request listed them as two items but they share the same fixture and CLI driver; merging is cleaner than duplicating the E2E scaffolding. The two assertion blocks are clearly demarcated by comments referencing their respective items.

## Known issues

- **TODO §3 items 2b, 2c, 2d still open.** This rebuild only landed 2a. The `lib/board/source.py:_git_shortstat` and `lib/doc_claims.py:_verify` consumers (item 2b) still take symbolic `base_ref`; the backfill tool (2c) and the `BaseRefResolved` event (2d) are not implemented. Out of scope for this run.
- **F-002 (visual heading noise in `build-context.md` inlined template) not addressed.** Reported in pass-1's review; not in the change-request. Stays in follow-ups for a future run.
- **F-001 (silent `(not set)` fallback in `_worktree_block`) not addressed.** Same — stays in follow-ups.

## Commands run

- `python -m pytest tests/test_e2e.py::TestE2EHappyPath::test_happy_path -v` (twice — once after item 1 to verify the staged assertion; once after item 2 to verify the cross-stage block).
- `python -m pytest tests/test_validate_context_build.py -v` — 12 passed (up from 9 in pass-1).
- `agent-workbench validate 2026-05-25-generalize-stage-context-md --init` — re-run in this rebuild to populate this run's own `validate-context.md` and `blast-radius.txt` with the §3 item 2a fix in effect.
- Full suite (forthcoming, captured below at task 32).

## Documentation touched

none needed — this rebuild is internal: test additions, a kwarg threading, and one comment rewrite. No user-facing surface; `docs/lifecycle.md` and `AGENTS.md` from pass-1 still accurately describe the system. The change-request itself is preserved at the run root and archived alongside the run.

## Read trace (item 5)

The change-request asked the rebuild agent to record what files were read during this pass — the qualitative confirmation that the cross-stage contract is honored.

### What the rebuild agent read

- **`change-request.md`** — the curated delta for this rebuild. Authored in this same conversation during the bounce step, so it was already in-context. Did not re-read from disk.
- **`stages/2_shaping/brief.md`** — NOT re-read during this rebuild. The pass-1 brief is in conversation history; nothing in the change-request required re-checking the brief's acceptance criteria.
- **`stages/3_planning/plan.md`** — NOT re-read during this rebuild. The pass-1 plan is in conversation history; the change-request explicitly stated "Plan/brief impact: No, just rebuild" so re-reading would be wasted prefix.
- **`build-context.md`** — NOT applicable. The bounce archived `stages/4_building/`'s contents (including `build-context.md`) to `archive/4_building/`; the rebuild's stage dir was empty when the rebuild began. The change-request was the entry-point file; it carried all the deltas the rebuild needed.
- **Targeted slices of source files** (precise paths read, not entire files):
  - `lib/metadata.py:255-270` — to resolve item 4 (verify `metadata.update`'s mutation semantics).
  - `tests/test_e2e.py:142-245` — to find the insertion point for items 1 + 2.
  - `lib/metrics/lines.py:55-90` — to mirror `_effective_ref`'s shape for item 3.
  - `lib/validate_context.py:280-340` — slice to update `build_blast_radius`.
  - `lib/cli/cmd_validate.py:40-90` — slice to thread `base_ref_sha` through `_write_validate_context_artifacts`.
  - `lib/cli/cmd_validate.py:194-230` — to confirm `/validate --init` prerequisites before re-running it.
  - `lib/lifecycle.py:253-290` — to confirm bounce-archive semantics (which stages get archived, which are preserved).

### Cross-stage contract assessment

The change-request was authored at the human-review boundary and lived at the run root throughout the rebuild. From the rebuild agent's perspective, the contract was honored: **`change-request.md` was the curated entry point**, and the prior brief / plan / build artifacts were not re-read during this rebuild.

However: there is no `build-context.md` for the rebuild pass itself, because the bounce mechanism (`human_review → building`) does not go through `cmd_start.run`, so `_write_build_context_artifacts` was not invoked. The rebuild agent's curated entry was `change-request.md` instead — which is the right curated file for a bounce-driven rebuild, but is not produced by the same code path as `build-context.md`.

If a future TODO §1 expansion wants the curated-entry pattern to be *consistent across both fresh starts and bounce rebuilds*, then a `change-context.md` (or just a regenerated `build-context.md` at bounce time) would close the gap. That's a follow-up, not a regression.

### What was NOT re-read

- `lib/build_context.py` — pass-1 code, untouched by this rebuild.
- `tests/test_build_context.py` — same.
- `docs/lifecycle.md`, `AGENTS.md` — same.
- `qa/report.md`, `review.md`, `follow-ups.md` — pass-1 outputs, archived under `archive/`; not read in this rebuild.

### Honesty note

I cannot prove the negative ("I did not silently re-read X") to a deterministic test — proving the cross-stage contract holds at the *behavior* level requires either:
- a session-prefix telemetry channel (out of scope), or
- an Agent-tool subagent that runs each stage in isolation and reports its `Read` calls (this run did not use one).

The deterministic E2E test from item 2 proves the *file* contract (curated files exist at the right paths). Whether each stage's agent *actually only reads* those files is a behavioral property, not a file property. Item 5's read-trace is the qualitative artifact you asked for; it's not a formal proof.
