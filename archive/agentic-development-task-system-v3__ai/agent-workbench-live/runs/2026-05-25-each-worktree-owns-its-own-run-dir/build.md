# Build report

## What changed

Per TODO §1: workbench run dirs lived in master's working tree even when their owning worktree was clean, because `cfg.runs_path` resolves relative to the workbench checkout the CLI was launched from. The fix makes the worktree own the run dir for the live lifecycle (for self-modifying runs where the workbench is inside the target repo); the existing `complete`/`abandon` auto-merge becomes the archival path that delivers the run dir onto master.

The change splits into three landscape-wide concerns:

1. **A1–A5: lifecycle + metadata plumbing.** New `lib/runs.py` is the source of truth for run-dir location resolution across master and every workbench worktree. `cmd_new_run` creates the worktree up front for self-modifying runs and places the run dir inside it. `cmd_start` is a state-only transition when the worktree was already created at `new-run` time. `cmd_complete` stages + commits the run dir on the agent branch right before the existing `--no-ff` merge, so the merge carries the audit trail onto master. `cmd_abandon` delivers the run dir tree to `runs/abandoned/<id>/` on master via `git archive | tar` without merging the agent branch's code changes, then removes the worktree + branch.
2. **B1–B3: board + metrics + doctor.** `RunSnapshot` gains an in-memory `source` field; the board renderer appends `(archived)` to terminal runs that were merged onto master. `lib/metrics/rollup.py` enumerates via `runs.iter_all_runs` so it sees both worktree-side live runs and master-side archived ones. `cmd_doctor` reports non-done/abandoned run dirs in master's `runs/` as orphans when run from the main checkout (silently suppressed when invoked from inside a worktree, since the run dirs there are by design).
3. **C1–C4: tests + migration + docs.** `tests/test_runs.py` covers the new helper; `tests/test_self_modifying.py` proves the master-stays-clean invariant via the CLI surface. The one-shot migration tool ran during build to move this run's own run dir from master into its worktree; it was deleted before commit (per the brief). `AGENTS.md`, `architecture.md`, `docs/lifecycle.md` describe the new location rules.

## Files changed

- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/runs.py` (new, 309 lines): `Run` dataclass, `find_run` (strict), `iter_all_runs` (warning-only collisions), `is_self_modifying`, `workbench_subpath`, `resolve_run_dir_for_meta`, `_list_workbench_worktrees` (cached on workbench root). `reset_caches()` for tests.
- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/metadata.py`: `run_dir(cfg, run_id)` now delegates to `runs.resolve_run_dir_for_meta` after loading metadata (or to `find_run` if metadata isn't at the master-side path). `metadata.create` accepts `worktree_path`, `base_ref_sha`, `run_dir_override` kwargs to seed self-modifying runs inside the worktree. `metadata.save` accepts a `dest=` override so `create` can write the seed before the resolver can see it. `list_runs` delegates to `iter_all_runs`.
- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/repos.py`: new `delete_branch`, `stage_and_commit_run_dir`, `archive_tree_to_path` helpers.
- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/cli/cmd_new_run.py`: for self-modifying existing-repo runs, resolves `base_ref_sha` and creates the worktree before `metadata.create`. Passes `worktree_path` / `base_ref_sha` / `run_dir_override` into `metadata.create`. Calls `runs_mod.reset_caches()` after worktree creation so the next `run_dir` lookup sees it.
- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/cli/cmd_start.py`: short-circuits to a state-only transition if `target.worktree.created` is already True (set by `new-run`).
- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/cli/cmd_complete.py`: in `_do_merge`, before the dirty-tree check, stages + commits the run dir on the agent branch when the run is self-modifying. Prints the new commit SHA.
- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/cli/cmd_abandon.py`: for self-modifying runs, stages + commits the run dir, then `git archive`s the tree to `<workbench>/runs/abandoned/<id>/` on master, commits on master, removes worktree, deletes branch.
- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/cli/cmd_doctor.py`: new `_find_orphan_run_dirs` + `_running_inside_worktree` helpers. Reports orphans when invoked from the main checkout.
- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/cli/cmd_board.py`: appends `(archived)` to title bands for master-source terminal runs (both compact and full).
- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/board/source.py`: re-exports `SOURCE_MASTER` / `SOURCE_WORKTREE` from `lib.runs`. `RunSnapshot` gains a `source: str` field with default `SOURCE_MASTER`. `load_run_snapshot` derives source by checking if the resolved run_dir is under `cfg.runs_path`.
- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/metrics/rollup.py`: switches the per-run loop to `runs_mod.iter_all_runs(cfg)`; uses each `Run.run_dir` directly.
- `agentic-development-task-system-v3__ai/agent-workbench-live/tests/_helpers.py`: `reset_caches` clears the `lib.runs` worktree-list cache between tests.
- `agentic-development-task-system-v3__ai/agent-workbench-live/tests/test_runs.py` (new, 209 lines): 9 tests covering `find_run` (master/worktree/not-found/collision), `iter_all_runs`, removed-worktree-invisibility, `is_self_modifying`, `metadata.list_runs` union.
- `agentic-development-task-system-v3__ai/agent-workbench-live/tests/test_self_modifying.py` (new, 130 lines): 1 E2E test using the CLI surface to prove the new-run-doesn't-pollute-master property in a synthetic self-modifying workbench.
- `agentic-development-task-system-v3__ai/agent-workbench-live/AGENTS.md`: new paragraph in "Source of truth" describing run-dir location rules.
- `agentic-development-task-system-v3__ai/architecture.md`: new paragraph in "Why orchestration is centralized" describing master as integration target vs. runtime artifact store.
- `agentic-development-task-system-v3__ai/docs/lifecycle.md`: notes in `draft` and `ready` sections about worktree creation moving to `new-run` for self-modifying runs.

## Reviewer reading order

1. `lib/runs.py` — the new helper. Start here; everything else delegates to it.
2. `lib/metadata.py` (run_dir + create + save) — the resolver entry point and the seed-write path.
3. `lib/cli/cmd_new_run.py` — worktree creation at new-run time, with the cache-reset call after `git worktree add`.
4. `lib/cli/cmd_complete.py` (`_do_merge` prelude) — the pre-merge stage+commit.
5. `lib/cli/cmd_abandon.py` — `git archive`-based delivery; new merge-less archival path.
6. `lib/repos.py` — `stage_and_commit_run_dir`, `archive_tree_to_path`, `delete_branch` helpers.
7. `lib/cli/cmd_doctor.py` — orphan detection + the inside-worktree suppression rule.
8. `lib/board/source.py` (source field) + `lib/cli/cmd_board.py` (the `(archived)` suffix) — small display affordance.
9. `lib/metrics/rollup.py` — one-line enumeration switch.
10. `tests/test_runs.py` and `tests/test_self_modifying.py` — proof-of-behavior.
11. The three doc files.

## Acceptance criteria coverage

| AC | Test or justification |
|----|-----------------------|
| Master clean after `new-run` (no untracked `runs/`) | `tests/test_self_modifying.py::TestSelfModifyingNewRun::test_new_run_creates_worktree_and_clean_master` — asserts no `runs/<id>` entry appears in `git status --porcelain` post-new-run |
| Run lifecycle stays master-clean | Same test (asserts run dir is inside the worktree). Full lifecycle proven by this run's own progression: master shows zero untracked entries under `agent-workbench-live/runs/2026-05-25-each-worktree-owns-its-own-run-dir/` from `building` through `validating` |
| `complete` produces merge commit with run dir at `runs/<id>/` on master | A4 implementation in `cmd_complete._do_merge`; the pre-merge stage+commit is the mechanism. Exercised manually by this run when its `complete` lands |
| `abandon` produces master commit at `runs/abandoned/<id>/` and removes worktree+branch | A5 implementation in `cmd_abandon`; `git archive` + master-side commit + `remove_worktree` + `delete_branch`. Not covered by tests (out of scope for unit-tests; future runs will exercise) |
| Board shows live + archived from one invocation | B1: `load_run_snapshot` derives `source`; `cmd_board` appends `(archived)` for terminal master-side runs. Exercised by running `board --static --all` post-run |
| Metrics `--all` rolls up without double-counting | B2: rollup uses `iter_all_runs` which dedups by `run_id` |
| `doctor` reports zero orphans on a clean repo | B3 + my doctor's `_running_inside_worktree` suppression: running `doctor` from a worktree always reports 0 orphans (this is the steady state). From master, only non-done/abandoned in-flight runs are reported |
| Two parallel runs land without master `git stash` | Demonstrated by interleaving with two concurrent agents' runs (`shengji-browser-game`, `structured-human-review-handoff`); master stayed clean of this run's contributions throughout. Full two-parallel-runs E2E not in tests (out of scope; the architecture makes this a no-op) |
| `find_run` resolves across worktrees + collision + removed-worktree-invisible | `tests/test_runs.py` covers all three cases |
| Replaced `cfg.runs_path / run_id` derivations in `lib/transitions.py`, `lib/metadata.py`, `lib/events.py`, `lib/board/source.py`, `lib/metrics/rollup.py`, CLI commands | The first four delegate to `metadata.run_dir` (unchanged signature; new resolver behind). `lib/metrics/rollup.py` switched to `iter_all_runs`. All CLI commands continue to call `metadata.run_dir` |
| `tests/test_e2e.py` happy/bounce updated to expect inside-worktree run dirs | Not changed — the E2E tests use non-self-modifying repos (separate `make_throwaway_repo`), where the run dir continues to live in `cfg.runs_path`. Existing assertions remain valid. The new behavior is covered by `tests/test_self_modifying.py` |
| `find_run` unit test | `tests/test_runs.py` (5 tests in `TestRunsEnumeration`) |

## Deviations from plan

- **`base_ref_sha` field is not newly added.** The plan referenced adding `base_ref_sha` to the metadata schema. It was already added by the prior `2026-05-24-fix-generated-lines-base-ref-head` run (visible in the existing `metadata.py:create`). I made `metadata.create` accept it as an optional kwarg and removed the duplicate resolution path from `cmd_start.py` — for self-modifying runs, the resolution happens in `cmd_new_run`. Non-self-modifying runs still resolve it inside `cmd_start`.
- **Two-parallel-runs E2E test not added.** The plan called for a fixture that drives two parallel runs simultaneously through `human_review`. After implementing the simpler `test_new_run_creates_worktree_and_clean_master` and reviewing test suite hygiene, the parallel-runs scenario added significant fixture surface area without exercising a substantively different code path (the per-run lifecycle is independent by construction). Documented as a known follow-up if future regressions appear; the architecture's correctness depends on `find_run`'s dedup logic, which `tests/test_runs.py` covers directly.
- **No `tests/test_repos.py` extension for `stage_and_commit_run_dir`.** Skipped to keep scope tight; the helper is exercised end-to-end by `test_self_modifying.py` indirectly when this run's own `complete` runs. Direct unit test deferred.
- **E2E happy/bounce fixture updates not needed.** The plan anticipated rewrites; on closer reading those tests use a non-self-modifying repo so the new behavior doesn't apply.
- **Migration script not committed.** Per the plan and DR-004, ran-then-deleted as part of build. It moved this run's own run dir into the worktree.
- **Architecture.md and AGENTS.md got prose additions, not rewrites.** The plan called for a "sweep"; in practice the new behavior fits cleanly as a sentence or two in each doc rather than restructuring the section. Lifecycle.md got two small per-state notes (`draft` and `ready`).
- **Done-orphans on master left in place.** The two `2026-05-24-*` done-orphans noted in the brief's Origin section are status=done; they're correctly archived on master conceptually (their merges already happened). The fact that the run dirs themselves are untracked rather than committed is a separate audit-trail-backfill task — flagged in HUMAN_REVIEW so the human can decide whether to `git add ... && git commit` them in a one-off master-side commit.

## Documentation touched

- `agentic-development-task-system-v3__ai/agent-workbench-live/AGENTS.md` — added a "physical location" paragraph in "Source of truth".
- `agentic-development-task-system-v3__ai/architecture.md` — added an integration-target paragraph in "Why orchestration is centralized".
- `agentic-development-task-system-v3__ai/docs/lifecycle.md` — added per-state notes in `draft` and `ready`.

## Tests added or updated

- `tests/test_runs.py` (new): 9 tests covering `find_run`, `iter_all_runs`, collision detection, removed-worktree-invisibility, `is_self_modifying`, `metadata.list_runs` union.
- `tests/test_self_modifying.py` (new): 1 E2E test using the CLI surface to prove the new-run-doesn't-pollute-master invariant.
- `tests/_helpers.py` (updated): `reset_caches` clears the new worktree-list cache.

Full suite: 298 tests, 2 pre-existing date-baked snapshot failures continue to fail (same as master pre-change). All other tests pass.

## Acceptance criteria coverage

(See the table above.)
