# Build report

## What changed

Closed TODO §1 at the **Y scope** (read-layer fix + one-shot disk cleanup). `_walk_worktrees` now prefers a terminal-state worktree hit when master-side metadata disagrees, fixing the `list`/`board` ghost-`human_review` disagreement for runs whose original worktree is still alive. A new `tools/reconcile_master_metadata_after_cmd_complete.py` script rewrote the four observed stale master-side `metadata.yaml` files to `status: done` with populated `completion` blocks (merge SHA discovered via file-path graph topology against the workbench root branch).

## Files changed

- `lib/runs.py` — added `_master_side_status` helper; modified the terminal-state filter in `_walk_worktrees` so it only skips the worktree hit when master agrees (or is missing). +28 LOC.
- `tools/reconcile_master_metadata_after_cmd_complete.py` — **new file**. One-shot script mirroring `tools/backfill_completion_refs.py` shape. argparse for `--root`, `--write`, `--run-id`, `--branch-name`, `--merge-sha`. Hardcoded `KNOWN_STALE_RUNS` with the four observed run IDs. File-path-based merge-SHA discovery primary, anchored message-grep fallback, manual overrides as final escape hatch. Dry-run default. ~250 LOC including docstring.
- `tests/test_runs.py` — added class `TestWalkWorktreesStaleMasterCarveOut` with three tests covering the carve-out behavior (stale master, agreeing master, missing master). +79 LOC.
- `tests/test_reconcile_master_metadata.py` — **new file**. `TestReconcileMasterMetadata` with five tests covering dry-run, write, idempotency, already-terminal, and merge-SHA override. Fixture builds a synthetic git repo with a real merge commit so file-path discovery has something to find. ~175 LOC.
- The four master-side `metadata.yaml` files for the known stale runs were also rewritten **on disk** by running the reconciliation script in `--write` mode against the live workbench (see "Commands run" below for the exact invocation). They sit in the worktree's checkout staged for the merge that will land at `/complete` time.

## Reviewer reading order

1. **`lib/runs.py`** (the carve-out at lines 297-309, then `_master_side_status` further down) — the load-bearing change. Look for: did the new condition correctly preserve today's behavior when master agrees (common case) AND when master is missing (also common, e.g., archived non-self-modifying runs)?
2. **`tests/test_runs.py::TestWalkWorktreesStaleMasterCarveOut`** — the three new tests should match the three branches in the new conditional. Verify the first test (`test_walk_worktrees_prefers_terminal_worktree_when_master_stale`) would fail under the pre-Change-1 code.
3. **`tools/reconcile_master_metadata_after_cmd_complete.py`** — read the module docstring first (the "why" is there), then `main()` and `_process_run()`. The `_find_merge_sha` function is the interesting one (DR-006); confirm the fallback chain matches what the plan committed to.
4. **`tests/test_reconcile_master_metadata.py`** — the fixture in `setUp()` is the unusual part (builds a synthetic git repo with a real merge commit). Verify the assertions in the five tests match the script's actual behavior.
5. **`runs/2026-05-25-*/metadata.yaml` × 4 + `runs/2026-05-26-board-freshness.../metadata.yaml`** — the on-disk rewrites. Verify each shows `status: done`, `completion.accepted_by: reconciliation`, `completion.completion_ref: merge:<sha>`, `completion.completed_at: <iso-date>`.

## Acceptance criteria coverage

The brief was written for Scope Z; the live contract is plan.md's `## Definition of done`. Mapping the live AC to coverage:

