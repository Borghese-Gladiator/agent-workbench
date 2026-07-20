# Review

## Decision

approve

The two papercuts land cleanly and meet the brief's acceptance criteria. The plan's mid-stream catch of the brief's mis-pointer (`_SPECS["ready"]` → renderer f-string) was the right call and is recorded transparently in LOG.md so future briefs can learn the rule (acceptance criteria are load-bearing; implementation pointers are advisory).

## Did the implementation satisfy the brief?

Yes, on all seven acceptance criteria:

1. `/complete <id>` succeeds without `--no-merge`. *Not yet verified live* — this is what `/complete` of THIS run will demonstrate (ASM-004). The unit test `test_run_lock_file_is_gitignored` pins the gitignore behavior directly, and `git check-ignore -v` on the live `.lock` returns the new pattern at `.gitignore:318`. The live evidence comes at merge time.
2. `.lock` not in `git status --porcelain`. Verified via QA smoke 2 (`git check-ignore -v` output).
3. `lib/cli/_stop_banner.py` contains no `agent-workbench start` literal. Verified via grep (QA smoke 4) — empty result across all production code.
4. `tests/snapshots/stop_banner_ready.expected.txt` re-baselined. The snapshot file content is the new slash-form + em-dash; `TestSnapshots::test_ready_snapshot` passes.
5. Other states' snapshots unchanged. The renderer change only fires under the `elif spec.next_moves:` branch; `human_review` uses `_build_human_review_body` and `done`/`abandoned` use the terminal-line path. `test_human_review_banner_structure` and the three other state snapshots pass unmodified.
6. `tools/backfill_completion_refs.py` docstring updated. Added paragraph explaining the gitignore fix; existing per-run BACKFILL dict comments unchanged.
7. Full test suite green (modulo unrelated pre-existing failures — see "Are there missing tests?" below).

## Did it accidentally expand scope?

Almost: I considered cleaning up the brief.md, but it stays as-is. The brief's "Files likely to change" listed seven files; the implementation touched exactly those seven plus zero. Any urge to "while I'm here" fold in the `validate_context` empty-diff bug (TODO §2 papercut 2a, sibling territory) was correctly resisted — it's a different TODO section.

Two scope-relevant moves I want to flag:

- **Renderer change applies to all states using the `elif spec.next_moves:` branch.** Today that's just `ready`. If a future state is added with non-empty `next_moves`, it picks up the slash-form by default. That's arguably the right default (slash-form is the workbench's house style now), but it's a behavior change beyond `ready` strictly speaking. Acceptable because the brief's non-goal "Only `ready` is in scope" was about which *existing* state the bug appears in; future states should pick up the right rendering automatically rather than each one needing its own fix.
- **The new cross-state pin (`test_no_shell_form_in_any_banner`) is technically over the brief's scope** ("Don't audit every other stop banner"). But it's a *test*, not a code change to other states — it only fails if a future change reintroduces the shell-form. Defense in depth; cheap.

## Are there fragile assumptions?

- **ASM-003 (snapshot consumer verbatim).** Verified live during build — `_check_snapshot` uses `assertMultiLineEqual` with no normalization. Holds.
- **ASM-002 (v2 dormancy).** The defensive v2 gitignore line will silently work even if v2 reactivates with matching `.lock` semantics. If v2 chooses a different lock-file shape, the line is dead weight but not harmful. Low risk.
- **ASM-001 (no banner-text consumers outside tests/runs).** Grep shows only `README.md` and `.claude/commands/start.md` carry the old `agent-workbench start` shell form, but both are in documentation contexts (instructive examples for the human, not parsed contracts). The README example at line 124 still reads `agent-workbench start "$RUN_ID" --approved-by "$USER"` — that's documentation for the CLI's invocation, not a banner contract, and stays correct (the CLI command IS `agent-workbench start`). The slash-form change is purely cosmetic for the banner output. Not a regression risk.

One assumption I didn't catch during planning but worth flagging: **the workbench worktree was branched from an older base** than current master HEAD. Master gained two commits (`1d4e71f` adding TODO §9 board-perf, `a866914` updating slash-command docs to auto-chain) after `base_ref_sha=e657d14`. The merge at `/complete` time will pick up a real conflict on `docs/TODO.md` (both sides renumbered overlapping section ranges) — see "Things to check first" below.

## Are there missing tests?

The targeted suite (`test_stop_banner.py` + `test_repos.py`) is green at 31 passing. Two pre-existing failures in `tests/test_human_review.py::TestSnapshotRender` fire on any day other than 2026-05-22 because the `_normalize` helper at `test_human_review.py:460-470` collapses `<TMP>`, `<TEST_REPO>`, and `[<HH:MM:SS>]` but NOT the run-id date prefix. The comment at line 466-467 explicitly says this was an intentional choice ("deterministic from the run_id, so leave it alone") — that's true within a single day but not across days. Pre-existing and unrelated to TODO §2; recommend filing as a follow-up against TODO §4 (test-coverage gaps) since the gap is similar in shape (brittle test fixture, doesn't fail-loud-on-day-boundaries).

