# Implementation plan

## Current repo understanding

This is a self-modifying run: the target repo IS this workbench (`agent-workbench-live/`). The relevant code lives at the workbench root.

The bug at hand is a disagreement between two enumerators:

1. **`agent-workbench list`** (`lib/cli/cmd_list_runs.py:18-20`) reads via `metadata.load(cfg, rid)`, which (per `lib/metadata.py:60-90` → `lib/runs.py:175-198`) resolves to the *worktree-side* `runs/<id>/metadata.yaml` whenever both copies exist and the worktree is live. The worktree copy carries the post-merge `status: done` for completed self-modifying runs, so `list` shows `done`.

2. **`agent-workbench board`** (`lib/board/snapshot.py:76-92`) uses `Run` objects from `iter_all_runs` directly. `_walk_worktrees` (`lib/runs.py:278-310`) drops any worktree hit whose status is `done` / `abandoned` at lines 297-298, treating it as "merged history checked out here, NOT live work." So the worktree hit is discarded and the master-side hit (frozen at `human_review` because `cmd_complete` only wrote the `done` status into the worktree's copy AFTER `_do_merge()`) survives. Board shows `human_review`.

Both enumerators read `metadata.yaml`. They disagree because two copies exist and they resolve the collision in opposite directions.

**Scope decision: Y (per user, 2026-05-27).** Fix the read-layer disagreement with a minimal change to `_walk_worktrees`, then run a one-shot reconciliation script to clean up the four observed stale master-side `metadata.yaml` files on disk. The forward-looking `cmd_complete` fix, the doctor check, and the module-docstring documentation move to follow-ups for a later run (Z).

## Relevant files

- `lib/runs.py:278-310` — `_walk_worktrees()`. Filter at lines 297-298 (`if run.status in ("done", "abandoned"): continue`) is the load-bearing line. **The 2-line read-layer fix lives here.**
- `lib/runs.py:219-243` — `iter_all_runs()`. Walks master + worktree hits, prefers worktree on collision. Untouched.
- `lib/runs.py:76-107` — `is_self_modifying()`. Untouched.
- `lib/cli/cmd_list_runs.py:18-20` — `list` enumerator. Reads via `metadata.load`. Already returns the correct status. Untouched.
- `lib/board/snapshot.py:76-92` — `board` enumerator. Consumes `iter_all_runs` output. Fix to `_walk_worktrees` makes board agree with list. Untouched.
- `lib/metadata.py:120-137` — `save()`. Reusable to write YAML to an explicit path; the reconciliation script uses it (or `yaml_io.dumps` directly, mirroring `tools/backfill_completion_refs.py`).
- `lib/metadata.py:55-57` — `now_iso()`. Wall-clock with local TZ. Not used by reconciliation (which sources `completed_at` from git, not wall-clock).
- `lib/repos.py:278-301` — `resolve_parent_branch()`. Reconciliation script calls this once to learn the parent branch name.
- `tools/backfill_completion_refs.py` — the precedent shape for the reconciliation script.
- `schemas/run-metadata.yaml:153-175` — `completion` block schema. The script writes `accepted_by`, `completion_ref`, `completed_at`.
- `tests/test_runs.py` — where the `_walk_worktrees` test lands.
- `tests/test_reconcile_master_metadata.py` — new test file for the script.

## Proposed changes

### Change 1 — read-layer fix in `_walk_worktrees`

In `lib/runs.py`, modify the terminal-state filter at lines 297-298. Today:

```python
if run.status in ("done", "abandoned"):
    continue
```

New behavior: **keep the worktree hit if and only if the master-side copy disagrees AND the worktree copy is terminal**. The intent stays the same ("worktree copies of terminal runs are usually just merged history") but with an explicit carve-out for the collision case where master is stale.

Concrete shape:

```python
if run.status in ("done", "abandoned"):
    master_status = _master_side_status(cfg, run.run_id)
    if master_status == run.status:
        # Master agrees — the worktree hit is just history. Skip.
        continue
    # Master disagrees (typically stale human_review). Prefer the worktree's
    # terminal status; it's the more recent truth. Falls through to yield.
```

`_master_side_status` is a small helper that reads `cfg.runs_path / run_id / "metadata.yaml"` directly via `yaml_io.loads` (or `metadata.load` against a master-side override if that's cleaner) and returns the status field, or `None` if the master-side file doesn't exist. The check is cheap (one YAML read per terminal-state worktree hit; only fires for completed runs whose worktrees are still on disk — a small population).

Net effect: `board` now treats the worktree's `done` as authoritative when master-side is stale, agreeing with `list`. For runs whose master and worktree both say `done` (the common post-cleanup case), the behavior is unchanged.

Alternative considered (DR-002): simply remove the filter entirely. Rejected because the filter is correct for the *common* case where master and worktree both report `done`; removing it would have `board` emit duplicate-looking rows for every long-lived done worktree.

### Change 2 — one-shot reconciliation script `tools/reconcile_master_metadata_after_cmd_complete.py`

Mirrors `tools/backfill_completion_refs.py` shape. Standalone, runs against a workbench root, walks the four known stale runs and rewrites their master-side `metadata.yaml` to `done`.

**Scope reduction vs. earlier draft:** because there are only FOUR known runs (and we have already confirmed which they are via the original TODO entry), the script does not need general-purpose merge-SHA discovery against an unknown population. It uses file-path-based discovery (DR-006) for each of the four, validates the result, and refuses to proceed if any of the four doesn't return exactly one merge SHA — the user manually overrides via flags in that case.

argparse:
- `--root <path>` — workbench root, defaults to `<script-dir>/..`.
- `--write` — apply changes; default is dry-run.
- `--run-id <id>` — restrict to a single run; default: process all four hardcoded run IDs.
- `--branch-name <name>` — override the discovered branch name (manual escape hatch).
- `--merge-sha <sha>` — override the discovered merge SHA (manual escape hatch).

For each target run:
1. Read master-side `runs/<run_id>/metadata.yaml`.
2. If status is already `done` / `abandoned`, skip with `OK already-terminal`.
3. Compose the branch name from metadata (`target.worktree.branch_name`) or use the override.
4. Discover the merge SHA via the primary file-path query (DR-006). On zero or multiple matches, fall back to anchored message-grep. On both failing, skip with `WARN no-merge-found`.
5. Read merge commit's committer date via `git log -1 --format=%cI <sha>`.
6. Mutate the metadata dict:
   - `status: done`
   - `completion.accepted_by: "reconciliation"` (DR-001)
   - `completion.completion_ref: "merge:<sha>"`
   - `completion.completed_at: <committer-iso-date>` (DR-003)
7. Dry-run: print the planned diff. Write mode: serialize via `lib.yaml_io.dumps` and `pathlib.Path.write_text`.
8. Do NOT auto-commit (mirrors `backfill_completion_refs.py`). User commits manually after inspecting the four-file diff.

The hardcoded list of four run IDs (`KNOWN_STALE_RUNS` constant at top of script):

- `2026-05-25-generalize-stage-context-md`
- `2026-05-26-board-freshness-across-worktrees`
- `2026-05-25-each-worktree-owns-its-own-run-dir`
- `2026-05-25-lifecycle-papercuts-lock-ready-banner`

(Plus this run, `2026-05-27-reconcile-master-metadata-after-cmd-complete`, will get added to the list before merge — but that one will be reconciled by Z's forward fix in a future run, not by this script. ASM-007.)

## Files likely to change

- `lib/runs.py` — Change 1 (~30 LOC for `_walk_worktrees` modification + helper).
- `tools/reconcile_master_metadata_after_cmd_complete.py` — Change 2 (new file, ~120 LOC).
- `tests/test_runs.py` — new test for `_walk_worktrees` collision behavior.
- `tests/test_reconcile_master_metadata.py` — new test file for the script (dry-run, write, idempotency, override flags).

Approximate delta: +200 LOC. Half is the script, half is tests.

## Data model changes

None. No schema changes. The script writes existing `completion` block fields.

## UI changes

None.

## Test plan

### Unit tests

- **`tests/test_runs.py::test_walk_worktrees_prefers_terminal_worktree_when_master_stale`** — Synthetic workbench with two `metadata.yaml` files for the same run: master says `human_review`, worktree says `done`. Asserts `_walk_worktrees` yields the worktree hit (not skipping it). **This test would fail under today's filter.**
- **`tests/test_runs.py::test_walk_worktrees_skips_terminal_worktree_when_master_agrees`** — Same fixture but master also says `done`. Asserts `_walk_worktrees` skips the worktree hit (preserves today's behavior for the common case).
- **`tests/test_runs.py::test_walk_worktrees_skips_when_master_file_missing`** — Synthetic case where the master-side `metadata.yaml` doesn't exist at all. Asserts current behavior is unchanged (the worktree hit gets skipped — `master_status is None` falls through to skip, matching today's terminal-state-skip).
- **`tests/test_reconcile_master_metadata.py::test_dry_run_lists_offenders`** — Synthetic workbench with a stale `human_review` master + a real merge commit. Asserts dry-run output identifies the run, the merge SHA, and does NOT modify any file.
- **`tests/test_reconcile_master_metadata.py::test_write_applies_rewrite`** — Same fixture; runs with `--write`. Asserts master-side metadata now `status: done` with the `completion` block populated.
- **`tests/test_reconcile_master_metadata.py::test_idempotent`** — Runs `--write` twice; second run reports zero offenders.
- **`tests/test_reconcile_master_metadata.py::test_already_terminal_is_skipped`** — Fixture where the master is already `done`. Asserts script reports `OK already-terminal` and does not rewrite.
- **`tests/test_reconcile_master_metadata.py::test_manual_override_flags`** — Tests `--branch-name` and `--merge-sha` overrides bypass discovery.

### Integration tests / manual QA

- **QA-1:** Run `pytest tests/` from workbench root. Full suite passes.
- **QA-2:** Run `tools/reconcile_master_metadata_after_cmd_complete.py` (dry-run) on the live workbench. Confirm it identifies the four known stale runs and shows correct merge SHAs.
- **QA-3:** Run with `--write`. Inspect the four `runs/<id>/metadata.yaml` files. Confirm each now has `status: done` + populated `completion` block. Commit the four-file change with: `metadata: reconcile master-side done status for 4 historical runs`.
- **QA-4:** Run `agent-workbench list` and `agent-workbench board --static --status human_review`. Confirm they agree (no ghost runs in `human_review`).
- **QA-5:** Re-run the reconciliation script (dry-run). Confirm "0 runs would be modified."

## Risks

- **R1: Read-layer fix has a subtle edge case.** `_walk_worktrees`'s new branch reads master-side `metadata.yaml`. If the master file is being concurrently written (e.g. during a partial `cmd_complete`), the read could see torn YAML. Mitigation: wrap `_master_side_status` in a narrow try/except (yaml.YAMLError, OSError) that returns `None` on failure — falls through to today's skip behavior. Single-machine single-user workbench means this is theoretical. ASM-005.
- **R2: Reconciliation script picks the wrong merge SHA on multiple matches.** Mitigation: the script reports `WARN multiple-merges` when the file-path query returns >1 match and uses the most recent; user can override via `--merge-sha`. The four known stale runs have been manually checked against `git log` and each returns exactly one match (PRE-IMPLEMENTATION VERIFICATION TASK).
- **R3: Worktree's `metadata.yaml` is itself stale (e.g. an in-flight bounce that hasn't completed).** The fix would surface a non-terminal worktree status, which `_walk_worktrees` keeps anyway (terminal-state filter doesn't apply). Not actually a risk for this change.

## Definition of done

- Change 1 lands. `_walk_worktrees`'s new behavior makes `board` agree with `list` for the four observed stale runs.
- All `tests/test_runs.py` tests pass, including the three new collision-behavior tests. The first new test would fail under the pre-change `_walk_worktrees`.
- Change 2 lands. Script runs cleanly against the four known stale runs in dry-run mode.
- After `--write`, the four `runs/<id>/metadata.yaml` files on master show `status: done` with the expected `completion` block. User has committed the four-file diff.
- Re-running the script (dry-run) reports 0 offenders.
- `agent-workbench list` and `agent-workbench board --static --status human_review` agree.
- Plan's `## Deferred to follow-ups` section is filled in with Z-scope details + other adjacent fixes, so `/followups` stage picks them up cleanly.

## Deferred to follow-ups

The following are intentionally out of scope for this run (Y) but are recorded here so the `/followups` stage at the end of building lifts them into `follow-ups.md`:

### Z — Forward fix in `cmd_complete` + doctor check + module docstrings

**Motivation:** Y's read-layer fix solves the visible disagreement, but the underlying master-side `metadata.yaml` is still stale on disk for every future self-modifying complete. The next reader of `runs/<id>/metadata.yaml` (a new enumerator, a manual `cat`, a future script) gets the wrong answer. Z fixes the disk state for future runs too.

**Suggested scope:**
- In `lib/cli/cmd_complete.py` self-modifying path, after `_do_merge()` succeeds and `metadata.update()` writes the worktree-side `done` status: add a follow-on commit on `parent_branch` in the workbench root that stages and commits the master-side `runs/<id>/metadata.yaml` rewrite. Commit message: `metadata: backfill done status for <run_id>`.
- Add a `cmd_doctor.py` advisory check: walk master-side `runs/<id>/metadata.yaml`, flag any non-terminal status whose `agent/<slug>` branch is already merged into `parent_branch`. One-line WARN per offender. Doctor doesn't auto-fix.
- Add module docstrings to `lib/runs.py` (near `_walk_worktrees`) and `lib/cli/cmd_complete.py` documenting the invariant.
- Error handling: catch only `subprocess.CalledProcessError` and `OSError` in the follow-on commit logic. Emit a `MasterMetadataBackfillFailed` event to `events.jsonl` on caught failure. Don't silently swallow.
- Pre-implementation: verify which working directory `repos.merge_no_ff` ends up in after the merge (worktree vs. workbench root). The `git -C` target for the follow-on commit depends on this.
- Tests: a new test in `tests/test_self_modifying.py` driving `/complete` end-to-end and asserting `git show <root_branch>:runs/<run_id>/metadata.yaml | grep status` reports `status: done`. This test would fail under today's `cmd_complete`.

**Category:** tech_debt (well, technically bug_risk — Z prevents the bug class from recurring; Y just papers over its symptom).

### Adjacent — confirm/handle the same bug shape in `cmd_abandon`

**Motivation:** `cmd_complete`'s master-vs-worktree write asymmetry likely exists in `cmd_abandon` too (the brief Non-goals this explicitly). If a run is `/abandon`ed and the abandoned-side `metadata.yaml` write happens after the worktree's commit but before any merge-onto-master, master could end up stale the same way.

**Suggested scope:**
- Read `lib/cli/cmd_abandon.py` and confirm whether master-side metadata can end up stale.
- If so, apply the same fix shape as Z (follow-on commit on parent_branch).
- Add a parallel `cmd_doctor.py` check for non-terminal-but-merged-and-abandoned runs.

**Category:** bug_risk.

### Adjacent — audit the `list` vs `board` collision-resolution asymmetry generally

**Motivation:** Y makes the two enumerators agree for the *terminal-state* collision. But they still apply different preferences elsewhere (master-vs-worktree, what to skip, how to deduplicate). Other collisions may still produce silent disagreement.

**Suggested scope:**
- Map every collision case `iter_all_runs` can produce.
- For each, document which enumerator resolves it how. Compare for any drift.
- Decide whether to unify both enumerators on one shared resolution helper (probably yes; smaller surface area, no possibility of future drift).

**Category:** refactor.

### Adjacent — surface `MasterMetadataBackfillFailed` events in the audit narrative

**Motivation:** Z proposes emitting `MasterMetadataBackfillFailed` events. The audit-narrative renderer (wherever that lives) should know how to format them, otherwise they'll show up as `unknown event` in human review.

**Suggested scope:** one-line addition to the audit renderer's event-type map.

**Category:** docs.

## Preflight

- **Python version:** 3.10.9 (per CLAUDE.md). Workbench's `bin/agent-workbench` uses Python directly.
- **Repo state:** Worktree at `LOCAL_worktrees/.../20260527__reconcile-master-metadata-after-cmd-complete/`. Self-modifying. `target.repo.path` == workbench root per metadata.
- **Dependencies:** No new Python deps. Uses stdlib + existing `lib.yaml_io`, `lib.metadata`, `lib.repos`, `lib.runs`.
- **Test runner:** `pytest tests/` from workbench root.
- **Build/lint:** No additional steps beyond running tests.
- **Pre-implementation verification (do this FIRST, before writing the script):** Run the merge-SHA query manually against the four known stale runs and confirm each returns exactly one match:
  ```
  git log --merges --first-parent --format=%H master -- runs/2026-05-25-generalize-stage-context-md/metadata.yaml
  git log --merges --first-parent --format=%H master -- runs/2026-05-26-board-freshness-across-worktrees/metadata.yaml
  git log --merges --first-parent --format=%H master -- runs/2026-05-25-each-worktree-owns-its-own-run-dir/metadata.yaml
  git log --merges --first-parent --format=%H master -- runs/2026-05-25-lifecycle-papercuts-lock-ready-banner/metadata.yaml
  ```
  Record the four SHAs in `assumptions.md` (or here in the plan). If any query returns 0 or >1 match, the script handling needs adjustment before implementation.

## Decisions & assumptions

### DR-001

- **Decision**: Reconciliation script writes `completion.accepted_by: "reconciliation"` (literal string).
- **Rationale**: The script can't know who originally accepted a historical run. "reconciliation" is unambiguous in the audit trail.
- **Alternatives considered**: leave null; use git `user.email`; require `--accepted-by` flag.
- **Why not the alternatives**: null violates the `completion.required` schema rule; user.email attributes script behavior to a person; required flag is friction for a one-shot.

### DR-002

- **Decision**: Change 1 modifies the terminal-state filter rather than removing it.
- **Rationale**: Removing the filter would have `board` emit duplicate-looking rows for every long-lived `done` worktree on disk. Modifying it carves out the stale-master case while preserving today's behavior for the common case.
- **Alternatives considered**: (i) remove the filter; (ii) move the dedup logic to `iter_all_runs` and have `_walk_worktrees` always yield.
- **Why not the alternatives**: (i) regresses the common case. (ii) larger change — touches two functions instead of one.

### DR-003

- **Decision**: `completion.completed_at` sourced from merge commit's committer date (`git log -1 --format=%cI <merge_sha>`), NOT wall-clock at script execution.
- **Rationale**: "Completed at" should reflect when the merge landed, not when the backfill runs.
- **Alternatives considered**: wall-clock; author date.
- **Why not the alternatives**: wall-clock decouples from reality; author/committer date typically agree but committer is the more accurate "when this entered the tree."

### DR-004

- **Decision**: Reconciliation script hardcodes the four known stale run IDs as `KNOWN_STALE_RUNS` constant; does not auto-discover non-terminal-but-merged runs at large.
- **Rationale**: Y's scope is "clean up the four observed runs." General-purpose discovery against the full repo is Z's territory (via the doctor check). Keeping the script narrow avoids over-engineering and makes the failure modes (R2) tractable — four runs are manually verifiable; an unknown N are not.
- **Alternatives considered**: walk all `runs/<id>/metadata.yaml`, find any non-terminal-but-merged.
- **Why not the alternatives**: that's Z's doctor check. Y deliberately stays narrow.

### DR-005

- **Decision**: Reconciliation script does NOT auto-commit the master-side rewrite.
- **Rationale**: Mirrors `backfill_completion_refs.py` precedent. User commits after inspecting the four-file diff. Removes a class of "the script committed garbage to my repo" failure modes.
- **Alternatives considered**: auto-commit with `--write`.
- **Why not the alternatives**: user-controlled commit is the more conservative default for a one-shot tool.

### DR-006

- **Decision**: Merge-SHA discovery uses **file-path graph topology** as primary signal: `git log --merges --first-parent --format=%H <parent_branch> -- runs/<run_id>/metadata.yaml`. Anchored message-grep (`--grep="^Merge branch '<branch_name>'$"`) is the fallback. `--branch-name <name>` and `--merge-sha <sha>` are manual overrides.
- **Rationale**: File-path topology depends on a structural workflow invariant (`_do_merge()` always commits the run dir via `stage_and_commit_run_dir` for self-modifying runs at `cmd_complete.py:223-236`), not on a human-editable commit message. Immune to custom messages, branch-name composition drift, and `--grep` substring footguns.
- **Alternatives considered**: message-grep alone; reflog-based branch-tip recovery; `git branch --contains` against a metadata-stored SHA.
- **Why not the alternatives**: message-grep is brittle to message customization and substring-match issues. Reflog is deleted by `git branch -D` (which `cmd_complete` runs). `--contains` requires a known SHA that isn't stored.

### ASM-001

- **Text**: The reconciliation script uses `lib.yaml_io.loads/dumps` directly (mirrors `tools/backfill_completion_refs.py`) rather than calling `lib.metadata.update()`.
- **Reason**: Existing backfill scripts use this pattern.
- **Impact**: low

### ASM-002

- **Text**: `_master_side_status` (the helper used by Change 1) reads `cfg.runs_path / run_id / "metadata.yaml"` directly via `yaml_io.loads` rather than `metadata.load`, to avoid `metadata.load`'s worktree-resolution logic re-routing it to the worktree copy (which would defeat the purpose of the check).
- **Reason**: We explicitly want the master-side file, not whichever copy `metadata.run_dir` resolves to.
- **Impact**: medium — if `metadata.load` is the only API and there's no master-side override, we factor a small helper. Verify during implementation.

### ASM-003

- **Text**: The four known stale runs each have exactly one merge commit on `master`'s first-parent line that touched their `runs/<id>/metadata.yaml`. Confirmed via manual run of the query (PRE-IMPLEMENTATION verification, listed in Preflight).
- **Reason**: All four are recent self-modifying runs that went through `cmd_complete`'s standard merge path.
- **Impact**: low — if a query returns 0 or >1, the user is alerted via WARN and uses `--merge-sha` to override.

### ASM-004

- **Text**: This run (`2026-05-27-reconcile-master-metadata-after-cmd-complete`) will itself land via `/complete` and produce a fifth stale master-side `metadata.yaml`. That fifth one is not in the script's `KNOWN_STALE_RUNS` list; it'll be reconciled by Z's forward fix in a future run.
- **Reason**: Scope decision: this run fixes the four already-observed stale runs and the read-layer disagreement. It does not fix itself.
- **Impact**: low — after this run's `/complete`, `agent-workbench list` and `agent-workbench board` agree because of Change 1, even though this run's master-side metadata is itself stale. Cosmetic only until Z lands.

### ASM-005

- **Text**: `_master_side_status` wraps its YAML read in a narrow try/except (`yaml.YAMLError`, `OSError`) and returns `None` on failure, falling through to today's skip behavior.
- **Reason**: Defensive against torn writes (theoretical on single-user workbench).
- **Impact**: low

### ASM-006

- **Text**: The four hardcoded `KNOWN_STALE_RUNS` IDs in the script match the four runs identified in the original TODO §1 entry. Any future stale runs that accumulate before Z lands will need to be added to the constant manually OR reconciled via the `--run-id <id>` flag.
- **Reason**: Narrow scope; explicit list is auditable.
- **Impact**: low

### ASM-007

- **Text**: The script's commit-merge-SHA-format is `merge:<sha>` (matching what `cmd_complete` natively writes per `lib/cli/cmd_complete.py:94`).
- **Reason**: Consistency with the canonical format makes `completion_ref` parseable by other tooling.
- **Impact**: low
