# Review

## Decision

approve

## Did the implementation satisfy the brief?

The brief (pass-1, unchanged) is met. The change-request (Bounce 1) added four code/test items and one verification deliverable; all five landed:

- **Item 1** (staged-layout E2E assertion): deterministic block in `test_e2e.py::TestE2EHappyPath::test_happy_path` after `/start`. File-exists check + 5 substring checks for load-bearing headings. No agent reasoning.
- **Item 2** (cross-stage contract): deterministic block in the same test after `/validate --init`. Asserts both `build-context.md` AND `validate-context.md` exist in their respective stage dirs.
- **Item 3** (TODO §3 item 2a, `base_ref_sha` plumbing): `validate_context.build` + `build_blast_radius` now accept `base_ref_sha`; `_effective_ref` helper mirrors `lib/metrics/lines.py`; `cmd_validate._write_validate_context_artifacts` threads the SHA. **Plus an extension beyond the strict change-request:** the diff and blast-radius renderers now also include uncommitted (staged + unstaged) and untracked changes, not just committed. Pass-1's empty `## Final diff` was caused by *both* the symbolic-`HEAD` issue (§3 item 2a) AND the fact that validation typically runs before commit; landing only the §3 fix would have left half the bug in place.
- **Item 4** (meta-reload assumption verification): confirmed via `lib/metadata.py:255-262` that `update()` reloads its own copy and does not mutate the caller's dict. Reload in `_write_build_context_artifacts` is load-bearing; comment rewritten to name the staleness reason.
- **Item 5** (read-trace): captured in `build.md`'s `## Read trace (item 5)` section with an honest "I cannot prove the negative" caveat.

The rebuild's own `validate-context.md` (regenerated via direct helper invocation against the same `cmd_validate._write_validate_context_artifacts` path) is now non-degraded: the `## Final diff` and `blast-radius.txt` list real files, including the 5 source modifications from this rebuild.

## Did it accidentally expand scope?

Yes, deliberately, with the human's prior approval implied by the question "Why would this ever not be present?":

- **Uncommitted + untracked diff coverage** is an extension beyond the strict TODO §3 item 2a wording. The change-request asked for `base_ref_sha` plumbing; that alone wouldn't have populated this run's own `validate-context.md` because the changes are uncommitted. The extension is in the same file, in the same direction (less-degraded curated context), and adds 2 unit tests. Recorded in `build.md` § Deviations from plan.
- **§3 items 2b, 2c, 2d** (board/source.py, doc_claims.py, backfill tool, BaseRefResolved event) were *not* pulled into scope. Only item 2a + the uncommitted extension. The change-request was specific about 2a; the rest stays TODO.

## Are there fragile assumptions?

- **Uncommitted diff includes `git ls-files --others --exclude-standard` for untracked.** Honors `.gitignore`. A file ignored by `.gitignore` won't appear in the curated context. Acceptable for the workbench's purposes (the curated context is about source changes; build artifacts and noise stay out). Anyone overriding `.gitignore` for an intentional reason should be aware.
- **The 500-line diff cap applies separately to committed and uncommitted blocks.** If both exceed the cap, the curated file will say so twice. Could combine into one budget, but the separation is informative (a reader can see "committed is fine, uncommitted is huge → builder hasn't committed yet, sit-rep is in build.md").
- **Blast radius's per-file symbol extraction now falls back to reading untracked files directly.** If a file is huge and untracked, this reads the whole file into memory. The cap on `_BLAST_RADIUS_FILE_CAP` (500 files) limits total iteration; per-file size is unbounded. Acceptable for normal source files; a >100KB untracked file would degrade. Worth a follow-up if anyone hits it.
- **`_effective_ref` is duplicated from `lib/metrics/lines.py`.** Same DR-003 reasoning as before — the two callers may diverge as other §3 consumers land. Mark for future consolidation.
- **The meta-reload comment now names the reason but doesn't link to `lib/metadata.py`.** If `metadata.update`'s implementation ever changes to mutate-in-place, the comment becomes wrong. Trade-off: a richer comment (pinning to a specific commit or test) would be over-engineered for a 5-line note.

## Are there missing tests?

Two known gaps, neither blocking:

- **No deterministic test for `_render_diff` when both committed AND uncommitted exist.** The unit tests cover each in isolation. A combined-case test would be one more case; low value (the function is `committed | uncommitted | untracked` independent rendering).
- **No deterministic test for the `validate-context.md` content via the cmd_start helper integration path.** The cross-stage E2E asserts file existence but not "the rebuild's regenerated validate-context.md has the uncommitted block." Adding a string-presence assertion in `test_happy_path` after `/validate --init` would close the gap (the test would assert `"Uncommitted"` substring is present when the fixture worktree has staged-but-uncommitted edits). Recorded as a follow-up.

## Are there security / data loss / migration risks?

