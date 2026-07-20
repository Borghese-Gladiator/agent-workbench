# Brief

## Goal

Make the workbench's run directory live inside the worktree that's executing the run, not in master's working tree. Today the workbench creates `runs/<id>/` relative to the checkout the CLI happens to be launched from, so run artifacts land in master even when their owning worktree is clean. The fix: create the worktree at `new-run` time and place the run dir inside it, and use the existing `complete`/`abandon` auto-merge as the archival path that delivers the run dir onto master. Master only sees a `runs/<id>/` when the merge brings it there.

## User-facing behavior

- `agent-workbench new-run --repo-path R --worktree-name S --idea-file F`: creates the worktree first, then writes `runs/<id>/` inside that worktree. `metadata.target.worktree.path` and `created: true` are populated immediately. `git status` on master shows zero untracked workbench-runs entries afterward.
- `agent-workbench start <id>`: a state-only transition (`ready → building`). It does not create the worktree (already created) and does not create the branch (the branch is created by `new-run` as part of `git worktree add`). Existing dirty-tree / clean-tree safety checks remain.
- `agent-workbench complete <id>`: before the existing auto-merge of the agent branch into the run's parent ref (today `master`), the run dir is staged and committed on the agent branch with a deterministic message (`runs: <run_id> (complete)`) if anything in `runs/<id>/` is uncommitted. The merge then carries the run dir onto master as part of the same `--no-ff` merge.
- `agent-workbench abandon <id>`: same pre-merge commit of the run dir on the agent branch, but the merge places the run dir at `runs/abandoned/<id>/` on master (separate subtree). Worktree and branch are removed after the merge. Master keeps the postmortem material without polluting live `runs/`.
- `agent-workbench board`: shows live runs (from every workbench worktree's `runs/`) and archived runs (from master's `runs/` + `runs/abandoned/`) together. Live and archived rows are visually distinguishable (e.g. an `(archived)` suffix or column).
- `agent-workbench metrics --all`: rolls up across both live worktrees and archived runs without double-counting.
- `agent-workbench doctor`: reports zero orphans on a clean repo. If a `runs/<id>/` dir exists in master's working tree whose status is anything other than `done` or `abandoned`, it's printed as a warning with a suggested fix.
- A one-shot `tools/migrate_orphan_runs.py` exists temporarily, moves the two known orphans on disk (`2026-05-24-fix-generated-lines-base-ref-head/`, `2026-05-24-token-efficiency-pass-2/`) into their owning worktrees, then is deleted as part of this run.

## Acceptance criteria

- After `agent-workbench new-run …` on master, `git status` shows no untracked entries under `agent-workbench-live/runs/`. The new run dir lives inside its worktree at `<worktree>/agent-workbench-live/runs/<id>/`.
- A run advances through `draft → shaping → planning → ready → building → validating → human_review → done` with master's working tree staying clean the entire time.
- `agent-workbench complete <id>` produces a merge commit on master whose tree contains the run dir at `agent-workbench-live/runs/<id>/` with full artifacts (brief, plan, build summary, QA report, HUMAN_REVIEW.md, audit.md, events.jsonl).
- `agent-workbench abandon <id>` produces a merge commit on master whose tree contains the run dir at `agent-workbench-live/runs/abandoned/<id>/`. The worktree and agent branch are gone.
- `agent-workbench board` shows live + archived runs from one invocation, visibly distinguishable.
- `agent-workbench metrics --all` rolls up across worktrees + master without double-counting (each `run_id` appears once).
- `agent-workbench doctor` reports zero orphans after migration of the two known dirs.
- Two parallel runs can land their feature branches into master without ever needing `git stash` on master.
- A `find_run(cfg, run_id) → Run` helper exists in `lib/runs.py` (or extended `lib/metadata.py`) that resolves a run by id across master and every workbench worktree. Collisions raise with both paths in the message.
- The existing `cfg.runs_path / run_id` derivations in `lib/transitions.py`, `lib/metadata.py`, `lib/events.py`, `lib/board/source.py`, `lib/metrics/rollup.py`, and CLI command modules are replaced by either a `find_run` lookup (single-run path) or a shared enumeration helper (multi-run reads).
- `tests/test_e2e.py` `happy/` and `bounce_pass2/` fixtures are updated to assert run dirs live inside the worktree, and a new fixture drives two parallel runs to completion and asserts no master pollution along the way.
- A `find_run` unit test pins the enumeration, the collision behavior, and the "worktree removed → run becomes invisible" behavior.