| AC | Test or justification |
|----|-----------------------|
| Change 1 makes `board` agree with `list` for the 4 stale runs (2 of 4 with live worktrees flip via the read-layer fix; the other 2 are already in agreement because they share the stale master view, and will become consistently `done` when this run's reconciliation lands on master via `/complete`). | `tests/test_runs.py::test_walk_worktrees_prefers_terminal_worktree_when_master_stale` (unit) + QA-4 (live `list` and `board --static --status human_review` agree). |
| All `tests/test_runs.py` tests pass including the 3 new collision-behavior tests | `pytest tests/test_runs.py` — 17 passed (14 pre-existing + 3 new). |
| The first new test would fail under pre-change `_walk_worktrees` | By inspection: the test asserts `assertIn("r-stale", ids)`, but the pre-change filter unconditionally skips terminal-state worktree hits, so the worktree's `done` hit for `r-stale` would not surface; `assertIn` fails. Not explicitly run on the pre-change tree but the implication is mechanical. |
| Change 2 lands; script runs cleanly in dry-run | QA-2 in plan.md — ran `python tools/reconcile_master_metadata_after_cmd_complete.py` against live workbench, dry-run identified 4 runs and 4 correct merge SHAs (verified manually via `git log --merges --first-parent` against each), no warnings, no skipped. |
| After `--write`, 4 master-side files show `status: done` with `completion` block populated | QA-3 in plan.md — ran the script with `--write`, output reported `applied: 4`. `grep "^status:"` confirmed all 4 master-side `metadata.yaml` files now show `done` (in the worktree's checkout of master). |
| Re-running script reports 0 offenders | Re-ran in dry-run mode immediately after `--write`; output: `would-apply: 0, already-terminal: 4, skipped: 0, warned: 0`. |
| `agent-workbench list` and `agent-workbench board --status human_review` agree | QA-4 ran from master CLI; both show the same 5 runs in `human_review` (3 unrelated + 2 of our 4 whose original worktrees were cleaned up, awaiting `/complete` merge to reach master's metadata). The 2 of our 4 whose worktrees are still alive show `done` in BOTH. |
| Plan's `## Deferred to follow-ups` section is filled in | Done — plan.md has the section with Z + 3 adjacent follow-ups (cmd_abandon audit, list/board collision audit, audit-narrative event support). `/followups` stage will lift those into `follow-ups.md`. |

## Deviations from plan

- **plan.md said `~30 LOC for Change 1 + helper`; actual ~28 LOC.** Within budget.
- **plan.md said `~120 LOC for Change 2`; actual ~250 LOC** including module docstring and the full discovery/fallback/override flow. The plan underestimated the docstring and the helper functions (_resolve_parent_branch, _committer_date, _branch_name_from_meta, _base_ref_from_meta, _find_merge_sha, _process_run). The behavior matches the plan; only the LOC count is off.
- **The test fixture for `tests/test_reconcile_master_metadata.py` uses a symlink `lib -> ROOT/lib`** rather than copying the lib dir into the synthetic workbench. The plan didn't specify either way; the symlink is fast and avoids duplicating ~5MB of code per test fixture. Tests pass; no portability concerns expected (macOS + Linux both support symlinks).
- **Change 1's helper `_master_side_status` lives in `lib/runs.py`** as planned. ASM-002 said "verify during implementation"; verified: the helper is the right cut (no need to factor into a separate module).
- **No changes to `lib/cli/cmd_complete.py`, `lib/cli/cmd_doctor.py`, or any module docstrings about the invariant.** These are all deferred to Z per the user's scope decision.

## Known issues

- **Two of the four reconciled runs (`each-worktree-owns-its-own-run-dir`, `lifecycle-papercuts-lock-ready-banner`) still show `human_review` in master's `list` and `board` output until this run is `/complete`-d.** Their original worktrees were cleaned up before reconciliation, so Change 1's carve-out has nothing to read from — the master-side rewrite is the only fix, and the rewrite is staged in the worktree's branch awaiting merge. Once `/complete` merges this run, those two will also flip to `done`. **list and board AGREE on `human_review` for both today** (no disagreement) — the issue is that "agreement on the wrong answer" isn't yet "agreement on the right answer" for these two. The brief acknowledged this in its scope-reduction note (ASM-004 in plan.md, modified A4).
- **7 pre-existing test failures in the full suite** (`tests/test_backfill_base_ref_sha.py` × 5, `tests/test_human_review.py` × 2). Verified pre-existing by stashing all my changes and re-running — same 7 failures on the pristine tree. **Not caused by this run.** Not in scope to fix here. Worth recording in `follow-ups.md` if not already tracked elsewhere.
- **No `/build` slash command exists yet** (TODO §3). build-context.md was generated by `cmd_start` at `ready -> building`, but there was no LLM-prompted enforcement to read it first. The build proceeded fine in practice; this is an asymmetry-with-other-stages issue, not a correctness issue.

## Commands run

Pre-implementation verification of merge-SHA discovery (Preflight in plan.md):

```
git log --merges --first-parent --format=%H master -- agent-workbench-live/runs/2026-05-25-generalize-stage-context-md/metadata.yaml
# -> c075b0c4...
git log --merges --first-parent --format=%H master -- agent-workbench-live/runs/2026-05-26-board-freshness-across-worktrees/metadata.yaml
# -> 36d4b39c...
git log --merges --first-parent --format=%H master -- agent-workbench-live/runs/2026-05-25-each-worktree-owns-its-own-run-dir/metadata.yaml
# -> 8b78deec...
git log --merges --first-parent --format=%H master -- agent-workbench-live/runs/2026-05-25-lifecycle-papercuts-lock-ready-banner/metadata.yaml
# -> 470632c8...
```

All four returned exactly one SHA — ASM-003 confirmed.

Test runs:

```
python -m pytest tests/test_runs.py -x -q   # 17 passed
python -m pytest tests/test_reconcile_master_metadata.py -v   # 5 passed
python -m pytest tests/ -q   # 396 passed, 7 failed (all 7 pre-existing, unrelated)
```

Live reconciliation:

```
python tools/reconcile_master_metadata_after_cmd_complete.py    # dry-run: would-apply: 4
python tools/reconcile_master_metadata_after_cmd_complete.py --write   # applied: 4
python tools/reconcile_master_metadata_after_cmd_complete.py   # idempotent: would-apply: 0, already-terminal: 4
```

Live list/board agreement spot-check:

```
agent-workbench list | grep human_review        # 5 rows
agent-workbench board --static --status human_review | grep "^✕"   # 5 rows, same IDs
```

## Documentation touched

- `runs/2026-05-27-reconcile-master-metadata-after-cmd-complete/stages/2_shaping/brief.md` — added a `## Scope reduction (2026-05-27, post-planning)` section at the top documenting the Y-vs-Z decision. The original brief sections are unchanged.
- `runs/2026-05-27-reconcile-master-metadata-after-cmd-complete/stages/3_planning/plan.md` — significantly rewritten during planning to scope down to Y and to add a `## Deferred to follow-ups` section. DR-006 added (file-path graph topology for merge-SHA discovery).
- No changes to `AGENTS.md`, `CLAUDE.md`, `docs/lifecycle.md`, or any other top-level repo docs. The Z scope (forward fix in `cmd_complete` + doctor check + module docstrings) is captured in `plan.md`'s `## Deferred to follow-ups` and will be lifted into `follow-ups.md` by the `/followups` stage at the end of building.

The reconciled master-side `metadata.yaml` files (`runs/2026-05-25-generalize-stage-context-md/`, `runs/2026-05-26-board-freshness-across-worktrees/`, `runs/2026-05-25-each-worktree-owns-its-own-run-dir/`, `runs/2026-05-25-lifecycle-papercuts-lock-ready-banner/`) are data updates, not documentation — listed under "Files changed" above, not here.
