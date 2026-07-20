# Implementation plan

## Current repo understanding

The workbench CLI lives at `agentic-development-task-system-v3__ai/agent-workbench-live/`. Its checkout is itself the workbench root resolved by `bin/agent-workbench:17-22` (env var `AGENT_WORKBENCH_ROOT` or the script's parent). `Config.runs_path` is `root / "runs"` (`lib/config.py:82-83`). Today, every run dir is created via `metadata.create()` → `metadata.run_dir(cfg, run_id) → cfg.runs_path / run_id` (`lib/metadata.py:60-61`). Because master and every worktree both contain `agent-workbench-live/`, that path resolves to wherever the binary was launched from, and run dirs land in master's working tree even when the owning worktree is clean.

Worktrees are git worktrees of the **target repo** (`metadata.target.repo.path`), not of the workbench checkout itself. Today the workbench checkout has exactly one working copy on disk (master); when this run lands, the workbench will have multiple sibling worktrees, each carrying its own `agent-workbench-live/runs/`.

Lifecycle today:

- `new-run` (`lib/cli/cmd_new_run.py`): validates the target repo, writes `runs/<id>/metadata.yaml` + `runs/<id>/raw-idea.md`, calls `lifecycle.init_staged_layout()`, emits `RunCreated`. No worktree created.
- `shape --init`, `shape`, `plan --init`, `plan`: each transitions but never touches the worktree.
- `start` (`lib/cli/cmd_start.py:69-72`): calls `repos.create_worktree(repo_path, branch_name, worktree_path, base_ref)` against the **target** repo. Branch is created by `git worktree add -b <branch> <path> <base_ref>` (`lib/repos.py:120-126`). Transitions `ready → building`.
- `validate`, `followups`: agent-driven transitions; never touch worktree.
- `complete` (`lib/cli/cmd_complete.py`): merges the agent branch into the parent branch with `--no-ff` (`lib/repos.merge_no_ff`), records `completion_ref: merge:<sha>`, transitions `human_review → done`. The merge target is the **target** repo's parent branch — same code that handles workbench-self-modifying runs and unrelated product-repo runs.
- `abandon` (`lib/cli/cmd_abandon.py`): wildcard transition to `abandoned`. Does **not** remove the worktree or branch today. The two only get cleaned up by hand or by some other path. (Brief A5 will change this.)

The key insight: when the target repo *is* the workbench's own monorepo (this run, and most workbench-self-modifying runs), the agent branch's worktree contains an `agent-workbench-live/runs/` directory at the same path as master's. The run dir created during `new-run` lives in master because `cfg.runs_path` resolves there, not in the (not-yet-existing) worktree. After this run lands, the run dir lives in the worktree from `new-run` onward.

Today's metadata flow:
- `metadata.run_dir(cfg, run_id)` returns `cfg.runs_path / run_id`. **40+ call sites** through `lib/`, `lib/cli/`, `lib/board/`, `lib/metrics/`. They all assume `cfg.runs_path` is the one true `runs/`.
- `metadata.list_runs(cfg)` iterates `cfg.runs_path.iterdir()` — single-source enumeration. Two callers: `lib/board/snapshot.py:71`, `lib/cli/cmd_list_runs.py:18`.
- `lib/metrics/rollup.py:57-63` does its own `cfg.runs_path.glob("*")` enumeration (does not use `list_runs`).
- `lib/board/app.py:567-570` schedules the watchdog observer on `cfg.runs_path` for live-board updates.

How the merge works for workbench-self-modifying runs (verified by inspecting the existing `runs/2026-05-24-fix-generated-lines-base-ref-head/`): the agent commits its feature changes to the agent branch inside its worktree; `git merge --no-ff` brings those into master. The run dir itself is **not** in the merge — it sits untracked in master, having been authored there by `metadata.create` at `new-run` time. This run's whole point is to make that run dir part of the merge.

## Relevant files

- `lib/config.py` — `Config.runs_path`, `Config.worktrees_path`.
- `lib/metadata.py` — `run_dir()`, `metadata_path()`, `load()`, `save()`, `create()`, `set_status()`, `update()`, `list_runs()`.
- `lib/events.py` — `append()` calls `run_dir(cfg, run_id)` to find `events.jsonl`.
- `lib/transitions.py` — calls `metadata.set_status` + `events.append`. No direct path derivation.
- `lib/lifecycle.py` — `_run_root` → `metadata_mod.run_dir`, used for stages/archive paths.
- `lib/locks.py` — uses `run_dir` for the lockfile path.
- `lib/audit.py`, `lib/human_review.py` — both use `run_dir` for artifact reads.
- `lib/repos.py` — `create_worktree`, `merge_no_ff`, `resolve_parent_branch`, `worktree_dirty_files`, `branch_exists`, `resolve_ref_to_sha`. Already has every primitive we need.
- `lib/cli/cmd_new_run.py:14-128` — adds `git worktree add` here.
- `lib/cli/cmd_start.py:13-108` — removes `git worktree add` here; keeps state transition + dirty-tree check.
- `lib/cli/cmd_complete.py:1-251` — adds pre-merge `git add agent-workbench-live/runs/<id>` + `git commit` step inside the worktree.
- `lib/cli/cmd_abandon.py:1-59` — adds pre-merge commit (same as complete) + a merge step that lands the run dir at `runs/abandoned/<id>/` on the workbench root, then removes worktree + branch.
- `lib/board/source.py:1-791` — reads run state; today uses `metadata.run_dir`.
- `lib/board/snapshot.py:51-93` — `build(cfg)` enumerates via `metadata.list_runs(cfg)`.
- `lib/board/app.py:567-570` — watchdog on `cfg.runs_path`.
- `lib/metrics/rollup.py:55-65` — its own enumeration over `cfg.runs_path.glob("*")`.
- `lib/cli/cmd_list_runs.py` — single-source enumeration.
- `lib/cli/cmd_doctor.py:1-72` — no run-enumeration today; gains the orphan check.
- `bin/agent-workbench:17-22` — workbench-root resolver. Unchanged.
- `tests/test_e2e.py:142-447` — fixture asserts pin run-dir at `self.tmp / "runs" / run_id`.
- `tests/_helpers.py` — provides `make_tmp_workbench()`. (To re-read in implementation.)
- `tests/test_metadata.py`, `tests/test_cmd_board.py` — direct callers of `list_runs`.
- `docs/lifecycle.md` — documents the `new-run → ... → done` sequence.
- `architecture.md` (root) — describes "workbench root is artifact store".
- `agent-workbench-live/AGENTS.md` — "Source of truth" section.
- `schemas/run-metadata.yaml` — additive field if needed (probably none; the existing `target.worktree.path` and `target.worktree.created` already cover the new state).

## Proposed changes

### A1. Worktree creation moves from `start` to `new-run`

In `cmd_new_run.run()`:

1. After name resolution + run-id derivation, compute `worktree_path = run_ids.make_worktree_path(cfg, repo_name, worktree_name, run_id)`. (Already used by `cmd_start` today.)
2. **Before** calling `metadata.create()`, call `repos.create_worktree(repo_path, branch_name, worktree_path, base_ref)`. The dirty-tree refusal in `repos.create_worktree` already guards against re-use of an existing worktree path or branch.
3. Also resolve `base_ref` → `base_ref_sha` here (was done in `cmd_start` today; moves up alongside worktree creation). Pre-`303bd40` runs that haven't been started yet don't exist, so there's nothing to migrate.
4. **Change** `metadata.create()` to accept an optional `worktree_path` + `base_ref_sha` and write them into the saved `metadata.yaml` (`target.worktree.path`, `target.worktree.created=True`, `target.repo.base_ref_sha`).
5. **Change** `metadata.run_dir(cfg, run_id)` so that when called for a run whose metadata already exists with `target.worktree.path` set, it returns `<worktree_path>/agent-workbench-live/runs/<run_id>/`. For fresh runs (during `metadata.create()` itself, before the file exists), the path is computed from the `worktree_path` arg directly. For historical runs (metadata exists but `target.worktree.path` is null — pre-this-change runs in `done`/`abandoned` state on master), keep returning `cfg.runs_path / run_id`.

The implementation strategy: introduce `metadata._compute_run_dir(cfg, run_id, meta_or_none)` that takes an optional already-loaded metadata dict. The public `run_dir(cfg, run_id)` loads (best-effort, never raises) and inspects `target.worktree.path`. On loaders that have the dict in hand (`load`, `save`, `create`), pass it through.

Edge case: `metadata.run_dir(cfg, run_id).exists()` in `cmd_new_run.py:59` is the collision check **before** the metadata file is written. At that point we have a `worktree_path` computed; the check becomes "does the worktree's run dir or master's runs path contain this id?" — handled by the new `find_run` helper (A2) returning None or raising on collision.

In `cmd_start.run()`:

1. **Remove** the `repos.create_worktree(...)` call.
2. **Remove** the `repos.resolve_ref_to_sha(...)` call (moved to `new-run`).
3. **Remove** the metadata mutator that sets `worktree.path / .created=True / base_ref_sha`.
4. Keep the dirty-tree / branch-exists guards — they're still useful (the worktree was created in `new-run` and a human could have mutated it before `/start`). Actually, the worktree didn't exist before `new-run`, so the guards apply to a worktree that's been alive through shaping + planning. Some guards stay (dirty-tree refusal), others don't apply (branch-existence check is moot — the branch was created by `git worktree add` in `new-run`).
5. Keep the `transitions.transition(cfg, run_id, "building", evidence, actor)` call. The evidence still wants the worktree-related fields; they're read from `metadata` (already populated).

### A2. First-class `Run` value object + `find_run` helper

New file `lib/runs.py`. Exports:

```python
@dataclass(frozen=True)
class Run:
    run_id: str
    run_dir: pathlib.Path        # absolute
    worktree_path: pathlib.Path | None  # None for archived-on-master runs
    status: str
    source: str                  # "worktree" | "master"
    metadata: dict

def find_run(cfg, run_id) -> Run: ...     # KeyError-style if not found, RunCollision if collision
def iter_all_runs(cfg) -> Iterator[Run]:  # union enumeration

class RunNotFound(LookupError): ...
class RunCollision(RuntimeError): ...     # message includes both paths
```

Enumeration walk:

1. `master_runs_dir = cfg.runs_path` — iterate, yield runs whose `metadata.yaml` loads cleanly. Source `"master"`. For each, also peek inside `cfg.runs_path / "abandoned"` (A5's archive subtree); source still `"master"`.
2. `git -C <workbench_root> worktree list --porcelain` — parse the list. For each non-bare worktree whose path is not the workbench root, look at `<worktree>/agent-workbench-live/runs/`. Yield each run dir with source `"worktree"`.
3. De-dupe collisions: in `iter_all_runs`, emit both with a `WARN:` line on stderr but prefer the worktree copy in the de-duped output (board policy). In `find_run`, collisions raise `RunCollision` (strict). This split is intentional — single-run lookups need certainty; the board needs to render even when on-disk state is messy.

`metadata.run_dir(cfg, run_id)` keeps its signature but internally calls `_compute_run_dir`, which uses `find_run` if metadata isn't already loaded. To avoid recursion, `find_run` itself only does the on-disk walk + `yaml_io.loads` — it does **not** call `metadata.run_dir`.

Performance: enumerating worktrees is `git worktree list --porcelain` once per call. Cached for the lifetime of one CLI invocation via `functools.lru_cache` keyed on `cfg.root` (single value).

### A3. Thread `run_dir` through transitions, events, metadata writers

`lib/metadata.py:60-61` `run_dir`: returns the resolved path. The signature is unchanged — every caller `metadata.run_dir(cfg, run_id)` returns the new resolved path.

`lib/events.py:128` `append()` calls `run_dir(cfg, run_id) / "events.jsonl"`. Unchanged at the call site; benefits transparently from the new `run_dir` resolution.

`lib/transitions.py` — no direct path derivation. Unchanged.

`lib/lifecycle.py:84` `_run_root` calls `metadata_mod.run_dir`. Unchanged.

`lib/locks.py:20` imports `run_dir`. Unchanged.

`lib/audit.py`, `lib/human_review.py`, `lib/board/source.py`, `lib/cli/cmd_*.py` — all call `metadata.run_dir(cfg, run_id)`. Unchanged.

`metadata.list_runs(cfg)` — replaces its body with a call to `lib.runs.iter_all_runs(cfg)`, yielding `run_id`s. Stays alphabetically sorted. Both `lib/cli/cmd_list_runs.py` and `lib/board/snapshot.py` benefit transparently.

`lib/metrics/rollup.py:57-65` — replaces the manual glob with `for run in iter_all_runs(cfg):` and uses `run.run_dir` (already resolved) for `metrics.jsonl` lookup.

`lib/board/app.py:567-570` — the watchdog can no longer schedule on a single dir. Build a list of watch roots: `cfg.runs_path` + every `<worktree>/agent-workbench-live/runs/` from `iter_all_runs`. Schedule one observer; call `obs.schedule(...)` once per root. Watchdog's `Observer` supports multiple `schedule` calls. (Verify.)

The watchdog observers can be torn down/re-scheduled lazily — every refresh tick checks if the set of worktree roots changed (e.g. a new run created in another worktree). For V1 keep it simple: schedule once at startup; rely on the 1Hz fallback timer for new-worktree detection. If a user creates a new run during a board session, it shows up within 1s. Documented as known limitation.

### A4. `complete` commits the run dir on the agent branch before merging

In `cmd_complete._do_merge`, immediately after the dirty-tree check passes and **before** `resolve_parent_branch`:

```python
# Pre-merge: commit the run dir on the agent branch so the merge carries
# the audit trail into master.
_stage_and_commit_run_dir(repo, worktree, run_id, message=f"runs: {run_id} (complete)")
```

`_stage_and_commit_run_dir` is a new helper in `lib/repos.py`:

```python
def stage_and_commit_run_dir(
    repo_path: pathlib.Path,
    worktree_path: pathlib.Path,
    run_id: str,
    *,
    message: str,
) -> str | None:
    """Stage agent-workbench-live/runs/<run_id>/ inside the worktree and commit
    if anything is uncommitted. Returns the commit SHA, or None if nothing
    needed to be committed.
    """
```

Implementation:

1. `relpath = pathlib.Path("agentic-development-task-system-v3__ai") / "agent-workbench-live" / "runs" / run_id` ... but wait, that prefix is target-repo-specific. The workbench's run dir inside a target repo's worktree is `<worktree>/<workbench-root-relative-path>/runs/<run_id>/`. For workbench-self-modifying runs that lands at `<worktree>/agentic-development-task-system-v3__ai/agent-workbench-live/runs/<run_id>/`. For unrelated product-repo runs, the workbench root is NOT inside the target repo — there's nothing to commit.

   Decision: this whole pre-merge-commit step only applies when the target repo *is* the workbench's own repo. We detect this by comparing `pathlib.Path(repo_path).resolve()` against `cfg.root.resolve()`'s ancestor walk — if `cfg.root` is inside `repo_path`, the run dir is inside the worktree and should be committed. Otherwise (unrelated product repo), the run dir lives in the workbench checkout's `runs/` not in the worktree at all, and the existing master-side `runs/<id>/` is the only copy.

   Practical implication: for unrelated product-repo runs, the run dir continues to live in `cfg.runs_path` (master's checkout) the whole way through. That's actually fine — there's no master pollution issue for those runs because they're not in master's working tree of the *target* repo, they're in master's checkout of the *workbench*. The bug this task fixes is exclusively the workbench-self-modifying case.

   To keep the design clean, we add a helper `lib/runs.is_self_modifying(cfg, meta) -> bool` that returns True iff `cfg.root.resolve()` is inside `pathlib.Path(meta["target"]["repo"]["path"]).resolve()`. New-run sets the run dir location based on this: self-modifying → inside the worktree; otherwise → master's `cfg.runs_path` (unchanged). The board/metrics enumeration naturally handles both.

2. Inside the worktree, compute `run_dir_rel` as the path relative to the worktree root. For workbench-self-modifying runs the worktree root is the target repo's worktree; the workbench is at `<worktree>/agentic-development-task-system-v3__ai/agent-workbench-live/`. We resolve this at runtime: `run_dir_rel = (cfg.root / "runs" / run_id).relative_to(worktree)` — works because the workbench root resolves correctly inside the worktree (same monorepo layout). For non-self-modifying runs we skip the commit entirely.
3. `git -C <worktree> add <run_dir_rel>` then `git -C <worktree> status --porcelain <run_dir_rel>`. If empty, return None.
4. `git -C <worktree> commit -m <message>` with author/committer config the same way `repos.create_new` does it (deterministic env: `user.name=Agent Workbench`, `user.email=agent-workbench@local`).
5. Return the new commit SHA from `git -C <worktree> rev-parse HEAD`.

Failure mode: if `add` or `commit` fails for any non-dirty-tree reason, raise `RepoError` and let `_CompleteError` surface it.

### A5. `abandon` mirrors `complete`'s archival path into `runs/abandoned/<id>/`

`cmd_abandon.run()` becomes:

1. Validate state + acquire lock (existing).
2. Load `meta`; identify worktree + repo paths.
3. If self-modifying:
   a. `stage_and_commit_run_dir(repo, worktree, run_id, message=f"runs: {run_id} (abandon)")`.
   b. Use a new helper `repos.merge_no_ff_into_subtree(...)` that does:
      - `git -C repo checkout parent_branch`
      - `git -C repo merge --no-ff -X subtree=agent-workbench-live/runs/abandoned/<id>/ <branch> -m "abandon: <run_id>"`
      
   Actually `-X subtree=` won't do what we want here — that's for merging an external repo. The cleaner approach: merge as usual, then on the parent branch perform a `git mv agent-workbench-live/runs/<id>/ agent-workbench-live/runs/abandoned/<id>/` + commit, all in the same atomic op. Two-step.
   
   Cleaner still: do it as a **non-merge** delivery. After the agent branch's pre-commit lands, we don't want the agent branch's code changes on master (the work was abandoned). So:
   - Do **not** merge the agent branch into master.
   - Instead, on master, populate `runs/abandoned/<run_id>/` by copying the run dir's tree from the agent branch via `git -C repo archive <agent-branch>:<run-dir-rel> | tar -x -C runs/abandoned/<id>/` (or use `git read-tree` + `git checkout-index`).
   - Commit on master with message `abandon: <run_id> (run dir archived)`.
4. `repos.remove_worktree(repo, worktree_path, force=False)` (handle the locked-by-CWD case — if the CLI's CWD is inside the worktree the remove will fail; the abandon flow does not chdir, so the worktree should be removable as long as the CWD is outside it). Add `force=True` if needed; document as a known constraint.
5. `repos.delete_branch(repo, branch_name)` (new helper, simple `git branch -D <branch>`).
6. Existing transition + metadata update + metrics writer continues.

The abandoned-tree-on-master approach (no merge of the agent branch into master) is simpler than a merge-then-move, and matches the intent: abandon does NOT bring the code changes into master, it brings the audit trail.

For non-self-modifying runs (unrelated product repo): the run dir lives at `cfg.runs_path / run_id`. Move it to `cfg.runs_path / "abandoned" / run_id` and commit the workbench checkout's change separately. The target product repo's worktree + branch are removed without merging.

### B1. Board enumerates union of master + worktrees

`lib/board/source.py` and `lib/board/snapshot.py` both call `metadata.run_dir(cfg, run_id)` / `metadata.list_runs(cfg)` — these now return the right thing per A2/A3. No board-source changes beyond switching `list_runs` to `iter_all_runs`-driven.

For the "visually distinguishable archived vs live" requirement: `RunSnapshot` gains a `source: str` field (`"worktree"` or `"master"`). The static + Textual renderers append `(archived)` after the run id when `source == "master"` and the status is `done`/`abandoned`. Done.

Collision warning: `metadata.list_runs` (now `iter_all_runs`-backed) prints the warning to stderr when it dedup-drops a master-side copy in favor of a worktree-side copy. Already covered by `iter_all_runs`.

### B2. Metrics rollup uses the same enumeration

`lib/metrics/rollup.py:55-99` — replace `for run_dir in sorted(runs_dir.glob("*")):` with `for run in sorted(iter_all_runs(cfg), key=lambda r: r.run_id):` and use `run.run_dir`, `run.metadata` instead of re-reading.

### B3. `doctor` checks for orphan run dirs

`cmd_doctor.run()` gains a new section:

```python
print("orphans:")
orphans = _find_orphan_run_dirs(cfg)
if orphans:
    for path, status in orphans:
        print(f"  WARN     orphan run dir on master: {path} (status: {status})")
        print(f"           fix: move into the owning worktree, "
              f"or commit + merge if the run is already complete.")
    # Orphans are a soft warning, not a hard fail.
else:
    print(f"  ok       no orphans")
```

`_find_orphan_run_dirs(cfg)` walks `cfg.runs_path` (master's `runs/`), reads each subdir's `metadata.yaml`, and yields `(path, status)` pairs for any whose status is **not** `done` and **not** `abandoned`. Skips dirs without a `metadata.yaml` (the `abandoned/` subtree from A5 contains run-id-named subdirs each with their own `metadata.yaml`, so that's handled).

### C1. E2E fixture update + new parallel-runs fixture

`tests/test_e2e.py`: existing `happy/` and `bounce_pass2/` scenarios. After A1 lands, `_new_run` returns `(run_id, run_dir, repo)` where `run_dir` is **inside the worktree**, not `self.tmp / "runs" / run_id`. The fixture base test currently computes `self.tmp / "runs" / run_id` (line 139). That changes to:

```python
def _new_run(self, fixture, slug=...):
    ...
    run_id = r.stdout.strip()
    # The run dir is now inside the worktree (TODO §1A).
    meta = _meta_at_master(self.tmp, run_id)  # falls back to master if not in any worktree
    if meta["target"]["worktree"]["path"]:
        run_dir = pathlib.Path(meta["target"]["worktree"]["path"]) / "agent-workbench-live" / "runs" / run_id
    else:
        run_dir = self.tmp / "runs" / run_id
    return run_id, run_dir, repo
```

Wait — the test workbench `self.tmp` is a synthetic copy of `bin/` + `lib/` + the fixtures; the target repo is a separate tmp dir, not the workbench's own repo. So all E2E tests today are **non-self-modifying** runs (unrelated product repo). The run dir stays at `self.tmp / "runs" / run_id`. The existing assertions continue to work — no run-dir-location change for non-self-modifying runs.

For the new parallel-runs fixture to assert the worktree-owns-run-dir behavior, we need a **self-modifying** scenario: the test workbench *is* the test target repo. Achievable by setting `--repo-path` to `self.tmp` itself (and seeding it with a git init in `make_tmp_workbench`). Then the run dir lands inside the worktree, which is a worktree of `self.tmp`. Add a `tests/test_self_modifying.py` (or extend `test_e2e.py`) that:

- Inits `self.tmp` as a git repo.
- Creates two parallel runs (different slugs).
- Drives both to `human_review`, asserts each run dir is inside its own worktree under `self.tmp`'s worktrees, asserts `self.tmp` (master) stays clean of `runs/` untracked entries throughout.
- Completes one, asserts master now has `runs/<id>/` committed.
- Completes the other, asserts master now has both runs committed.
- Doesn't `git stash` ever.

### C2. Unit test for `find_run` enumeration

New `tests/test_runs.py`:

- Tmp workbench with master + two worktrees of the same workbench (using `git worktree add` against the test workbench's tmp git repo).
- One run in each worktree's `runs/`, one archived run on master.
- `find_run(cfg, id_in_worktree_1)` → source `"worktree"`, run_dir inside worktree 1.
- `find_run(cfg, id_archived)` → source `"master"`, run_dir under `cfg.runs_path`.
- Create a colliding copy: write a `metadata.yaml` under `cfg.runs_path / id_in_worktree_1` with the same id. `find_run(cfg, id_in_worktree_1)` raises `RunCollision`; the error message contains **both** absolute paths.
- Remove worktree 1 with `git worktree remove`. Now `find_run(cfg, id_in_worktree_1)` raises `RunNotFound`. (The run dir might still be on disk; `git worktree list` not returning it is what makes it invisible.)

### C3. Migration for the two known orphans

`tools/migrate_orphan_runs.py`:

1. Hardcode the two run ids (or auto-detect): walk `cfg.runs_path`, find any subdir whose `metadata.yaml` shows `target.worktree.path` is non-null AND the worktree exists on disk.
2. For each, `mv cfg.runs_path/<id>/  -> <worktree>/agentic-development-task-system-v3__ai/agent-workbench-live/runs/<id>/`. Since the source is untracked in master, plain `mv` (Python `shutil.move`) suffices.
3. Verify master is clean of those entries.
4. The script is one-shot: includes `if __name__ == "__main__": main()` and is committed alongside the rest of the change; deleted in the same commit (or a follow-up within this run) once it's been run.

Decision: run the script as part of the build phase of this run (not commit it). Since the two orphan dirs sit on master and master IS the integration target for this run, the migration is part of the work. Commit message will reference it. The script can be a temporary throwaway authored, run, and deleted before validate.

### C4. Documentation sweep

- `docs/lifecycle.md`: update the `draft → ... → human_review → done` lifecycle table to note "run dir lives in worktree during lifecycle; in master after `complete`/`abandon` merge". One-paragraph rewrite of the `new-run` section ("creates worktree + writes run dir inside it") and the `start` section ("no longer creates the worktree; state-only transition").
- `architecture.md` (in workbench-live root): § "Why orchestration is centralized" — extend with "the workbench root is the integration target. Live runs live in worktrees. The auto-merge from `complete`/`abandon` is the archival path that delivers runs onto master."
- `agent-workbench-live/AGENTS.md`: § "Source of truth" — add: "The run dir's physical location is inside the worktree until `complete`/`abandon`; on master after. `metadata.yaml`'s `target.worktree.path` is the canonical pointer."

## Files likely to change

- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/runs.py` (new)
- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/metadata.py`
- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/repos.py`
- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/cli/cmd_new_run.py`
- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/cli/cmd_start.py`
- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/cli/cmd_complete.py`
- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/cli/cmd_abandon.py`
- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/cli/cmd_doctor.py`
- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/metrics/rollup.py`
- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/board/source.py`
- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/board/snapshot.py`
- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/board/app.py`
- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/cli/cmd_board.py`
- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/cli/cmd_list_runs.py`
- `agentic-development-task-system-v3__ai/agent-workbench-live/tests/test_e2e.py`
- `agentic-development-task-system-v3__ai/agent-workbench-live/tests/test_runs.py` (new)
- `agentic-development-task-system-v3__ai/agent-workbench-live/tests/test_self_modifying.py` (new) **or** extension of test_e2e.py
- `agentic-development-task-system-v3__ai/agent-workbench-live/tools/migrate_orphan_runs.py` (new, run-then-delete)
- `agentic-development-task-system-v3__ai/agent-workbench-live/AGENTS.md`
- `agentic-development-task-system-v3__ai/architecture.md`
- `agentic-development-task-system-v3__ai/docs/lifecycle.md`

## Data model changes

No schema changes required. The existing `metadata.target.worktree.path` and `target.worktree.created` fields are sufficient. We extend their semantics: today they're populated only at `/start`; after A1 they're populated at `/new-run`. The board's `RunSnapshot` gains a `source: str` field (in-memory only; not persisted).

`schemas/run-metadata.yaml` is unchanged.

## UI changes

The board's static + Textual renderers append `(archived)` after run ids whose `source == "master"` and status is `done`/`abandoned`. Width budget: 10 characters; current card layout has room. No change to compact mode (the source is implied by the column already).

`doctor` gains an `orphans:` section. ASCII-only.

`complete`/`abandon` stdout gains an extra line:

```
runs: <run_id> (complete): committed pre-merge as <sha>
```

(or `(no run-dir changes to commit)` when the step is a no-op.)

## Test plan

### Unit

- `tests/test_runs.py`: `find_run` (resolves across worktrees, raises on collision, raises on not-found), `iter_all_runs` (dedup with stderr warning, yields master-source + worktree-source), `is_self_modifying` helper.
- `tests/test_metadata.py`: extend the existing `list_runs` test to assert it now includes both master-side archived runs and worktree-side live runs.
- `tests/test_repos.py` (or extend): new `stage_and_commit_run_dir` helper — fixture worktree with uncommitted run-dir contents, assert it returns a SHA; no-op case (clean run dir) returns None; failure case (run-dir path doesn't exist inside worktree) raises `RepoError`.

### E2E

- `tests/test_e2e.py` `TestE2EHappyPath` — existing assertions update to look up run-dir via metadata (forward-compatible: the test target repo is not self-modifying, so run dir stays at `self.tmp / "runs" / run_id`). Add post-`complete` assertion that master's `git status --porcelain` of `self.tmp` (the workbench tmp root, treated as a git repo even though it isn't normally one) doesn't apply — we'd need a self-modifying test for that. Defer the strict master-clean assertion to the new self-modifying scenario.
- `tests/test_e2e.py` `TestE2EBounceLoop` — same metadata-driven run-dir lookup; otherwise unchanged.
- New `TestE2ESelfModifying`:
  - Initialize `self.tmp` as a git repo (init, initial commit on `main`).
  - Two parallel runs created with `--repo-path = self.tmp`. Drive both through to `human_review` independently (interleaved CLI calls).
  - Between every CLI call: assert `git status --porcelain` on `self.tmp` is empty of `runs/` entries.
  - `complete` run-1: assert master gets a merge commit; run-1's `runs/<id>/` is present on master (tracked).
  - `complete` run-2: same; master stays clean throughout.
  - `board --static --all` includes both runs; the two are present with `(archived)` labels.

### Manual

A scripted `tests/manual/two_parallel_runs.sh` is overkill; manual testing for this run will be:

1. After build, on the implementation branch, run `agent-workbench new-run --repo-path <this monorepo> --worktree-name try-it --idea-file <tiny-idea.md>`. Assert master's `git status` is clean of `agent-workbench-live/runs/` entries. Inspect the new worktree; the run dir is there.
2. `agent-workbench shape try-it` (etc.) through to `validate`. Master stays clean each step.
3. Optional: run `agent-workbench board --static --all` and confirm both this run and existing archived runs show up.
4. `agent-workbench doctor` reports zero orphans (run on a fresh checkout after migration script has run).

## QA plan

See the brief's QA-1 through QA-11. The full set will live in `qa/commands.txt` and `qa/report.md` once we hit validate. For this plan we record:

- QA-1: covered by manual step 1.
- QA-2: covered by manual steps 2-3.
- QA-3: covered by `TestE2EHappyPath` (existing) + new self-modifying scenario assertion.
- QA-4: covered by new self-modifying scenario (abandon at validating state).
- QA-5: covered by new `TestE2ESelfModifying` (two parallel runs).
- QA-6: covered by extending one of the existing scenarios to inspect a board static render after `complete`.
- QA-7: covered by `test_runs.py` collision case + a manual board run on the implementation branch.
- QA-8: covered by C3 migration step + manual `doctor` run.
- QA-9: covered by `test_runs.py`.
- QA-10: covered by E2E suite (no regressions).
- QA-11: `pytest tests/ -q` — full suite green.

## Risks

- **R1: `metadata.run_dir` resolution becomes file-I/O-dependent.** Today it's a pure-path computation; the new version reads `metadata.yaml` (or accepts an already-loaded dict). This is fine for our scale (tens of runs, hundreds of calls per CLI invocation), but every code path that takes `cfg + run_id` and computes a path will now do a small disk read. Mitigation: callers that already have `meta` in hand pass it through; helpers cache the result for the duration of a CLI call.
- **R2: Watchdog observer needs multiple watch roots.** If the board's first launch sees only master's `runs/`, runs created in other worktrees won't push live updates. The 1Hz fallback covers this with ~1s latency. Acceptable for V1; documented.
- **R3: `git worktree add` at `new-run` time changes the failure surface.** Today, `/new-run` succeeds even for repos whose `base_ref` resolves but where worktree creation would fail (e.g. a stale worktree dir on disk from a previous run). With A1 those failures move from `/start` to `/new-run`. Net better — the human gets the error earlier — but more error paths exist before any metadata is written. Mitigation: `new-run` writes metadata only after `git worktree add` succeeds (no partial state).
- **R4: Existing non-merge `abandon` semantics change.** Today, `abandon` is a metadata-only state change; nothing merges. After A5, `abandon` archives the run dir onto master. Risk: some external consumer relies on the "abandon leaves no trace" property. Mitigation: brief explicitly mandates this behavior (Acceptance #4); no known external consumer.
- **R5: Self-modifying vs unrelated-repo code path divergence.** The pre-merge commit only runs for self-modifying runs. This is two code paths inside one function — risk of bit-rot. Mitigation: feature-flag-like branch via `runs.is_self_modifying(cfg, meta)`, single helper consumed by both `cmd_complete` and `cmd_abandon`. Future runs that touch this code will see one decision point, not two.
- **R6: Migration script atomicity.** Moving the two known orphans is a `shutil.move` that's not atomic across mount boundaries. Mitigation: both source and destination are inside the user's `~/GitHub/`, same mount. No atomicity concern in practice.
- **R7: Tests' temp workbench is not a git repo today.** The new self-modifying scenario needs to init `self.tmp` as a git repo. Risk: the existing `make_tmp_workbench` helper may interact poorly with a git init. Mitigation: confirm during implementation; worst case, the new scenario uses a separately-prepared git repo as the workbench.

## Definition of done

- All A1-A5 implementation tasks landed.
- All B1-B3 implementation tasks landed.
- All C1-C4 implementation + test + migration tasks landed.
- `pytest tests/ -q` is green (existing scenarios pass; new scenarios pass).
- `agent-workbench doctor` reports zero orphans on master after the migration script runs.
- Manual smoke (steps 1-4 in test plan) passes on a fresh workbench checkout.
- All eleven brief-level acceptance criteria are demonstrably true (each tied to either a test or a manual step).
- `validate` completes; review.md + QA report exist; landing is `human_review`.
- HUMAN_REVIEW.md is filled out with branch, commit SHA, full diff, per-artifact links.

## Preflight

- **repo_path**: `/Users/timothy.shee/GitHub/new-tech-monorepo`
- **repo_name**: `new-tech-monorepo`
- **base_ref**: `HEAD` (resolves to `master`)
- **branch_name**: `agent/each-worktree-owns-its-own-run-dir`
- **worktree_name**: `each-worktree-owns-its-own-run-dir`
- **worktree_path**: `~/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/new-tech-monorepo/20260525__each-worktree-owns-its-own-run-dir`

Checks:

- ✅ Workbench checkout is up-to-date with master (most recent commit `bcc5a6b`, the prior fix-generated-lines run merged in).
- ✅ Two known orphan run dirs exist on master (verified: `runs/2026-05-24-fix-generated-lines-base-ref-head/` and `runs/2026-05-24-token-efficiency-pass-2/`). Both have `metadata.target.worktree.path` populated; the migration script can use them directly.
- ⚠️ Both orphan dirs have existed in master's working tree for ~1 day. They're not blocking this run but should be migrated as part of C3.
- ✅ `git worktree list` shows only master today.
- ✅ Python version: Python 3.x available (CLI is stdlib + `textual`/`watchdog` for board). No new deps.
- ⚠️ Watchdog `Observer.schedule` may not handle the worktree set dynamically; verify during implementation. Fallback (1Hz timer) is acceptable.
- ✅ Test framework: unittest + pytest harness exists. New tests fit the same patterns.

## Decisions & assumptions

### DR-001
- **Decision**: Detect self-modifying runs (workbench is inside the target repo) via a runtime helper `runs.is_self_modifying(cfg, meta)`. Non-self-modifying runs keep today's "run dir in `cfg.runs_path`" behavior.
- **Rationale**: The bug only manifests when the workbench IS the target repo's content. For unrelated product repos, the run dir lives in the workbench checkout's master and that's correct.
- **Alternatives considered**: (a) Always put the run dir inside the worktree, regardless of repo. (b) Always put it in master. (c) Add a config flag.
- **Why not the alternatives**: (a) would put run dirs in unrelated product worktrees, polluting their working trees and breaking the contract that workbench artifacts don't touch product repos. (b) is today's broken behavior. (c) adds knobs nobody needs to turn — the right answer is computable.

### DR-002
- **Decision**: `find_run` is strict (raises on collision); `iter_all_runs` is permissive (prefers worktree, warns).
- **Rationale**: Single-run mutations need certainty; the board needs to render even when on-disk state is messy.
- **Alternatives considered**: Always strict; always permissive.
- **Why not the alternatives**: Always strict breaks the board for cosmetic on-disk weirdness. Always permissive risks writing to the wrong copy in a transition.

### DR-003
- **Decision**: `abandon` archives the run dir on master via a non-merge tree copy (`git read-tree` / `git archive`), NOT a `git merge` of the agent branch.
- **Rationale**: Abandoning means the code work is discarded. Merging the agent branch would pull the work into master alongside the audit trail. Tree-copy isolates the run-dir delivery from the code-changes-delivery.
- **Alternatives considered**: Merge-then-revert; merge-into-subtree; pure metadata transition with no master delivery.
- **Why not the alternatives**: Merge-then-revert clutters history. Subtree merge is for external repos. Pure metadata is what we have today and the brief's acceptance criterion explicitly requires master to have the abandoned run dir.

### DR-004
- **Decision**: The migration script (`tools/migrate_orphan_runs.py`) is run-then-deleted as part of this run's build phase. It is NOT committed permanently.
- **Rationale**: One-shot tools that solve a one-time data state shouldn't live in the repo forever. The two known orphans are the only orphans; any future orphans should be impossible after A1 lands.
- **Alternatives considered**: Commit and keep; commit then delete in a follow-up; do the migration by hand.
- **Why not the alternatives**: Keeping it is rot. A separate follow-up is bookkeeping the build doesn't need. By-hand is fragile and undocumented.

### DR-005
- **Decision**: No new schema fields in `schemas/run-metadata.yaml`.
- **Rationale**: The existing `target.worktree.path` + `target.worktree.created` already carry the information we need. The board's `source` field is in-memory only.
- **Alternatives considered**: Add a `run_dir_root` field; add a `runs_in_worktree: bool` flag.
- **Why not the alternatives**: Derivable from existing fields. Schema is sacred.

### DR-006
- **Decision**: The pre-merge commit message is `runs: <run_id> (complete)` for completed runs and `abandon: <run_id> (run dir archived)` for abandoned runs.
- **Rationale**: Searchable; consistent with existing convention (`runs: <id>` family of commit messages in the LOG).
- **Alternatives considered**: A single shared format; descriptive prose; an empty message.
- **Why not the alternatives**: Differentiating complete/abandon helps grepping history. Prose drifts. Empty messages are noise.

### DR-007
- **Decision**: Board watchdog stays on a single `cfg.runs_path` observer + 1Hz fallback timer. Worktree-side watch roots are not added in V1.
- **Rationale**: Build complexity vs. user pain trade-off — 1Hz fallback gives ~1s latency on cross-worktree file changes, which is fine.
- **Alternatives considered**: Dynamic multi-watcher (add/remove observers as worktrees come and go); add at startup but never refresh.
- **Why not the alternatives**: Dynamic is complex. Startup-only misses new runs created mid-session.

### ASM-001
- **Text**: The two known orphan run dirs (`2026-05-24-fix-generated-lines-base-ref-head/`, `2026-05-24-token-efficiency-pass-2/`) have valid `metadata.target.worktree.path` pointing at existing worktrees on disk.
- **Reason**: Both have completed their lifecycle and their worktrees were created normally by `/start` against the workbench monorepo path.
- **Impact**: medium — if untrue, the migration script will fail loudly and need a manual fallback. Verify at build start.

### ASM-002
- **Text**: `git worktree list --porcelain` lists every workbench worktree from any of its working copies, including master's.
- **Reason**: All worktrees share the same `.git` admin directory; the porcelain output is consistent across CWDs.
- **Impact**: high — `find_run`'s enumeration depends on this. Verify by running `git worktree list` from each worktree before relying on it.

### ASM-003
- **Text**: `git worktree add -b <branch> <path> <base_ref>` is safe to run while the workbench is mid-tick (e.g. another CLI command is running). No global lock is needed beyond what `lib/locks.py` already provides per-run.
- **Reason**: Today's `cmd_start` already calls this at human-driven cadence; no race observed.
- **Impact**: low — even if a race exists, the failure mode is a `RepoError` on the second concurrent worktree add, which we already handle.

### ASM-004
- **Text**: The workbench checkout path inside any worktree is at the same relative subpath as in master (`agentic-development-task-system-v3__ai/agent-workbench-live/`).
- **Reason**: Worktrees are checkouts of the same monorepo; the workbench dir is part of the tracked tree.
- **Impact**: high — A4's pre-merge commit depends on this. Verify by inspecting one of the existing worktrees.

### ASM-005
- **Text**: Removing a worktree's run dir during `complete`/`abandon` is safe because the worktree itself is removed shortly after; nothing else holds a path into `runs/<id>/`.
- **Reason**: Lifecycle ends here; no further reads after the merge.
- **Impact**: low — defensive logging if a stale handle is somehow held.

### ASM-006
- **Text**: The `agent-workbench-live/AGENTS.md` "Source of truth" section is the right place to record the new run-dir-location rule, and downstream tooling reads conventions from there.
- **Reason**: Other lifecycle rules already live there.
- **Impact**: low — cosmetic.

### ASM-007
- **Text**: Existing tests in `tests/test_e2e.py` use a target repo distinct from `self.tmp` (the workbench), so today's behavior (run dir at `self.tmp / "runs" / run_id`) is correct for them and remains correct after this change.
- **Reason**: `_repo()` returns a fresh tmp dir; `--repo-path` points there.
- **Impact**: medium — if untrue, the existing assertions will fail and need rewrites. Confirmed by reading lines 50-65 and 120-139 of `test_e2e.py`.

### ASM-008
- **Text**: For the new self-modifying E2E scenario, initializing `self.tmp` as a git repo (with `bin/` and `lib/` populated from `ROOT/`) plus a tracking commit will produce a valid workbench-as-target setup.
- **Reason**: The only thing self-modifying needs is `cfg.root` to be inside `target.repo.path`. `self.tmp` is the workbench root; `--repo-path = self.tmp` makes that true.
- **Impact**: medium — if `make_tmp_workbench` does something that breaks `git init`, the test scaffolding needs an adapter. Verify during C1 implementation.

### ASM-009
- **Text**: No external CI / consumer depends on `runs/<id>/` paths in master's working tree being untracked.
- **Reason**: They're untracked today; nothing references them. The merge-on-complete that already exists is the contract for "runs eventually arrive on master via merge".
- **Impact**: low.

### ASM-010
- **Text**: `lib/board/app.py` is the only file that schedules a watchdog observer; nothing else watches `cfg.runs_path` for filesystem events.
- **Reason**: One observer in one place; grep confirms.
- **Impact**: low.
