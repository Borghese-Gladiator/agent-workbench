# Review

## Decision

**approve** with three minor findings (none blocking).

The implementation matches the Y-scope plan. Change 1 is a focused, correct narrowing of the terminal-state filter in `_walk_worktrees`. Change 2 mirrors the existing `tools/backfill_completion_refs.py` precedent cleanly. Live `list`/`board` agreement is verified end-to-end. The minor findings below catch edge cases worth folding into follow-ups but do not block the merge.

## Did the implementation satisfy the brief?

**Yes, at the re-scoped Y level.** The brief was originally written for Scope Z (forward fix in `cmd_complete` + doctor check + module docstrings) but was explicitly re-scoped to Y by the user mid-planning (recorded in brief.md's `## Scope reduction` block and plan.md's `## Definition of done`). Against the Y contract:

- ✅ `list` and `board` AGREE on every run (manually verified post-`--write`; the 5 `human_review` runs match between the two enumerators).
- ✅ For runs whose original worktree is still alive (`generalize-stage-context-md`, `board-freshness-across-worktrees`), the read-layer carve-out flips `board` to `done` immediately — they're no longer in `human_review` from either enumerator's perspective. Verified.
- ✅ Four target master-side `metadata.yaml` files rewritten on disk with `status: done`, `completion.{accepted_by, completion_ref, completed_at}` populated. Verified by `grep "^status:"` and by re-running the script (idempotent: 0 would-apply).
- ✅ Dry-run is the script's default; `--write` required to actually rewrite. Verified.
- ✅ Plan.md's `## Deferred to follow-ups` section is populated with Z + three adjacent items.

**Partial caveat (ASM-004 in plan):** For the two runs whose worktrees were already cleaned up (`each-worktree-owns-its-own-run-dir`, `lifecycle-papercuts-lock-ready-banner`), master's CLI still shows `human_review` because the disk rewrite is staged on the worktree's branch and hasn't merged onto master yet. They WILL flip to `done` after this run's `/complete`. The plan and brief both acknowledge this — it's "agreement on the wrong answer today, agreement on the right answer post-merge." Not a regression from Y's stated scope.

## Did it accidentally expand scope?

**No.** The diff is contained to:
- `lib/runs.py` (28 LOC added, 0 removed)
- `tools/reconcile_master_metadata_after_cmd_complete.py` (new file, ~280 LOC including docstring)
- `tests/test_runs.py` (+79 LOC for the 3 new tests)
- `tests/test_reconcile_master_metadata.py` (new file, ~170 LOC)
- 4 reconciled `metadata.yaml` data updates (12 LOC each)
- Run artifacts (brief.md, plan.md, build.md, build-context.md, raw-idea.md, events.jsonl, metadata.yaml, stop-banner.txt)

No changes to `cmd_complete.py`, `cmd_doctor.py`, schemas, lifecycle docs, or `AGENTS.md`. Z-scope is deferred per plan. Other workbench modules untouched. The depth-2 blast-radius noise (depth-2 caller tree picks up `setUp`/`tearDown`/`main`/`run`/`_git` identifier collisions across the monorepo) is false-positive — those are common Python names, not true callers of the changes.

## Are there fragile assumptions?

**Two worth calling out** (both already documented in plan.md as ASMs, restated here for the reviewer):

**ASM-003 — file-path discovery returns exactly one match for each of the 4 runs.** This was confirmed by manual `git log --merges --first-parent` against each before implementation (Preflight in plan.md). For future runs added to `KNOWN_STALE_RUNS`, the same check needs to be run; the script's fallback (anchored message-grep) + manual `--merge-sha` override handle the edge cases, but the script defaults to "discover automatically" and a silent miss would result in `WARN no-merge-found` and a skipped run rather than a wrong rewrite. That's correct, but the operator has to actually read the warning output. F-001 below.

**ASM-006 — the script's `KNOWN_STALE_RUNS` constant.** Hardcoding the four observed run IDs makes the script narrow and auditable, but if any more runs accumulate before Z lands, they need to be added to the constant or invoked one-at-a-time via `--run-id`. There's no mechanism to detect "new stale runs since the script shipped." Z's doctor check would surface them, but Z isn't part of this run. F-002 below.

**Not a fragile assumption — DR-006 (file-path graph topology).** The query `git log --merges --first-parent ... -- runs/<id>/metadata.yaml` is genuinely robust to commit-message customization and branch-name composition drift. The structural invariant it depends on (`_do_merge()` always commits the run dir) is in `cmd_complete.py:223-236` and is unlikely to change without an obvious reason; if it ever does, the fallback chain catches the residual.