No other missing tests for the acceptance surface of this run.

## Are there security / data loss / migration risks?

None.

- The `.gitignore` pattern is narrow path-prefix; cannot accidentally exclude unrelated files.
- The renderer change has no I/O, no state mutation, just string formatting.
- The docstring change is documentation; no runtime effect.

## What should the human review first?

1. **The TODO.md renumbering vs. master drift.** Master gained `1d4e71f` (TODO §9 board perf) after this run's `base_ref_sha`. My branch renumbered §§3–9 → §§2–8 — but master now has §1–§9 with new content at §9. When `/complete` merges, expect a conflict in `docs/TODO.md`. Resolution shape: keep my deletion of old §2 + my renumbering, then add master's new §9 (board-perf) as the new §8, renumbering my §8 (subagent cost) to §9. Or vice versa — but the section-number-stability invariant the workbench depends on (cross-section refs like `§6 PR-flow`) means the resolution needs care to preserve cross-references.
2. **The `_stop_banner.py` renderer change.** Three lines became six. Confirm the f-string change is the smallest possible swap consistent with DR-002's full-symmetry goal, and that `_render_next_moves_slash_form` (the `human_review` helper) is now structurally duplicated for `ready`'s path. Possible future-cleanup: extract a shared helper, but the brief's non-goal "don't refactor while you're here" rules that out for this run.
3. **The brief's mis-pointer.** The brief said `_SPECS["ready"]`; the plan found the bug was in the renderer. LOG.md captures this generalizable rule: "the brief names acceptance; the plan names the file." Future briefs should not pre-commit to implementation locations.

## Blast radius

`blast-radius.txt` reads `(no files changed yet)`. That's a known bug in `lib/validate_context.py` (TODO §2 papercut 2a, sibling territory) where `base_ref="HEAD"` produces an empty diff at `git diff HEAD...HEAD`. The blast radius is well-bounded by inspection:

- **Depth 1 (direct callers of changed code):**
  - `lib/cli/_stop_banner.py`'s `print_stop_banner` is called by `cmd_validate.py`, `cmd_followups.py`, `cmd_start.py`, `cmd_complete.py`, `cmd_abandon.py` — all 5 agent-stopping transition sites.
  - The renderer `elif spec.next_moves:` branch only fires for `ready` today (the other three states either take `_build_human_review_body` or `terminal_line`).
- **Depth 2:** none — `print_stop_banner`'s only side-effect is `print(...)` to stdout. No callers depend on the output text as a parsed contract (verified via grep on `agent-workbench start`).
- **Depth 3:** none.

The `.gitignore` change has no Python-call blast radius — it's a build-tool config file consumed by `git`.

The `tools/backfill_completion_refs.py` docstring change has no behavioral blast radius — text-only.

No depth-2 or depth-3 files live outside the brief's anticipated scope. The brief's "Files likely to change" listed exactly the seven files touched (`.gitignore`, `_stop_banner.py`, `test_stop_banner.py`, `stop_banner_ready.expected.txt`, `backfill_completion_refs.py`, `TODO.md`, `LOG.md`). Plus `test_repos.py` for the gitignore unit test, which was an in-scope addition consistent with the brief's "Suggested QA scenarios" item 2.

## Findings

### F-001
- **Severity**: minor
- **Where**: `docs/TODO.md` (merge with master)
- **Issue**: Master gained TODO §9 (`1d4e71f`) after this run started. My deletion of old §2 + renumbering of §§3–9 → §§2–8 will conflict with master's new content at the old §9 slot. Not a blocker for `/complete` but a real conflict the human will resolve at merge time.
- **Suggested fix**: At merge time, accept my deletion of old §2 + renumbering, then renumber master's `1d4e71f` content into the resulting top of the section range (likely a new §9 since my range now ends at §8). Preserve cross-references — the `§6 PR-flow` references inside `§7` (tool-policy) must stay synchronized.

### F-002
- **Severity**: minor
- **Where**: `tests/test_human_review.py::TestSnapshotRender` (pre-existing)
- **Issue**: Two snapshot tests are failing on the date rollover. Not caused by this run; pre-existing brittleness in the `_normalize` helper at lines 460-470 that doesn't normalize the run-id date prefix. The comment explicitly chose to leave that part alone.
- **Suggested fix**: File as follow-up against TODO §4 (test-coverage gaps). The `_normalize` helper should also collapse the run-id date suffix (e.g. `(2026-)?\d{2}-\d{2}-(happy|bounce)-snap` → `<DATE>-$2-snap`), or the test class should pin `today()` to the baselined date via monkey-patch.

### F-003
- **Severity**: minor (cosmetic)
- **Where**: `lib/cli/_stop_banner.py` (renderer DRY)
- **Issue**: After this change, the renderer block for `elif spec.next_moves:` and `_render_next_moves_slash_form` (used by `human_review`) are nearly identical — same header text shape, same padding logic, same em-dash separator. Could be extracted into a single helper.
- **Suggested fix**: Out of scope per brief's "don't refactor while you're here" non-goal. File as a follow-up if the duplication grows (e.g. when another state with non-empty `next_moves` lands).