- **No security risk.** New code reads files via `git ls-files` and `git diff`. No new write paths, no new network, no new subprocess shape.
- **No data loss risk.** Builder + write helpers are unchanged in their write-targets; only the *content* of the rendered markdown changed (now also includes uncommitted/untracked).
- **No migration risk.** Existing tests passed before and after. Existing `validate-context.md` files in archived runs are not regenerated; they stay as-is.
- **One observability concern.** A `validate-context.md` for a run with substantial uncommitted work now includes the full uncommitted diff if it fits the 500-line cap. If the worktree contains a file with credentials accidentally staged, that secret would appear in the curated file. Same concern existed for committed changes; not a regression.

## What should the human review first?

1. **`lib/validate_context.py`** end-to-end — this is the largest change. Two new helpers, two extended functions. Specifically:
   - `_effective_ref` (new): confirm it matches `lib/metrics/lines.py:_effective_ref`'s shape.
   - `_render_diff` (extended): confirm committed + uncommitted blocks render under sensible headings; confirm `(no files changed yet)` no longer appears when there's uncommitted work.
   - `_render_name_status` (extended): confirm Committed / Uncommitted / Untracked subsections render conditionally; confirm a worktree with nothing changed at all still produces `(no files changed yet)`.
   - `build_blast_radius`: confirm the per-file diff loop falls back to uncommitted then untracked-as-direct-read; confirm `_BLAST_RADIUS_FILE_CAP` still applies to the union set.
2. **`tests/test_validate_context_build.py`** — 5 new cases: `test_diff_section_with_symbolic_head_and_sha`, `test_diff_section_with_symbolic_head_no_sha_falls_back`, `test_uncommitted_changes_appear_in_files_changed`, `test_untracked_files_appear_in_files_changed`, `test_blast_radius_with_symbolic_head_and_sha`. Each is small and self-contained.
3. **`tests/test_e2e.py`** — the two deterministic assertion blocks added to `test_happy_path`. Confirm there's no agent reasoning involved (just `assertTrue(path.exists())` + substring `assertIn`).
4. **`lib/cli/cmd_start.py:131-138`** — the rewritten meta-reload comment. Confirm it names *why* the reload is load-bearing.
5. **`runs/2026-05-25-generalize-stage-context-md/stages/5_validating/validate-context.md`** (live file, regenerated in the rebuild) — confirm `## Final diff` and `## Files changed` are non-degraded; this is the qualitative confirmation the human asked for.

## Blast radius

`blast-radius.txt` is now non-empty in the rebuild's regenerated form. Real depth-1 files reported:

```
agentic-development-task-system-v3__ai/agent-workbench-live/AGENTS.md
agentic-development-task-system-v3__ai/agent-workbench-live/lib/build_context.py
agentic-development-task-system-v3__ai/agent-workbench-live/lib/cli/cmd_start.py
agentic-development-task-system-v3__ai/agent-workbench-live/lib/cli/cmd_validate.py
agentic-development-task-system-v3__ai/agent-workbench-live/lib/validate_context.py
agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-25-generalize-stage-context-md/...
```

Depth 2 / 3 not investigated for this review pass — the changed files are all inside `lib/` and `tests/` with no cross-package consumers outside what the pass-1 review already covered (`cmd_start.run` → CLI dispatcher; `validate_context.build` → only `cmd_validate._write_validate_context_artifacts`; the new `_effective_ref` is private to the module).

**Scope-creep check:** All depth-1 files are inside `agent-workbench-live/` plus `docs/lifecycle.md` from pass-1 (no further doc changes this rebuild). All match the brief's expected scope + the change-request's explicit additions.

## Findings

### F-001 (carried from pass-1, still minor)
- **Severity**: minor
- **Where**: `lib/build_context.py:_worktree_block`
- **Issue**: `(not set)` fallback for missing metadata fields is silent (carried from pass-1; not addressed by the bounce).
- **Suggested fix**: Stays in follow-ups; not in the change-request.

### F-002 (carried from pass-1, still minor)
- **Severity**: minor
- **Where**: rendered `build-context.md`
- **Issue**: Inlined template skeleton creates visual heading hierarchy noise (carried from pass-1; not addressed).
- **Suggested fix**: Stays in follow-ups; not in the change-request.

### F-003 (pass-1 finding, **closed** by this rebuild)
- **Severity**: minor (was; now closed)
- **Where**: `lib/validate_context.py` (was); fix landed
- **Issue**: Empty `## Final diff` and `blast-radius.txt` due to symbolic `HEAD` + uncommitted state.
- **Status**: **closed.** The §3 item 2a plumbing + the uncommitted/untracked extension address both root causes. Verified live on this run's regenerated `validate-context.md`.

### F-004 (new in rebuild, informational)
- **Severity**: minor (informational; no action needed)
- **Where**: rebuild build.md § Read trace
- **Issue**: There's no `build-context.md` generated for the rebuild pass itself, because `human_review → building` (the bounce) doesn't route through `cmd_start.run`. The rebuild agent's curated entry was `change-request.md` instead — which is the right curated file for a bounce-driven rebuild, but is not produced by the same code path.
- **Suggested fix**: A future TODO §1 expansion could generate a `change-context.md` (or regenerate `build-context.md` at bounce time) so the curated-entry pattern is consistent across both fresh starts and bounce rebuilds. Out of scope for this run; surface in follow-ups.