## Non-goals

- A registry file or central index of runs. `git worktree list` is authoritative — the union-of-worktrees enumeration is the index.
- Runs that exist outside a worktree. The lifecycle now requires a worktree from `new-run` onward.
- Changes to `target.repo.path` or any product-repo-side path machinery. This is about workbench run-dir location, not product-repo location.
- Migrating already-merged historical runs that are already on master. They're correct where they are.
- Preventing the human from manually editing files inside a run dir within a worktree. `metadata.yaml` editing remains gated by the transition engine; everything else stays open.
- Auto-cleanup of long-lived `runs/abandoned/<id>/` entries on master. They stay until the human deletes them.
- A separate "garbage collection" command for orphans. `doctor` only reports; the human fixes.

## Good examples

- A fresh `new-run` on master: `git worktree add` creates the worktree at the configured path; `metadata.yaml` is written with `target.worktree.path` populated and `created: true`; the run dir is created at `<worktree>/agent-workbench-live/runs/<id>/`; master's `git status` is clean of any `runs/` entries.
- `complete` on a run that has uncommitted artifacts in `runs/<id>/` inside the worktree: the run dir is staged and committed on the agent branch with a deterministic message; the existing `--no-ff` merge carries the dir onto master; after the merge, master's `runs/<id>/` contains the full artifact set.
- `abandon` on a `building` run: same pre-merge commit; merge writes the tree at `runs/abandoned/<id>/`; worktree + branch removed.
- `board` invocation: enumerates master's `cfg.runs_path` plus every workbench worktree's `runs/`; deduplicates by `run_id`; on collision, prefers the worktree's copy and prints a warning to stderr.
- `doctor` invocation right after the buggy untracked dirs are migrated: zero warnings printed.

## Bad examples

- A registry file in master listing all worktrees and their run ids. Out of scope — `git worktree list` is the index.
- Resolving the run dir via a regex on path components like `re.match(r".*/runs/([^/]+)/?$", path)`. Use the `Run.run_dir` value object explicitly.
- Putting the abandon archival at the same path as a completed run's archival (`runs/<id>/`). They must live at different subtrees on master (`runs/<id>/` vs `runs/abandoned/<id>/`) so the directory shape carries the lifecycle terminal-state.
- Doing the run dir staging-and-commit inside `cmd_complete.py` as a free-floating shell call. Use the existing git plumbing (whatever `lib/git_*.py` helpers exist) so the path is testable.
- A migration script that survives the run. `tools/migrate_orphan_runs.py` is one-shot — created, run, deleted, all as part of this run.

## Constraints

- `metadata.yaml` is the canonical source for the run dir's location once the run exists. Every consumer reads `target.worktree.path` to derive `<worktree>/agent-workbench-live/runs/<run_id>/`, not CWD-relative paths.
- Backwards-compatible reads. Historical runs already merged into master continue to have their `runs/<id>/` at the master-relative path. The board's union enumeration must include them. `metadata.yaml` schema additions, if any, are optional fields.
- `cmd_start.py` no longer calls `git worktree add`. Branch creation, however, already happens as part of `git worktree add -b <branch> <path> <base_ref>` inside `new-run` — the branch is created at worktree creation time, not at start time.
- The `complete`/`abandon` pre-merge commit must be a no-op if the run dir is already clean on the agent branch. The deterministic commit message (`runs: <run_id> (complete)` / `runs: <run_id> (abandon)`) is only used when something needs to be staged.
- If the worktree has unrelated uncommitted changes, the existing dirty-tree refusal in `complete`/`abandon` continues to refuse. The pre-merge commit step doesn't bypass that.
- `find_run` collision is a hard error (exception), not a warning, because every subsequent op is ambiguous. The board's enumeration helper is the place that downgrades collisions to "prefer worktree, warn on stderr" because the board is a read-only view.

## Assumptions