## Are there missing tests?

**One gap worth knowing about** (F-003 below): the new `_master_side_status` helper has no direct unit test. It's exercised through `_walk_worktrees`'s three carve-out tests (which exercise all three return paths: status string, status from missing file, status from unparseable yaml indirectly), but a direct test would harden against future refactors that change the indirect-call paths. Not blocking — the indirect coverage is real.

**Not a gap:** the script's tests cover dry-run, write, idempotency, already-terminal, and merge-SHA override (5 cases). The unmerged-branch case (A7 in the brief: "never modifies an unmerged-branch run") is implicitly covered by the dry-run test setUp+assertion shape — the test's branch IS merged, and if the merge-SHA discovery query had returned zero matches, the script would have skipped with `WARN no-merge-found` (its only behavior on zero matches). An explicit "unmerged branch" test would be belt-and-suspenders; the brief's A7 is satisfied by code-reading (the script will not call `_committer_date` or rewrite metadata without a discovered/overridden SHA).

## Are there security / data loss / migration risks?

**Minimal.** The script writes only to `runs/<id>/metadata.yaml` files for the four hardcoded run IDs. It does not auto-commit (matches `backfill_completion_refs.py` precedent). The user inspects the diff before committing manually. The only mutable global state it touches is YAML metadata for already-merged historical runs — no live in-flight run state is affected.

The `_master_side_status` helper in `lib/runs.py` reads a YAML file on every `_walk_worktrees` call that hits a terminal-state worktree run. Worst case (a workbench with N stale-master runs whose worktrees are still alive): N extra `os.stat` + YAML parse calls per board snapshot. This is bounded and small (the population is the intersection of "completed runs" and "worktrees still alive"). The board's existing `_METADATA_CACHE` keyed on `(path, mtime_ns)` is NOT reused by the new helper — F-004 below if that becomes a concern, but at current workbench sizes it's not.

No SQL, no shell injection, no network. The git invocations use `subprocess.run` with explicit arg lists (no shell), and the script's user-facing inputs are all argparse-parsed strings used as command args, not as raw shell input.

## What should the human review first?

1. **The 4 modified `runs/<run-id>/metadata.yaml` files** — spot-check that the `completion_ref` SHAs match what `git log` shows for each. The SHAs in the diff:
   - `2026-05-25-generalize-stage-context-md` → `c075b0c44c5a5509e0313282ce953d22292ee164`
   - `2026-05-26-board-freshness-across-worktrees` → `36d4b39cddae79162beed45278582634f3b57ed6`
   - `2026-05-25-each-worktree-owns-its-own-run-dir` → `8b78deec1e781cfba54992f75985654c4a158bc6`
   - `2026-05-25-lifecycle-papercuts-lock-ready-banner` → `470632c87acc58ccd74b4692d0826aee3ed4ce94`

   Each can be verified with `git show --stat <sha>` — they should be `Merge branch 'agent/...'` commits.

2. **`lib/runs.py` carve-out** (the new conditional in `_walk_worktrees`, lines 297-309). The structural question: is it correct that we treat "master missing" and "master agrees" identically (both skip the worktree hit)? Today the answer is yes (both represent "the worktree hit is just merged-history-checked-out-here, not live work"), but the conditional could also be written as `if master_status is None: continue; if master_status == run.status: continue; …`. The current short-circuit is concise; either shape is fine.

3. **`tools/reconcile_master_metadata_after_cmd_complete.py`** — the merge-SHA discovery in `_find_merge_sha` (DR-006). Verify the file-path query's path argument construction (`workbench_subpath / "runs" / run_id / "metadata.yaml"`) matches what's actually committed to master for these runs.

4. **`tests/test_reconcile_master_metadata.py`** — the synthetic git-history setUp is the most unusual test fixture in this run. Worth a once-over to ensure the fixture's merge commit shape actually matches what `cmd_complete` produces on the real workbench (it does — `git merge --no-ff` with the default message format).

## Blast radius

Depth-1 (changed files): 9 source/data files + 8 run-artifact files. All expected from the diff.

Depth-2 (callers of changed symbols): **the `_master_side_status` callers list is empty in practice** — only references in plan.md and build-context.md, which are documentation (not callers). The helper is private to `lib/runs.py`'s `_walk_worktrees`. The depth-2 entries for `_try_build_run` (referenced from `docs/LOG.md`) are a historical doc reference, not a code coupling.

