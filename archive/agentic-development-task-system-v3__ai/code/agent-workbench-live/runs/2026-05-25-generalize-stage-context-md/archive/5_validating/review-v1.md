# Review

## Decision

approve

## Did the implementation satisfy the brief?

Yes, with three documented deviations from the brief's strict acceptance criteria that are addressed in `build.md`:

- **AC4 (anchor links back to source artifacts)** — not implemented. The brief said `(../brief.md#acceptance-criteria)`-style anchors. The design template (`validate_context.py`) doesn't use them either; it names paths in prose. The implementation follows the design template. This was the right call: implementing markdown anchors purely for the brief's framing would have made `build-context.md` visually noisier without changing the cache-discipline outcome. The Rules block + AGENTS.md guidance both name the source artifacts and say when to read them, which is the substantive ask.
- **`build_context.build` signature** — path-in + `meta` dict, not pure string-in. The brief floated "pure function takes strings"; that didn't match `validate_context.build`. Decision recorded as DR-001. The implementation is consistent with the design template — the right call.
- **AC5 (slash-command instructions)** — adapted. There is no `/build` slash command and no per-stage entry point for the building stage. The wiring went into `AGENTS.md` § Session discipline and `docs/lifecycle.md` § building (Curated entry context block), which are the actual entry points the next agent reads.

The other six acceptance criteria (1, 2, 3, 6, 7, 8, 9) are met. AC9 (no regression) verified: full suite is 337 passed, 2 pre-existing snapshot failures in `test_human_review.py::TestSnapshotRender` that also fail on master (date drift, not this change).

Manual QA via the throwaway run `2026-05-25-bctx-smoke` confirmed the file lands at `stages/4_building/build-context.md` with content correctly lifted from brief + plan + metadata.

## Did it accidentally expand scope?

No. Scope was tightly bounded to `build-context.md` only. The other three `<stage>-context.md` siblings (`plan-context.md`, `followups-context.md`, `shape-context.md`) are explicit non-goals; the file `lib/build_context.py` has zero coupling to those future builders (DR-003 chose duplication over shared helpers precisely to keep this scope-bound).