- ASM-1: `git worktree add` accepts `-b <branch>` to create the branch at worktree creation time. (Verified by current `cmd_start.py` calling it.)
- ASM-2: The workbench root is identifiable from the CLI runtime — the binary at `bin/agent-workbench:17-22` already resolves it. Worktrees of the workbench share that root via `.git` files pointing at the same `.git/worktrees/<name>` admin directory.
- ASM-3: `git -C <workbench-root> worktree list --porcelain` lists master + every active worktree, regardless of which checkout the CLI was launched from. (Verified by current behavior.)
- ASM-4: The agent branch's tip after `building → validating → human_review` does not include the run dir as a committed file (today the run dir is in master's working tree, untracked). The pre-merge commit step in `complete`/`abandon` is what first commits it onto the agent branch.
- ASM-5: `complete` today uses `--no-ff` and produces a single merge commit. Adding a pre-merge commit on the agent branch does not change the merge strategy.
- ASM-6: There is no existing global lock between workbench commands. Two simultaneous `complete` calls on different runs could race on master's index. Today they already could; this run doesn't worsen that. (Out of scope for this run; will document as a known limitation.)
- ASM-7: The two known orphans on disk today (`2026-05-24-fix-generated-lines-base-ref-head/`, `2026-05-24-token-efficiency-pass-2/`) have valid `metadata.target.worktree.path` values pointing at their owning worktrees on disk. (Plan stage will verify.)
- ASM-8: There is no existing CI or external system reading `runs/<id>/` paths on master under the old behavior. Moving them does not break a published contract.
- ASM-9: `lib/board/source.py` is the only board datasource; `lib/board/app.py` is a pass-through view. The board only needs the source to change.
- ASM-10: `lib/metrics/rollup.py:57-63` is the only rollup enumeration site; per-run metric reads inside that function already use the `metadata.yaml` payload, not paths derived again from `cfg.runs_path`.

## Suggested QA scenarios

- **QA-1 — Master stays clean through new-run.** On a fresh checkout of master, run `agent-workbench new-run …` for a synthetic run. Assert `git status --porcelain` on master shows zero entries under `agent-workbench-live/runs/`. Inspect the new worktree; the run dir is present there with `metadata.yaml`, `raw-idea.md`, `events.jsonl`, etc.
- **QA-2 — Master stays clean through the full lifecycle.** Drive a synthetic run through `shape → plan → start → (simulate build) → validate → human_review`. After each transition, assert master's `git status --porcelain` shows zero new entries.
- **QA-3 — Complete merges the run dir onto master.** Run `complete` on a `human_review` run. Inspect master's working tree after: `agent-workbench-live/runs/<id>/` contains the full artifact set; the run dir is part of the merge commit's tree; `git log --diff-filter=A -- agent-workbench-live/runs/<id>/` shows the merge commit (or the pre-merge commit) as the add point.
- **QA-4 — Abandon archives to `runs/abandoned/<id>/`.** Drive a synthetic run to `validating` then `abandon` it. Inspect master: `agent-workbench-live/runs/abandoned/<id>/` exists with the partial artifact set. No entry at `agent-workbench-live/runs/<id>/`. Worktree and branch are gone.
- **QA-5 — Two parallel runs land cleanly.** Start two unrelated runs (different worktrees, different branches). Drive both to `human_review` independently. `complete` one, then the other. Master never goes dirty in between; both runs end up archived; `agent-workbench board` shows both as done.
- **QA-6 — Board union view.** With one live run (in a worktree) and one archived run (in master after a prior `complete`), `agent-workbench board` shows both. The archived run is visually distinguishable. `board --json` (or the equivalent debug surface) includes both with a `source: worktree` / `source: master` field.
- **QA-7 — Metrics rollup deduplication.** With one in-flight run (worktree) and one archived run with the same `run_id` in master (simulating a stale archive plus a live re-run), `agent-workbench metrics --all` returns one row per `run_id`. The worktree's copy wins. A warning is printed on stderr.
- **QA-8 — Doctor catches orphans before migration.** Before running the migration script, `agent-workbench doctor` warns about the two known orphan dirs on master. After running the migration, `doctor` reports zero orphans.
- **QA-9 — `find_run` resolves across worktrees.** Synthetic tmp workbench with master + two worktrees + one run in each. `find_run(cfg, "id-1")` returns the run from worktree-1; `find_run(cfg, "id-2")` returns the run from worktree-2. Adding a third run on master with the same id as a worktree run raises a collision error citing both paths. Removing worktree-1 from `git worktree list` makes its run undiscoverable.
- **QA-10 — E2E happy + bounce + parallel.** Existing `tests/test_e2e.py` fixtures `happy/` and `bounce_pass2/` pass with assertions updated to expect run dirs inside their worktrees. The new parallel-runs fixture drives two runs end-to-end and passes.
- **QA-11 — Full test suite green.** `pytest tests/` passes. Any unrelated date-baked snapshot drift is documented but does not block.