The depth-2 entries for `setUp`, `tearDown`, `main`, `run`, `_git`, `_run_script` are false positives — these are common Python identifier collisions across the monorepo's test files and tooling, not actual callers of code changed in this run. The blast-radius generator's identifier-based dependency tracking can't distinguish "function `foo` in this file" from "function `foo` in some other file with the same name." Not actionable.

**No depth-2/3 file lives outside the brief's expected scope.** No scope-creep concern. The two true semantic depth-2 links (`_master_side_status`, `_try_build_run`) point to documentation references, not unexpected call sites.

## Findings

### F-001

- **Severity**: minor
- **Where**: `tools/reconcile_master_metadata_after_cmd_complete.py:_find_merge_sha`
- **Issue**: When the file-path query returns zero matches AND the message-grep fallback also returns zero, the script emits `WARN no-merge-found` and skips the run — but the user has to actually read stderr to notice. The script's exit code is 1 in that case (because `counts["warn"] > 0`), but a casual operator who runs `--write` and sees "applied: 3, warned: 1" might miss which run was warned about if multiple runs are processed. Mitigation: each warning includes the run_id, so it's there if you look.
- **Suggested fix**: For Z's doctor check, ensure the same WARN format is used so operators learn the convention. Not changing this run.

### F-002

- **Severity**: minor
- **Where**: `tools/reconcile_master_metadata_after_cmd_complete.py:KNOWN_STALE_RUNS`
- **Issue**: Hardcoded list of 4 run IDs. Any new stale runs that accumulate between now and when Z lands (the forward fix in `cmd_complete`) won't be auto-discovered. ASM-006 acknowledges this; the user can run `--run-id <id>` per-run as a workaround. Z's doctor check is the real fix for "find all stale-master runs" but Z is deferred. Worth surfacing in follow-ups.
- **Suggested fix**: Add a `--scan-all` mode in Z (or as a small follow-up before Z) that walks `runs/<id>/metadata.yaml` on master and finds any non-terminal run whose branch is merged. Already covered by the Z follow-up entry in plan.md's `## Deferred to follow-ups`.

### F-003

- **Severity**: minor
- **Where**: `lib/runs.py:_master_side_status` (no direct unit test)
- **Issue**: The helper is exercised indirectly by the 3 new `TestWalkWorktreesStaleMasterCarveOut` tests, but a direct test would harden it against future refactors that bypass `_walk_worktrees`. The three indirect paths covered: (a) status returned correctly when YAML loads, (b) `None` returned when file missing, (c) implicitly: untested directly, but if `yaml_io.loads` raised, the helper returns `None` (covered structurally, not by an explicit test case).
- **Suggested fix**: One small additional test in `test_runs.py` that exercises `_master_side_status` directly with a malformed YAML fixture and asserts `None`. ~5 LOC. Not blocking — the indirect coverage is real and the cases are simple enough that visual review of the helper is comparable assurance.

### F-004

- **Severity**: minor
- **Where**: `lib/runs.py:_master_side_status` (cache miss on hot path)
- **Issue**: The helper reads `cfg.runs_path / run_id / "metadata.yaml"` on every `_walk_worktrees` call that hits a terminal-state worktree run. The existing `_METADATA_CACHE` keyed on `(path, mtime_ns)` is NOT reused. At current workbench sizes (~30 runs total, ~5 with live worktrees in terminal state at any given time), this is fine — order of N extra YAML parses per `iter_all_runs` call, where N is small. If the workbench ever grows to hundreds of stale-but-live-worktree runs, this becomes a per-board-snapshot cost.
- **Suggested fix**: Reuse `_METADATA_CACHE` (or factor a similar helper). Roughly 5 LOC. Not changing now — current size doesn't justify it.

## Documentation claims

(Section appended by the CLI's documentation-claims check at `validate` finalize, if any claims in `build.md`'s `## Documentation touched` section don't match the actual diff.)

## Documentation claims

Validating compared `build.md`'s **Documentation touched** section against `git diff` in the worktree. The following claimed paths were NOT changed in the diff:

- ``runs/2026-05-27-reconcile-master-metadata-after-cmd-complete/stages/2_shaping/brief.md``
- ``runs/2026-05-27-reconcile-master-metadata-after-cmd-complete/stages/3_planning/plan.md``
- `No`

Either the claim is wrong, the change is unstaged, or the base ref is misconfigured. Reviewer: confirm or push back.