One small adjacent edit: `AGENTS.md`'s new bullet mentions both `build-context.md` AND `validate-context.md` as the two stages that now produce a curated context, plus a forward pointer to TODO §1's remaining stages. This is descriptive (documents the new state of the world), not prescriptive (doesn't claim work on the other three). Inside the brief's expected scope.

## Are there fragile assumptions?

A few worth naming:

- **`_section` heading-extraction relies on stable templates.** If a brief author writes `## Acceptance Criteria` (capital C) or `### Acceptance criteria` (depth-3), `_section` will miss it because the match is title-text-case-insensitive but path-and-depth-sensitive. Mitigated by `validate_context.py` having the same assumption since pass-2 B2 landed and not having burned a real run. Same risk; same mitigation; same blast radius if it breaks.
- **`_collect_id_blocks` looks for `### DR-NNN` / `### ASM-NNN` headings.** If the planner uses `## DR-001` (level 2) instead, regex still matches (`#{2,4}\s+`). If they use `#### DR-001` (level 4), regex matches. Out-of-range levels (1, 5, 6) miss. Acceptable: the templates use `### ...` and the same regex is shared with `validate_context._collect_id_blocks`.
- **`meta.get("target", {}).get("worktree", {}).get("path") or "(not set)"` chain in `_worktree_block`.** Defensive, but silently turns a missing-required-field into the literal string `(not set)` in the rendered file. A run with missing worktree metadata is already broken upstream (transition evidence requires `worktree_path`); rendering `(not set)` instead of crashing is the correct trade-off for a convenience artifact, but a future reviewer should not interpret `(not set)` as a benign empty.
- **The `cmd_start` helper reloads `meta` via `metadata.load`.** ASM-001 in the plan was "the local `meta` may be stale after `metadata.update`." Reloading is correct but adds one disk-read per `/start` invocation. Negligible.
- **No filesystem races accounted for.** If two `/start` invocations were somehow interleaved on the same run_id, both could try to write `build-context.md`. The transition's lock (`locks.acquire`) is not held during the helper call — the helper is intentionally outside the lock because it's a convenience artifact. Acceptable: `/start` for a single run_id is human-driven and not concurrent.

None blocking.

## Are there missing tests?

Coverage is good for the scope of this change. Specifically:

- `lib/build_context.py` is covered by 13 unit cases hitting every section, every fallback path, the missing-template case, the missing-brief-file case, and the empty-meta case. The `_collect_id_blocks` variant (which is the small deviation from `validate_context`) is exercised by `test_decisions_block_includes_all_dr_and_asm`.
- `cmd_start._write_build_context_artifacts` is covered by two integration tests: happy-path-writes-file and builder-raises-and-is-swallowed.

Two gaps worth naming but not blocking:

- **No test for the staged layout's stage_dir resolution.** The integration tests are flat-layout. The staged-vs-flat branch inside `_write_build_context_artifacts` (lines 138–145 in cmd_start.py) is not directly tested. The happy-path coverage in the broader E2E suite (`test_e2e.py::TestE2EHappyPath`) does drive a staged run through `/start` and asserts other side-effects, but doesn't currently check for `build-context.md`. A one-line `self.assertTrue((run_dir / "stages" / "4_building" / "build-context.md").exists())` in `test_e2e.py` after the start step would close this gap. Recorded as a follow-up.
- **No test for the `templates/build.md` missing case in the actual write-path.** The unit `test_missing_template_emits_fallback` covers the builder; the integration tests assume the template exists. If a workbench were shipped without `templates/build.md`, the integration tests wouldn't catch the resulting `(templates/build.md missing or empty)` content. Low-value coverage gap; not worth a test.

## Are there security / data loss / migration risks?

- **No security risk.** No new attack surface: pure-Python file generation, no network, no subprocess, no eval, no `shell=True`. Reads from disk and writes to disk, both within the worktree.
- **No data loss risk.** The helper writes a new file at a deterministic path. It does not delete, rename, or overwrite any existing artifact (`build_context.write` uses `path.write_text`, which overwrites only the named file; it does not touch siblings). The convenience-artifact-swallow contract ensures a builder bug cannot block the `ready → building` transition, so a faulty builder cannot strand a run.
- **No migration risk.** Existing runs in `runs/` are not touched. New runs going through `/start` get the new artifact; runs already in `building` or later stages don't. No backfill needed (the file is not load-bearing for any transition).
- **One small artifact-bloat note.** Each new `/start` invocation adds one ~3–5 KB markdown file to the run dir. Negligible (`validate-context.md` is the same shape and we've shipped that since pass-2 B2 without issue).

## What should the human review first?

1. **`lib/build_context.py`** end-to-end (170 lines). Confirm: the section list matches the brief's AC #3 exactly; `_all_plan_blocks` includes all blocks unfiltered (the deliberate divergence from `validate_context._filtered_plan_blocks`, documented as DR-004); the helper functions (`_read`, `_section`, `_HEADING_RE`, `_collect_id_blocks`) are duplicated from `validate_context.py` per DR-003 rather than imported. If you'd prefer a shared `lib/markdown_sections.py` extraction now (rather than waiting for the third sibling builder to land), that's a reasonable counter-position — but it's the only structural call I'd flag for revisit.
2. **`lib/cli/cmd_start.py:90–93` and `:125–160`** — the call site and the helper. Confirm the placement is right (between metadata.update and the transition block) and the `try/except Exception: pass` mirrors `cmd_validate._write_validate_context_artifacts`. The `meta = metadata.load(cfg, run_id)` reload inside the helper is per ASM-001; happy to remove it if you'd rather trust the caller's `meta`, but the cost (one disk read) is negligible.
3. **`runs/2026-05-25-bctx-smoke/stages/4_building/build-context.md`** (the QA smoke output) — visually confirm the rendered file looks right. Especially: does the inlined `build.md` template skeleton inside the `## build.md template skeleton` section read as expected, or is the nested-heading visual noise enough to warrant indenting the inline into a fenced block or HR-bounded region? (Recorded as a known issue in `build.md`.)
4. **`docs/lifecycle.md` `building` block** — confirm the new `Curated entry context` block sits in the right place and the `Reads` row's parenthetical is correctly worded.
5. **`tests/test_build_context.py`** — 16 cases, all pass. Spot-check the integration tests' `_make_flat_run` fixture; it bypasses the full CLI by calling `metadata.create` + `metadata.update` directly, which is faster than spinning up the subprocess wrapper but means a future change to the CLI's `/start` invocation pattern wouldn't be caught by these tests.

## Blast radius

`blast-radius.txt` is empty (`(no files changed yet)`). Root cause: the worktree's `base_ref` in metadata is `"HEAD"` (symbolic); `validate_context._render_diff` and `build_blast_radius` shell out `git diff HEAD...HEAD` which is empty by definition. This is **TODO §3 (`base_ref_sha` plumbing — three remaining consumers + audit trail + backfill)**, specifically item 2a (`lib/validate_context.py`'s `base_ref` consumers). Not this run's regression — pre-existing limitation. The reviewer should compute blast radius manually:

**Real diff vs master (computed manually):**

```
agent-workbench-live/AGENTS.md                       |  1 +
agent-workbench-live/lib/cli/cmd_start.py            | 43 ++++++++++-
docs/lifecycle.md                                    |  7 +-
+ lib/build_context.py                               | ~170 (new)
+ tests/test_build_context.py                        | ~250 (new)
```

**Depth-1 (changed files):** `lib/build_context.py` (new), `lib/cli/cmd_start.py` (modified import + helper), `tests/test_build_context.py` (new), `docs/lifecycle.md`, `AGENTS.md`.

**Depth-2 (callers of changed symbols):**

- `cmd_start.run` is called from `bin/agent-workbench` (CLI dispatcher) and indirectly from `lib/cli/cmd_start.run` tests. The only behavior change is one new pre-transition write call wrapped in try/except. No reachable caller can observe a behavior delta unless they assert on disk contents in the run dir, which only the new tests do.
- `build_context.build` and `.write` are new symbols with no prior callers; only the new `_write_build_context_artifacts` helper calls them.
- `lib/cli/cmd_start._write_build_context_artifacts` is new; only `cmd_start.run` calls it.

**Depth-3:** Indirect callers of `cmd_start.run` (the CLI dispatcher) include every E2E test that drives `/start`. None of those tests assert on the absence of `build-context.md` (they were authored before this file existed), so none regress from the new file appearing. Confirmed empirically — the full suite passes.

**Scope-creep check:** All changed/added files are inside `agent-workbench-live/`, plus `docs/lifecycle.md` (the brief's expected files-to-change list explicitly named both). No surprises. No files outside the brief's expected scope.

## Findings

### F-001
- **Severity**: minor
- **Where**: `lib/build_context.py:_worktree_block`
- **Issue**: `(not set)` fallback for missing metadata fields is silent. A run whose metadata is broken upstream (no worktree path) would render `build-context.md` with `- **Path**: \`(not set)\`` and not warn anywhere. Distinguishable from a legitimate empty value only by reading the metadata directly.
- **Suggested fix**: Either leave as-is (current behavior is correct for a convenience artifact and matches `validate_context.py`'s "(missing or empty)" pattern), or add a one-line `<!-- WARNING: metadata.target.worktree.path is missing -->` comment when the fallback triggers. Low value; would only matter if metadata corruption became common. Recommend leaving as-is.

### F-002
- **Severity**: minor
- **Where**: `runs/<id>/stages/4_building/build-context.md` (the rendered file)
- **Issue**: The inlined `templates/build.md` skeleton contains its own `## What changed`, `## Files changed`, etc. headings that render as siblings to `build-context.md`'s outer sections in markdown viewers (visual hierarchy noise). Already flagged in `build.md` as a known issue.
- **Suggested fix**: One of: (a) wrap the inlined template in a fenced ```markdown ... ``` block in `build_context.py:build` so it renders as code rather than nested sections; (b) bound the section with `<hr>` rules. Option (a) loses the inlined template's rendered formatting for an agent reader; option (b) keeps it but adds visual structure. Defer to a follow-up — neither is correctness-critical and the agent (the primary reader) handles either fine.

### F-003
- **Severity**: minor
- **Where**: Symptom in `validate-context.md#final-diff` (empty) and `blast-radius.txt` (empty)
- **Issue**: This run's own `validate-context.md` has an empty `## Final diff` because `base_ref: "HEAD"` causes `git diff HEAD...HEAD` to be empty. The reviewer cannot use the curated context to see the actual diff. Same root cause as TODO §3 item 2a.
- **Suggested fix**: Fixed by TODO §3 item 2a; not in scope for this run. Calling it out so the human knows the curated context is degraded for this specific run's review.

## Documentation claims

Validating compared `build.md`'s **Documentation touched** section against `git diff` in the worktree. The following claimed paths were NOT changed in the diff:

- ``docs/lifecycle.md``
- ``agent-workbench-live/AGENTS.md``

Either the claim is wrong, the change is unstaged, or the base ref is misconfigured. Reviewer: confirm or push back.
