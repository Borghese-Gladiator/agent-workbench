# TODO

## 1. Reconcile master-side `metadata.yaml` after `cmd_complete` — kill the stale-`human_review` ghosts

### Symptom

`agent-workbench list` and `agent-workbench board` disagree on the status of runs that have already been merged and marked `done`. For self-modifying runs whose worktree is still on disk, the *worktree-side* `runs/<id>/metadata.yaml` carries the correct post-merge `status: done`, but the *master-side* `runs/<id>/metadata.yaml` is still frozen at `status: human_review` — `cmd_complete` updates only the worktree copy. Both copies coexist because the run dir is a tracked file inside each worktree's checkout.

Concrete pair observed 2026-05-27, both already merged into master:

| Run | master copy | worktree copy | `list` shows | `board` shows |
|---|---|---|---|---|
| `2026-05-25-generalize-stage-context-md` | `human_review` (stale) | `done` (post-merge) | `done` | `human_review` |
| `2026-05-26-board-freshness-across-worktrees` | `human_review` (stale) | `done` (post-merge) | `done` | `human_review` |

Both `list` and `board` traverse the same `iter_all_runs` enumerator, but they apply opposite preferences when the same run resolves to two on-disk copies:

- **`list` (`lib/cli/cmd_list_runs.py:18-20`)** takes the deduplicated run IDs, then re-reads metadata via `metadata.load(cfg, rid)`. `metadata.run_dir` resolves to the worktree copy whenever both exist and the worktree is live (`lib/metadata.py:60-90` → `lib/runs.py:175-198`). The worktree copy says `done`, so `list` prints `done`.
- **`board` (`lib/board/snapshot.py:76-92`)** uses the `Run` objects from `iter_all_runs` directly. `_walk_worktrees` (`lib/runs.py:278-310`) filters out any *worktree* hit whose status is `done` / `abandoned` — treating them as "merged history that happens to be checked out here, NOT live work." The worktree hit is discarded, the master hit (still `human_review`) survives, board shows `human_review`.

The board's filter is right on its own terms; the bug is upstream — the master-side metadata should never be `human_review` for a run that has been completed. Right now the only thing that flips master's copy to `done` is the merge commit itself (the worktree's `done` write is the file that gets merged onto master). For self-modifying runs `cmd_complete` (commit `77a5a13`) does a `git merge --no-ff` followed by an immediate `git worktree remove` + `git branch -D`, but the worktree-side `metadata.yaml` write happened *before* the merge — so master ends up with whichever status the worktree had at the moment of the merge SHA, which for the observed runs was a pre-`done` state.

### Confirmed root cause

`lib/cli/cmd_complete.py`'s self-modifying path writes the worktree-side `metadata.yaml` first (sets `status: done`, populates `completion.accepted_by` / `completion.completion_ref` / `completion.completed_at`), then merges. The merge commit *should* carry that updated file onto master. For the two observed runs, it didn't — likely the worktree-side write landed in a later commit on the branch that wasn't part of the merge ref, or the merge was a fast-forward that picked up an older tree. Either way, master's copy is stale and the workbench has no reconciliation path: nothing in the lifecycle ever rewrites `runs/<id>/metadata.yaml` from master's side after the merge.

Three runs on disk currently sit in this inconsistent state — the two above plus `2026-05-25-each-worktree-owns-its-own-run-dir` and `2026-05-25-lifecycle-papercuts-lock-ready-banner` for which the underlying changes are already merged but the master-side `metadata.yaml` is still `human_review` (these surfaced when comparing `git log --oneline master | grep "Merge branch 'agent/"` against the four-strong `human_review` column in the board).

### Tasks

- [ ] **Decide the canonical fix point.** Two candidates:
  - (a) `cmd_complete.py` writes the post-merge `metadata.yaml` directly into the *master* checkout after the merge succeeds (e.g. an extra `git add runs/<id>/metadata.yaml` + amend, or a follow-up commit `metadata: backfill done status for <run_id>`). This guarantees master's copy matches worktree's `done`.
  - (b) `_walk_worktrees`'s "drop terminal-state worktree hits" filter is loosened to "drop terminal-state worktree hits *only if the master copy is also terminal*; otherwise prefer the worktree copy and emit a warning." Cheaper, but leaves the on-disk inconsistency in place.
  - (c) Master-side `metadata.yaml` becomes purely derived (e.g. write a `STATUS.txt` or `.status` sentinel at `cmd_complete` time and have the renderer prefer it). Largest change.
  - Pick (a) unless friction surfaces — it keeps `metadata.yaml` the single source of truth and avoids divergence between enumerators.
- [ ] **Write a one-shot reconciliation script** (`tools/reconcile_master_metadata.py` or a `doctor --fix-stale-done` mode) that walks `runs/<id>/metadata.yaml` on master, detects any run whose status is `human_review` / `building` / `validating` / `followups` but whose branch is already merged into the current `HEAD`, and rewrites the master-side metadata to `done` with `completion.accepted_by`, `completion.completion_ref` (the merge SHA), and `completion.completed_at` populated from the merge commit's author + date. Dry-run by default; `--write` to apply.
- [ ] **Backfill the four observed stale runs.** Run the reconciliation against `2026-05-25-generalize-stage-context-md`, `2026-05-26-board-freshness-across-worktrees`, `2026-05-25-each-worktree-owns-its-own-run-dir`, `2026-05-25-lifecycle-papercuts-lock-ready-banner`. Verify `list` and `board` agree afterwards.
- [ ] **Add a `doctor` check** that flags any run whose master-side status is non-terminal but whose branch is already merged into the workbench's root branch (or whose worktree has been removed). One-line warning per offending run with the merge SHA. Doctor doesn't auto-fix — the reconciliation script does.
- [ ] **Unit tests for the chosen fix.** If (a): a test that drives `cmd_complete` end-to-end on a self-modifying synthetic workbench and asserts that after the merge, `git show master:runs/<id>/metadata.yaml` reports `status: done`. If (b): a test where the worktree copy is `done` and the master copy is `human_review` and `iter_all_runs` yields the `done` hit (the opposite of today's behavior). Place under `tests/test_runs.py` or a new `tests/test_self_modifying_complete.py`.
- [ ] **Document the invariant** in `lib/runs.py`'s `_walk_worktrees` and `lib/cli/cmd_complete.py` module docstrings: "After `/complete` returns successfully, the master-side `runs/<id>/metadata.yaml` MUST carry `status: done` plus a populated `completion` block. The worktree-side copy is allowed to vanish (the worktree is removed by `cmd_complete`); the master copy is the canonical archive."

### Acceptance

- After `/complete` succeeds on a self-modifying run, `git show master:runs/<id>/metadata.yaml | grep status` reports `status: done`. Verified by the new unit test.
- `agent-workbench list` and `agent-workbench board --static --status human_review` agree on which runs are actually in `human_review` — no ghost runs from stale master-side metadata. Verified by spot-checking the column counts before and after the backfill.
- `agent-workbench doctor` flags any run whose master-side metadata is non-terminal but whose branch is already merged into the workbench root branch. (Until the reconciliation script runs, doctor surfaces the four observed offenders; after backfill, doctor is silent.)
- The four pre-existing stale runs are reconciled — their master-side `metadata.yaml` reports `status: done` with the correct `completion.completion_ref` SHA from the original merge commit.

### Non-goals

- **Removing the worktree-side metadata write.** `cmd_complete` still updates the worktree copy first; the fix is to ensure master ends up consistent, not to relocate the write.
- **Backfilling runs whose worktrees are already gone *and* whose master copy is correct.** The 15 `done` runs from earlier weeks are fine — only runs where master and reality disagree are in scope.
- **Reconciling abandoned-state runs.** Same shape of bug could exist for `cmd_abandon`; if it does, file as a separate TODO. Don't expand scope here.
- **Refactoring `_walk_worktrees`'s filter** beyond what option (b) above would require if it's the chosen path. The filter logic is intentional ("worktree copies of terminal runs are just merged history checked out here") — keep it.
- **Cross-machine reconciliation.** If a run was `/complete`-d on a different machine and the local checkout never saw the post-merge state, that's a sync issue, not a workbench-correctness issue.

### Origin

Surfaced 2026-05-27 while answering "what's the current status of tasks inside agent-workbench-live?" `agent-workbench list` and the board disagreed: list showed two runs as `done` that the board placed in `human_review`. Tracing through `lib/runs.py:iter_all_runs` + `_walk_worktrees` + `lib/metadata.py:run_dir` revealed that both enumerators correctly resolve the collision, but in opposite directions, and that the underlying problem is master-side `metadata.yaml` being a pre-`done` snapshot for self-modifying runs whose worktree completed the lifecycle locally. The board's "drop terminal-state worktree hits" filter is correct on its own terms; the bug is that master should never have been left in `human_review` after `cmd_complete` returned. Four runs in the current repo demonstrate the issue; the reconciliation script + future `cmd_complete` fix close it.

---

## 2. Create the worktree at `/new-run` for non-self-modifying runs too — collapse the draft/worktree asymmetry

### Symptom

A non-self-modifying run that has progressed `draft → shaping → planning → ready` still has no worktree on disk: `target.worktree.created: false`, `target.worktree.path: null`, no `agent/<slug>` branch in the target repo. The artifacts produced during shaping and planning (`raw-idea.md`, `brief.md`, `plan.md`, `stages/1_draft/`, `stages/2_shaping/`, `stages/3_planning/`, `metadata.yaml`, `events.jsonl`) live under the workbench's master `agent-workbench-live/runs/<run-id>/` and show up as untracked files there until `/start` runs. Concrete example on disk 2026-05-27: run `2026-05-27-campaign-performance-summary-drs` (target `~/Klaviyo/Repos/app`, status `ready`) shows up as `agent-workbench-live/runs/2026-05-27-campaign-performance-summary-drs/` in `git status` of the workbench root, four stages of artifacts already written, no worktree, no branch.

This is the documented behavior — `agent-workbench-live/.claude/commands/new-run.md` says explicitly "**No worktree is created here.** The `git worktree add` happens later in `/start`" — but it produces a real asymmetry: **self-modifying runs get a worktree at `/new-run` time, non-self-modifying runs don't get one until `/start`.** Same lifecycle, two different filesystem stories depending on whether the run happens to target the workbench's own repo.

### Confirmed root cause

`lib/cli/cmd_new_run.py:75-110` (the `# TODO §1A: for an existing self-modifying target …` block) creates the worktree at draft time **only** when `runs_mod.is_self_modifying(cfg, probe_meta)` returns true. For any other repo, `worktree_path` stays `None`, the run dir lands in `cfg.runs_path` (master-side), and `cmd_start.py` is the first place a worktree gets created. `docs/lifecycle.md` § draft (line 222) and § ready→building (lines 345-346) both document this fork in plain text — they describe two different lifecycles depending on self-modifying status, not one uniform one.

The historical reason is genuine: when `/new-run` was first written, none of the LLM-bearing pre-build stages did anything that *needed* a worktree (shaping is code-blind by design, planning reads code but doesn't modify it, ready is a state-only transition). So creating the worktree early was wasted I/O. Self-modifying runs got the early worktree as a *correctness* requirement — the run dir has to live inside the worktree so the `runs/<id>/` writes are committable on the agent's branch instead of polluting master — not because draft/shaping/planning needed it.

What's changed since then:

1. **Planning increasingly reads target-repo code.** Plans now include "Files likely to change" with concrete file paths and short excerpts (see plan template). Doing that read against the user's working tree at `HEAD` instead of a stable worktree means a `git checkout` or rebase by the user mid-plan invalidates the path references. A worktree-as-of-`base_ref_sha` would freeze the working tree at the moment the plan was written.
2. **`base_ref_sha` already gets resolved at `/new-run` for self-modifying runs** (`cmd_new_run.py:87-89`). For non-self-modifying runs it stays `null` until `/start` (see the `2026-05-27-campaign-performance-summary-drs` `metadata.yaml` — `base_ref_sha: null` even though `status: ready`). That's a second asymmetry: self-modifying runs have a frozen, auditable base commit from the moment they're created; non-self-modifying runs don't.
3. **`/abandon` of a `ready` run today doesn't need to remove a worktree for non-self-modifying targets but does need to for self-modifying ones** (`cmd_abandon.py`). Two code paths for the same lifecycle state.
4. **Plumbing a worktree-aware `/plan` is currently impossible.** Future work that wants planning to run inside the worktree (subagent isolation, plan-context.md materialization next to the code, planning-side `git grep` on a stable ref) requires the worktree to exist by then. Today it doesn't for the common case.

### Tasks

- [ ] **Decide the cut.** Two candidates:
  - (a) **Create the worktree at `/new-run` for all runs.** Drop the `is_self_modifying` branch. `cmd_new_run.py` always calls `repos.create_worktree`, `runs_mod.reset_caches()`, `make_worktree_path`, and sets `target.worktree.created: true` + `target.worktree.path` in metadata. The run dir lives inside the worktree from the start (for self-modifying, this is today's behavior; for non-self-modifying, the run dir lives at `<worktree_path>/<workbench_subpath_or_root>/runs/<id>/` — same shape, just relative to a foreign repo's worktree). `/start` becomes a state-only transition for *all* runs.
  - (b) **Defer worktree creation for all runs to `/start`** (including self-modifying). This collapses the asymmetry in the opposite direction — uniform "no worktree until ready" — but loses the self-modifying correctness property (run dir would temporarily live on master, get committed only at `/start`).
  - Pick (a) unless friction surfaces. The asymmetry exists because self-modifying needs the early worktree; the right move is to extend that to all repos, not to take it away from self-modifying.
- [ ] **Update `lib/cli/cmd_new_run.py`** to always create the worktree. Remove the `is_self_modifying` gate around lines 83-110; keep the same code, just unconditional. For non-self-modifying targets, `workbench_subpath` returns `None` (the workbench isn't inside the target repo), so `run_dir_override` is `worktree_path / "agent-workbench-runs" / run_id` (or whatever path convention makes sense for a foreign target — the run dir doesn't need to be inside the workbench subpath when the workbench *is* the source-of-truth elsewhere). Pick the path convention; document it.
- [ ] **Update `lib/cli/cmd_start.py`** to be a state-only transition. The `ready → building` step no longer calls `repos.create_worktree`; it verifies the worktree exists, populates `target.worktree.created: true` if not already, emits `BaseRefResolved` for parity with today's audit narrative, writes `build-context.md`, and transitions. The `WorktreeCreated` event moves from `ready → building` to `RunCreated`'s transition (or becomes a follow-on event of `RunCreated`).
- [ ] **Update `lib/cli/cmd_abandon.py`** to always remove the worktree on abandon — no `is_self_modifying` branch. The lifecycle invariant becomes "if the run exists, the worktree exists; `/abandon` removes both."
- [ ] **Update `schemas/transitions.yaml`** to move worktree-evidence keys (`worktree_path`, `worktree_name`, `branch_name`, `base_ref_sha`) from the `ready → building` transition's required evidence to `RunCreated`'s. Verify `lib/lifecycle.py:transition` still validates correctly.
- [ ] **Update `agent-workbench-live/.claude/commands/new-run.md`** to remove the "**No worktree is created here.**" language and replace it with "`/new-run` creates the run record AND the worktree on `<repo>` at branch `agent/<slug>`. Subsequent stages run against that worktree."
- [ ] **Update `agent-workbench-live/.claude/commands/start.md`** to describe `/start` as the state-only ready-gate — no worktree creation, just human approval to enter `building`.
- [ ] **Update `docs/lifecycle.md` § draft, § shaping, § planning, § ready → building** to describe the uniform lifecycle. Drop the self-modifying carve-out paragraphs at lines 222 and 345-346. `WorktreeCreated` event moves to the `RunCreated` event's accompanying side effects.
- [ ] **Update `agent-workbench-live/.claude/commands/shape.md` and `plan.md`** if they assume the master-side run dir. The slash commands need to know where the run dir lives — same `metadata.run_dir(cfg, run_id)` call works either way, but the working directory expectation may shift. Audit and update.
- [ ] **Write `tests/test_self_modifying.py::test_non_self_modifying_creates_worktree_at_new_run`** (or split self-modifying out of the test class name now that the behavior is uniform — pick one). Synthetic foreign repo at `/tmp/foo/`; `new-run` against it; assert worktree was created at `<worktrees_dir>/foo/<YYYYMMDD>__<slug>/`, branch `agent/<slug>` exists, `target.worktree.created: true`, `base_ref_sha` populated, run dir lives inside the worktree.
- [ ] **Audit `runs/` for pre-change runs** whose master-side run dir won't migrate cleanly. Decide: do those runs stay as historical artifacts (preserved status quo, just no migration), or does a one-shot script move them into newly-created worktrees? Pick "leave them alone" unless something forces migration; pre-existing runs are an archaeology problem, not a correctness one.
- [ ] **Update `docs/lifecycle.md`'s evidence table** (lines 177-184) to reflect the new evidence-key layout (worktree fields move from `ready → building` to `RunCreated`).

### Acceptance

- After `agent-workbench new-run --repo-path /any/git/repo --idea-file foo.md` returns, the worktree exists at `<worktrees_dir>/<repo_name>/<worktree_slug>/`, branch `agent/<slug>` exists in the target repo, `target.worktree.created: true` and `target.worktree.path: <path>` are set in `metadata.yaml`, and `base_ref_sha` is populated with a concrete SHA — regardless of whether the target repo is the workbench itself or a foreign repo.
- `/start` no longer calls `git worktree add`; it's purely a state transition with the human-approval gate.
- The test `tests/test_self_modifying.py::test_new_run_creates_worktree_and_clean_master` keeps passing **and** a parallel test for the non-self-modifying case passes with the same shape.
- `agent-workbench list` and `agent-workbench board` show consistent worktree paths for all post-change runs regardless of self-modifying status.
- `agent-workbench abandon <run_id>` on a `draft`/`shaping`/`planning`/`ready` run removes the worktree and branch uniformly. No `is_self_modifying` branches remain in the codebase outside of where they're genuinely needed (e.g., `cmd_complete`'s post-merge dance).

### Non-goals

- **Changing the human-approval gate.** `/start` remains the human-approval gate to enter `building`. The user still has to say "yes, implement this plan." Only the side effect of `/start` (worktree creation) moves earlier.
- **Migrating existing in-flight runs** whose worktrees don't exist yet. The change applies to runs created on/after the change; runs in pre-change states get cleaned up via `/start` (which still creates a worktree if `target.worktree.created` is false) or `/abandon`.
- **Removing or reshaping `cmd_start._write_build_context_artifacts`.** `build-context.md` still gets written at the `ready → building` boundary; the only thing that changes is `cmd_start` no longer runs `git worktree add` immediately before it.
- **Worktree-per-stage** (one worktree for shaping, another for planning, etc.). One worktree per run, period. The change is *when* it gets created, not *how many* there are.
- **Touching `cmd_complete.py`'s self-modifying merge dance.** That code is for terminal-state reconciliation (see §1) and operates on already-existing worktrees; the change here affects only the front of the lifecycle.
- **Cross-machine worktree consistency.** If `/new-run` is invoked on machine A and the worktree gets created at a path that doesn't exist on machine B, that's the same problem we have today — not in scope.

### Origin

Surfaced 2026-05-27 while inspecting two untracked paths in the workbench master (`agent-workbench-live/plan.md` and `agent-workbench-live/runs/2026-05-27-campaign-performance-summary-drs/`). The user asked: "I thought new runs were supposed to run entirely in their own worktrees?" Tracing through `cmd_new_run.py:75-110` and `docs/lifecycle.md` § draft + § ready→building confirmed the asymmetry: self-modifying runs get a worktree at `/new-run`, non-self-modifying runs don't get one until `/start`. The campaign-performance-summary-drs run targets `~/Klaviyo/Repos/app` (foreign repo) and therefore correctly has no worktree yet — but the artifacts it has accumulated through `ready` are sitting as untracked files in the workbench master rather than committed to its own branch. The expected mental model is "every run has a worktree from the moment it exists"; the actual behavior is "every run gets a worktree by `/start` time, but the path between `/new-run` and `/start` looks different depending on whether the target repo is the workbench itself."

---

## 3. Add a `/build` slash command — close the building-stage curated-entry enforcement gap

`/shape`, `/plan`, `/validate`, `/followups` each have a slash command that wraps the corresponding stage's `--init` (curated-entry staging) and finalize (transition + evidence) steps. **Building is the only LLM-bearing stage with no slash command** — the building agent enters passively after `/start`, with no scripted prompt that says "read `build-context.md` first." That asymmetry has two costs that surfaced in the 2026-05-25 `generalize-stage-context-md` run:

1. **No deterministic enforcement point** for the `build-context.md` curated-entry contract. The rule "read `build-context.md` first; do NOT re-read `brief.md` / `plan.md` separately if it already covers what you need" lives in `AGENTS.md` § Session discipline and in `docs/lifecycle.md` § building. The `/validate` slash command, by contrast, embeds the same rule in its Step 2 — impossible to miss because every validate session reads its own slash-command body. The building stage's contract is currently convention-strength only; an agent that ignores it pays a cache cost but no enforcement triggers.
2. **No symmetric `--init` step for building.** Today `build-context.md` is written as a side effect of `cmd_start.py`'s `ready → building` transition. That conflates the worktree-creation step with the curated-context-staging step. A `/build --init` would let `build-context.md` be regenerated on demand — closing F-004 from the 2026-05-25 rebuild (bounce rebuilds don't go through `cmd_start.run`, so `_write_build_context_artifacts` never fires; the rebuild agent has no `build-context.md` and falls back to reading `change-request.md` instead, which is the right curated file for a bounce but is produced by a different code path).

### Background

The 2026-05-25 run that shipped `build-context.md` already laid most of the infrastructure (`lib/build_context.py` + `cmd_start._write_build_context_artifacts`), but explicitly out-of-scope'd the `/build` slash command. The decision then was DR-002: "There is no `/build` slash command at all (subagent investigation confirmed). The building stage is entered passively by the agent operating inside the worktree after `/start`. So `/start` is the only deterministic write point upstream of building." That call was correct at landing time — adding a new slash command would have scope-crept the run. Now that build-context.md exists and the asymmetry is real, the slash command is the natural follow-up.

### Proposed shape

Mirror `/validate.md`'s shape (it's the most analogous LLM-bearing-stage slash command — has both `--init` curated-context staging and a finalize):

```
agent-workbench build <run_id> --init   # re-renders build-context.md from current artifacts
agent-workbench build <run_id>          # finalize building: verify build.md, transition building -> validating
```

**`/build --init`:**
- Idempotent.
- Re-renders `build-context.md` by calling the existing `cmd_start._write_build_context_artifacts` (or its extracted public form — see below). No transition (the run is already in `building`).
- Use cases: fresh entry into the building stage (regenerate after a manual brief/plan edit); after a `/bounce` (closes F-004); recovery from a stale curated file.
- Failure mode: same convenience-artifact swallow as today — never blocks; emits a warning to stderr if the helper fails.

**`/build` (default mode):**
- Verifies `build.md` exists and is non-empty (today's `validate --init` enforces this; the new flow shifts the gate one step earlier).
- Sets `build.iterations` and `build.exit_reason` evidence in metadata (today `validate --init` defaults them if not set; the new flow has the builder set them explicitly).
- Emits `BuildingFinalized` (or whatever event ID fits) and transitions `building → validating`.
- The existing `validate --init` retains its current `building → validating` transition logic for backward compat, but documents that `/build` is the preferred path.

**`.claude/commands/build.md`:**
- Step 1: invoke `agent-workbench build <run_id> --init` (if status is `building`).
- Step 2: **"Read `runs/$RUN_ID/stages/4_building/build-context.md`. Do NOT re-read `brief.md`, `plan.md`, or `templates/build.md` separately if `build-context.md` already covers what you need."** (Exact mirror of `validate.md` step 2's language.)
- Step 3: implement the change in the worktree.
- Step 4: write `build.md` per the template (Implementation summary, Files changed, Acceptance criteria coverage, Deviations from plan, Known issues, Commands run, Documentation touched).
- Step 5: finalize via `agent-workbench build <run_id>` — transitions to `validating`.

### Tasks

- [ ] **Decide the relationship to `cmd_start._write_build_context_artifacts`.** Two options: (a) extract it to a public `lib.build_context.materialize_for_run(cfg, run_id, staged)` and have both `cmd_start.py` and the new `cmd_build.py` call it; (b) call the existing private helper from `cmd_start.py` via a small wrapper. Option (a) is cleaner and matches DR-002's stance on deterministic write points; option (b) is smaller. Pick (a) unless friction surfaces.
- [ ] **Build `lib/cli/cmd_build.py`.** Two modes (`--init` and default). Mode dispatch mirrors `cmd_followups.py`'s shape. Default mode validates evidence + transitions.
- [ ] **Update `schemas/transitions.yaml`** if `validate --init` no longer drives the `building → validating` transition exclusively (it must still work, but `/build` becomes the canonical path). Decide whether the evidence keys move (`implementation_summary_path` / `diff_summary_path` / `build_iterations` / `build_exit_reason` — today required by `validate --init`).
- [ ] **Update `cmd_validate.py` `--init`** so it's a no-op transition when the run is already in `validating` (idempotent), or remove its building → validating transition path entirely if `/build` covers it. Decide based on what backward compat costs vs. cleanliness.
- [ ] **Write `.claude/commands/build.md`** with the Step 2 language mirroring `validate.md`'s.
- [ ] **Wire `/build --init` into `cmd_bounce.py`.** A bounce that returns to `building` should regenerate `build-context.md` automatically (or the rebuild's first `/build --init` does it). Pick one; document.
- [ ] **Update `docs/lifecycle.md` § building** to point at the new slash command; update `agent-workbench-live/AGENTS.md` § Session discipline.
- [ ] **Update `tests/test_e2e.py::TestE2EHappyPath::test_happy_path`** to drive through `/build --init` and `/build` finalize as new steps; assert the build-context.md regenerates on a bounce rebuild via `/build --init` (the F-004 close).
- [ ] **Unit tests for `cmd_build.py`** mirroring `tests/test_cmd_*` patterns: --init mode, default mode, status guards, evidence verification.

### Acceptance

- Every LLM-bearing stage has a slash command that prompts the agent to read its curated entry first. `/build` exists and is symmetric with `/shape` / `/plan` / `/validate` / `/followups`.
- A bounce rebuild can regenerate `build-context.md` via `/build --init` without re-running `/start` (closes F-004 from the 2026-05-25 `generalize-stage-context-md` run).
- `tests/test_e2e.py::TestE2EHappyPath::test_happy_path` drives through `/build --init` and `/build` finalize; passes deterministically.
- `validate --init` no longer needs to default `build_iterations` / `build_exit_reason` — `/build` finalize sets them explicitly. (Or `validate --init` keeps the defaulting for backward compat with pre-`/build` runs; pick one.)
- The Step 2 language in `.claude/commands/build.md` is identical in spirit to `validate.md`'s "Do NOT re-read X if `<stage>-context.md` already covers what you need."

### Non-goals

- **Behavioral enforcement of the read-only-curated-file contract.** The slash command nudges the agent; it does not technically restrict which files the agent's `Read` tool can open. Stronger enforcement (per-stage tool-policy allowlist, subagent isolation) is §9's territory, not this.
- **Renaming, merging, or restructuring other slash commands.** This is purely additive.
- **Building `plan-context.md`, `followups-context.md`, `shape-context.md`** — those are §5 (the renumbered "Generalize the `*-context.md` cross-stage contract" follow-up).
- **Subagent-based building.** Routing the builder through an `Agent`-tool subagent fed only `build-context.md` would be a stronger enforcement story; that's a separate design conversation (would touch §8 publishing-stage subagent pattern).
- **Tool-policy file at building stage.** §9 work; out of scope here.

### Origin

Surfaced 2026-05-27 in conversation immediately after `/complete`-ing the run that landed `build-context.md` (2026-05-25-generalize-stage-context-md). The asymmetry — every other LLM-bearing stage has a slash command except building — became visible the moment build-context.md existed, because the question "how does the building agent know to read it first?" had no satisfying answer at the code-execution level. The contract today is at convention-strength only (documented in AGENTS.md + lifecycle.md + the now-shipped build-context.md's own Rules block), not at instruction-presentation-strength like `/validate.md` step 2. F-004 from the same run's review.md flagged the bounce-rebuild gap separately; both close together with the `/build --init` mode.

---

## 4. Investigate the handoff-rendering failure cluster (HUMAN_REVIEW.md + stop banner)

### Symptom

The `human_review` handoff is supposed to give a reviewer a faithful, code-derived summary of what the run actually did. In practice, multiple recent runs produce handoffs whose `## Summary of changes` section is either fabricated (literal example bullets from a template comment) or hollow (parent headers with no detail). The stop banner that the agent reads after the handoff lands inherits these problems and amplifies them.

Two concrete examples on disk to investigate:

**Example A — fabricated bullets from template comment.** Run `2026-05-26-schema-level-validation-for-metadata`. HUMAN_REVIEW.md's `## Summary of changes` reads:

```
## Summary of changes

- 2 doc(s) touched:
  - `README.md — added a /hello endpoint example`
  - `docs/api.md — documented the new response schema`

→ Full diff: /Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260526__schema-level-validation-for-metadata/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-26-schema-level-validation-for-metadata/stages/4_building/build.md
```

Neither `README.md` nor `docs/api.md` was actually touched by this run. The build.md file at the path the handoff points to is byte-for-byte identical to `templates/build.md` — the builder wrote nothing into it. The two phantom bullets are the literal example lines that live *inside* an HTML comment under the `## Documentation touched` section of the template. `lib/human_review.py`'s `_section` + `_bullet_items` pair walks the section body for `- ` lines without stripping `<!-- -->` framing, so the examples get parsed as if they were real entries.

**Example B — hollow parent headers in the stop banner.** Run `2026-05-26-board-freshness-across-worktrees`. The stop banner printed after the `followups → human_review` transition shows:

```
Review:
  HUMAN_REVIEW.md: /Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260526__board-freshness-across-worktrees/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-26-board-freshness-across-worktrees/HUMAN_REVIEW.md

Summary of changes (≤3 bullets):
  - 5 file(s) touched:
  - 1 doc(s) touched:

Summary of testing (≤2 sentences, or "None recorded."):
  Unit tests passed; no known issues.
```

The two parent bullets end in colons with nothing after them. The detail *does* exist in HUMAN_REVIEW.md (per-file nested rows under each header — 500+ character bullets describing each touched file). But `lib/cli/_stop_banner.py`'s `_render_summary_bullets` deliberately drops nested `  - ` rows ("Top-level bullets only — no leading whitespace before the dash."). The result is structurally correct but reads as broken because the surviving headers were never meant to stand alone.

### Three observed failure modes

These came out of the conversation that surfaced this TODO; they may or may not be the full set.

1. **HTML-comment leakage in `lib/human_review.py`.** `_extract_build_summary` calls `_section` then `_bullet_items` on `## Documentation touched` (and would do the same on `## Files changed` if its template comment ever contained `- ` lines). Neither function strips `<!-- ... -->` blocks. Any `- ` line inside a comment is parsed as a real bullet. Affects `## Summary of changes` in HUMAN_REVIEW.md.

2. **Silent template fallback at `cmd_validate.py:290-298`.** `/validate --init` requires `build.md` to exist at the run root before the building→validating transition; if it's absent, the code stages `templates/build.md` and proceeds. The transition itself only checks file existence, not content (per the `("implementation_summary_path", "build.md", "building", "build.md")` row at `lib/lifecycle.py:152`). A builder that never wrote build.md is indistinguishable from one that did — until the unfilled template starts feeding bug 1 downstream.

3. **Stop-banner extractor drops the only level that has detail.** `_render_summary_bullets` in `lib/cli/_stop_banner.py` extracts column-0 `- ` bullets from HUMAN_REVIEW.md's `## Summary of changes`. The human_review renderer's convention for "files changed" is `- N file(s) touched:` as a parent + `  - <path>` rows as children. The banner extractor sees the parent, drops the children, and renders headers with empty colons.

On a related note, this is also wrong
```
    7 files changed, +139 / −17 lines
```
It SHOULD tell me WHICH files were changed with +/- lines for every file

### Tasks (investigation only — no fixes in this TODO)

- [ ] **Map all sites where text-shape parsing meets template-shaped input.** Grep for `_section`, `_bullet_items`, `## ` literal matching, anything that consumes `build.md` / `HUMAN_REVIEW.md` / `qa/report.md`. Each consumer should be examined for: does it assume content was written? Does it strip HTML comments? Does it understand the nested-bullet convention the producer uses? Write the findings as a table (file:line, what it reads, what assumption it makes, whether that assumption is safe today).
- [ ] **Audit `runs/` for how often the silent template fallback fires.** For each run with a `stages/4_building/build.md`, diff it against `templates/build.md`. Count how many are byte-identical (= builder wrote nothing) vs. partially filled vs. fully filled. The ratio tells us how systemic the unfilled-template handoff is.
- [ ] **Audit HUMAN_REVIEW.md across recent runs** for phantom example bullets, hollow header rows, or any other text that looks templated. Map each instance back to which producer/consumer pair produced it. The two examples above are a starting set; there may be more failure modes (e.g. `Manual testing performed` section, `Run timeline` empty rows).
- [ ] **Re-read the producer↔consumer contract** between the builder's `build.md`, the validate-init template fallback, the `human_review` renderer, the stop-banner builder, and the templates themselves. Specifically: is the right contract "the renderer parses build.md and templates are inert decoration," or "the builder writes structured fields the renderer consumes by name"? Today's mix of template HTML comments + free-form markdown + regex extraction is the weakest of both worlds.
- [ ] **Decide whether the broader pattern is the bug, not the individual sites.** Three different functions are each independently permissive. The conversation that surfaced this TODO suggested "common thread: shallow text-shape parsing without understanding semantics — comments are content, nested bullets are noise, an existing template file means done." That framing is worth pressure-testing: is there a single producer-side change (e.g. structured frontmatter in build.md, or a `build.json` sibling) that obsoletes all three consumer-side workarounds at once?

### Acceptance

- A written analysis (1–2 pages) that identifies every site involved in the handoff-rendering chain, names each failure mode observed, and proposes one or more candidate fix strategies (single-site patches vs. contract redesign vs. validation upstream).
- The analysis explicitly answers: should we strip HTML comments at the parsing layer (cheap, narrow), reject unfilled templates at `/validate --init` (changes lifecycle), restructure build.md to carry machine-readable fields (largest change), or some combination?
- A go/no-go recommendation for each candidate, with the smallest change that closes the example-A and example-B regressions called out as the minimum bar.

### Non-goals

Implementing any of the fixes. This TODO is the investigation; the fix(es) get their own TODO entry once the analysis lands and the user picks a direction. Re-running prior runs whose handoffs are already wrong — those are historical artifacts, not blockers.

### Origin

Surfaced 2026-05-26 while inspecting two recent runs' HUMAN_REVIEW.md and stop-banner output. The user noticed `## Summary of changes` was either fabricated (example A) or hollow (example B) and pushed back that "looks to me there is a larger issue at play." Three distinct bugs were identified in the same conversation, but the user asked to investigate thoroughly before designing solutions rather than patching each in isolation — the suspicion is that the right fix is at the contract level, not the regex level.

---

## 5. Generalize the `*-context.md` cross-stage contract (cont'd — `plan-context.md`, `followups-context.md`, `shape-context.md`)

The 2026-05-25 `generalize-stage-context-md` run shipped `build-context.md` (the highest-leverage of the four siblings) but explicitly deferred the other three to follow-up runs. This section tracks those follow-ups. The original framing from the 2026-05-25 brief still holds; only `build-context.md` and its wiring are removed from the task list.

The leverage is twofold:

1. **Cache footprint.** File reads in the master session stick in the prefix forever. Today the builder typically reads `brief.md` + `plan.md` + occasional `decisions.md` lookups; the reviewer (without the curated context) would read all of those plus the QA report plus the build summary. Each is a permanent prefix cost. One curated file per stage collapses that into a single read.
2. **Subagent-readiness.** A self-contained `<stage>-context.md` is the natural input for an Agent-tool subagent — the master spawns the subagent with that one file as context, the subagent's reads don't pollute the master's prefix, the master gets back structured findings. This is the same pattern the existing `Explore` rule uses; the cross-stage contract makes it the default shape for every LLM-bearing stage. The pre-PR adversarial reviewer (§8 `publishing` stage) depends on this — `validate-context.md` and `build-context.md` are already shaped right, but `plan-context.md` would need to exist before the subagent pattern can extend to the planning stage.

### What each remaining file contains

**`shape-context.md`** (written by `shape --init`)
- Original raw idea (verbatim from `raw-idea.md`)
- Answers from `answers.md` if present
- `brief.md` template skeleton inlined with one-line section descriptions
- The two shaping rules: no code reading, no questions

This one is thinnest — shaping has the least prior context to filter. The win is mostly inlining the template so the agent doesn't context-switch into `templates/`.

**`plan-context.md`** (written by `plan --init`)
- Full `brief.md` (small, load-bearing)
- Repo map: top-level dirs, detected languages, build/test commands from `agent-workbench.yaml` policies or inferred from the worktree
- `brief.md`'s "Files likely to change" lifted inline (the planner should validate or refute this)
- `plan.md` template skeleton with section descriptions
- Rules reminder: may read code, may not ask questions, record assumptions

**`build-context.md`** — shipped 2026-05-25 in run `2026-05-25-generalize-stage-context-md` (merge commit `c075b0c`). Lifts brief's Acceptance criteria + Non-goals, plan's Proposed changes + Files likely to change + Test plan + Definition of done, all DR/ASM blocks, worktree metadata, and the build.md template skeleton.

**`validate-context.md`** — already existed before 2026-05-25. This is the design template.

**`followups-context.md`** (written by `followups --init`)
- Brief's Non-goals (frequent source of follow-up candidates)
- Plan's Risks section
- Review's Decision + findings
- QA's Known issues
- Build's Deviations from plan
- `follow-ups.md` schema (category enum, frontmatter rules)
- Rules reminder: read-only, 1–5 entries or `no_followups` sentinel

### Tasks

- [x] Build `build-context.md` first — highest leverage, lowest risk. **Shipped 2026-05-25** in run `2026-05-25-generalize-stage-context-md` (merge `c075b0c`).
- [x] Build `plan-context.md` next. **Shipped 2026-05-27** in run `2026-05-27-generalize-stage-context-md-followups`. `lib/plan_context.py` + `cmd_plan._write_plan_context_artifacts`. Repo-map detection is narrow (manifest files only — `pyproject.toml`, `package.json`, `Cargo.toml`, `go.mod`, `Makefile`), no heuristic scanning. Build/test commands sourced from manifests, not `agent-workbench.yaml` policies (the original brief assumed the latter — see DR-001 / ASM-001 in this run's `plan.md`).
- [x] Build `followups-context.md`. **Shipped 2026-05-27** in the same run. `lib/followups_context.py` + `cmd_followups._write_followups_context_artifacts`. Written into `stages/6_followups/` AFTER the `validating → followups` transition (so prior-stage files have already been moved into their stage dirs).
- [x] Build `shape-context.md`. **Shipped 2026-05-27** in the same run. `lib/shape_context.py` + `cmd_shape._write_shape_context_artifacts`. Built for consistency per the run's `answers.md` Q2 decision — the §5 contract is "every LLM-bearing stage has a `<stage>-context.md`"; skipping shape would leave the contract uneven.
- [x] For each, update the corresponding `.claude/commands/*.md` so step 1 reads `<stage>-context.md` rather than the prior artifacts directly. Mirror the `validate.md` step 2 language: "Do NOT re-read X if `<stage>-context.md` already covers what you need." **Shipped 2026-05-27** for shape/plan/followups. For building, this is the new `/build` slash command (§3) — still pending.
- [x] Document the contract in `docs/lifecycle.md` — add a `*-context.md` row to each remaining stage's table, sibling to "Reads" and "Produces." **Shipped 2026-05-27**: a "Curated entry context" sub-block was added under shape, plan, followups, mirroring the building stage's existing sub-block.
- [x] Each new `<stage>-context.md` builder gets unit tests that mirror `tests/test_build_context.py`'s shape (or `tests/test_validate_context_build.py`'s — both work) — synthetic prior artifacts → assert the generated context has the expected sections. **Shipped 2026-05-27**: `tests/test_shape_context.py` (13 tests), `tests/test_plan_context.py` (23 tests), `tests/test_followups_context.py` (19 tests).

### Acceptance

- Every LLM-bearing stage (`shape`, `plan`, `build`, `validate`, `followups`) has a `<stage>-context.md` generated by `--init` before the agent reads anything. Building is done; three remain.
- A spot-check of three runs after the change shows the master session's prefix during each stage growing primarily from the curated file plus the worktree code the agent actively edits — not from re-reads of prior artifacts.

### Non-goals

Changing the artifact contents themselves (brief/plan/build/review keep their current sections); merging stages or changing the lifecycle; replacing template-driven artifact authoring with anything generative; building a `repo-map.md` artifact separate from `plan-context.md`'s repo-map section (keep it inline for now); shipping `/build` (that's §3's territory now).

### Origin

Surfaced 2026-05-25 in a design conversation comparing agent-workbench to a proposed planner/implementer/reviewer/PR-writer system. The proposed system's "shared durable context, not many independent workers" framing matched what `validate-context.md` already does — but agent-workbench only built that pattern for the validate boundary. Generalizing is straightforward and the cache-discipline payoff is concrete. Build-context.md shipped 2026-05-25 (merge `c075b0c`); the remaining three siblings stay TODO. Renumbered to §5 on 2026-05-27 — originally §3 when `/build` was promoted to §1, then §4 once the master-side metadata reconciliation TODO took §1, then §5 once the worktree-at-draft TODO took §2.

---

## 6. Test-coverage gaps

Six gaps that have shown up twice or more across follow-ups since 2026-05-24. Grouped because they all share the same shape: a code path that's verified by code-reading or by tmp-dir structural assertions, but doesn't have a runtime drive-and-assert.

- [ ] **Full self-modifying lifecycle E2E.** `tests/test_self_modifying.py` covers `new-run` only (`test_new_run_creates_worktree_and_clean_master`). Add a test that drives `shape → plan → start → validate → complete` end-to-end on a synthetic self-modifying workbench; assert master's `git status --porcelain` is clean of `runs/` entries at every step and that the final merge commit contains the run dir at the worktree-side path. Reuse `_make_self_modifying_workbench` from the existing class.
- [ ] **Flat-layout E2E fixture.** `cmd_validate.py`'s flat path (`validating → human_review` directly) is the only one of the five banner sites without runtime coverage. Add `tests/fixtures/flat_happy/` (or similar) and a test method mirroring `test_happy_path` minus the followups stage. Asserts `STOP.` appears after `validate` and not after `validate --init`.
- [ ] **No-banner-on-abort runtime test for `cmd_complete`.** The existing `TestE2ECompleteMerge::test_merge_conflict_aborts_and_stays_in_human_review` checks status + events but does not assert `STOP.` is absent from stdout. Add the assertion (or a sibling test) so a future refactor that moves the banner above the failure paths fails loudly.
- [ ] **Direct unit tests for `lib/repos.py:stage_and_commit_run_dir` and `archive_tree_to_path`.** Only exercised via `cmd_complete` / `cmd_abandon` integration today. The `--strip-components` count in `archive_tree_to_path` depends on the source path's segment count and would benefit from a focused fixture (2-segment vs. 4-segment source paths).
- [ ] **Snapshot test for the full `human_review` stop banner.** Today the structured body is checked by `TestFullBanner` structural assertions + E2E `assertIn` substring checks; wording drift in the body (e.g. "auto-merges worktree branch into parent" → "merges into parent") would pass. Reuse the `_normalize`-style helper from `tests/test_human_review.py` (collapse `<TMP>`, `<TEST_REPO>`, `<HH:MM:SS>`, `<RUN_ROOT>`) and add two fixture-driven snapshots — one for the happy path, one for bounce-pass2 — under `tests/snapshots/stop_banner_human_review_{happy,bounce_pass2}.expected.txt`.
- [ ] **`_write_validate_context_artifacts` error-path coverage.** `cmd_validate.py:82-84` wraps the whole generator in `try: ... except Exception: pass`. The convenience-artifacts-must-not-break-the-transition intent is right, but the catch silences any bug in the generator. Add: (a) one test that monkey-patches `validate_context.build` to raise and asserts the transition still succeeds AND that the file is NOT written (proving the catch fired), (b) one test that constructs an unparseable `build.md` and asserts the generator produces a sentinel-fallback file rather than crashing. Optional: log the swallowed exception to `events.jsonl`.

### Acceptance

- All six gaps closed; suite count rises by the corresponding number of cases (rough estimate: +10 to +15 tests).
- Each new test would fail under today's behavior if the relevant code were reverted (verify by spot-check).

---

## 7. Subagent cost measurement — fold Agent-tool spend into `metrics.jsonl`'s totals (Path B)

### Status (2026-05-27)

The investigation pass shipped as run `2026-05-27-subagent-cost-measurement` (review pending) classified the current state and made the gap explicit, but did NOT close it. Empirical finding from that run:

**Subagent token spend is invisible to `metrics.jsonl`'s totals.** `lib/metrics/writer.py` derives every token count from `~/.claude/projects/<slug>/<session-id>.jsonl` by reading `message.usage` off `assistant`-type records. Claude Code's `Agent` tool emits a `tool_use` block (the invocation) and a `tool_result` block (the subagent's text response), but **neither block carries any `usage` field**. Verified by reading real transcripts. There is no `PostToolUse` hook firing for the `Agent` tool (only for Bash/Write/Edit); no Claude Code session-metrics export; no OpenTelemetry sink; no aicodemetricsd integration for Agent. RTK's SQLite DB tracks command-level token savings, not subagent calls.

V1 (the investigation pass) shipped four header-row fields to make this gap explicit instead of silent:

- `subagent_tokens: null` (always — we don't have the data)
- `subagent_tokens_status: "telemetry_not_available"`
- `subagent_invocations: <int>` (count of `Agent` tool_use blocks observed; the only fan-out signal we can derive)
- `telemetry_source: "claude_code_transcript_v1"`

And bumped `SCHEMA_VERSION` 2 → 3.

But **`total_tokens` and `cost_usd` in the summary, in the board, and in the CLI's text render still only sum master-session turns**. The whole product `metrics.jsonl` is supposed to deliver — honest per-run accounting — does not work for any run that uses subagents. The board's cost column lies, silently, for every fan-out run.

This is a bigger problem than V1's sentinel suggests. The "subagent-first read strategy" that AGENTS.md actively encourages is the dominant pattern for read-heavy work in `/build` and `/validate`. Recent runs routinely fan out 2–8 subagents per stage. Their spend disappears.

### What needs to happen now

Capture subagent token spend at the boundary, write it to a sidecar the writer can read, fold it into `total_tokens` / `cost_usd` / the board's per-run total. The architecture has to give us a way to observe the data the Agent tool doesn't expose.

### Path B implementation sketch

- [ ] **`PostToolUse` hook on the `Agent` tool.** Configured in `~/.claude/settings.json` (or the project-local `.claude/settings.json` so it can be checked in). Hook fires with the tool_use + tool_result on stdin. The hook script (likely shell or a small Python entry point under `agent-workbench-live/bin/`) appends one record per Agent call to a sidecar file. **Investigation needed first:** verify a `PostToolUse` hook can actually fire for `Agent` (the current hooks config only references Bash/Write/Edit; whether `Agent` is hook-eligible needs confirmation in Claude Code docs or via experiment). If it isn't, this path is blocked and the work shifts to (e) below.
- [ ] **Decide what the hook captures.** Three sub-options:
  - (a) The hook reads the subagent's response text and *estimates* tokens from response length (4 chars/token heuristic — the same one `lib/metrics/buckets.py` uses). Approximate but always available.
  - (b) The hook waits for Claude Code to expose `usage` on the Agent tool's result (out of our control; may never happen).
  - (c) The hook spawns the subagent itself via the Anthropic SDK and observes `usage` directly. Major architectural change; subagents would no longer be Claude-Code-managed.
  - Pick (a) for now — heuristic spend beats null spend, and the same heuristic already underpins our bucket attribution.
- [ ] **Sidecar JSONL schema.** Decide where it lives (`~/.claude/agent-workbench/subagent-spend.jsonl`? `<workbench_root>/runs/<run_id>/.subagent-spend.jsonl`? — the first is hook-config friendly but harder for the writer to scope per-run; the second requires the hook to know the run ID at fire time, which it may not have). Each row: `{at, session_id, parent_cwd, subagent_type, description_prefix, input_tokens_est, output_tokens_est}`.
- [ ] **Writer integration.** After the existing transcript walk, `record_run_metrics()` reads the sidecar (scoped by session_id and cwd-or-workbench-root match), sums the per-invocation estimates into a single `subagent_tokens` int, flips `subagent_tokens_status` from `"telemetry_not_available"` to `"captured_estimate"` (or `"captured"` if (b) ever materializes), and **adds the sum to `total_tokens`** at the summary layer.
- [ ] **Summary layer change.** `RunMetricsSummary.total_tokens` must include `subagent_tokens` when populated. Today it's `sum(turn_row.usage.* across turn_rows)`. Either (i) emit synthetic `kind: turn` rows for subagent calls so the existing summer picks them up, or (ii) add subagent_tokens to the total after the per-turn sum. Pick (i) for board-consistency (the board's `_quick_metrics_from_jsonl` already iterates turn rows). The synthetic row would carry `stage: <calling stage>`, `command: "Agent"`, `model: <subagent_type>`, `usage: {input: est_in, output: est_out, cache_read: 0, cache_creation: 0}`. Pricing reuses `metrics/prices.yaml` (subagents run the same models as the master, so the rate table doesn't need to grow).
- [ ] **Board renderer pickup.** Once `total_tokens` includes subagent spend, the board's existing cost column starts being honest automatically — no UX change required, just truthful numbers. If a "captured_estimate" badge or annotation is wanted on the card to flag heuristic-vs-real, that's a follow-on.
- [ ] **Tests.** Drive a synthetic run that emits N entries to the sidecar; assert `metrics.jsonl` carries N+M turn rows (M master turns + N synthetic subagent rows) and that `total_tokens` matches the sum. A second test for the sidecar-missing path (must degrade gracefully back to the V1 sentinel).
- [ ] **Backward compat for v3 runs already on disk.** Runs that landed before Path B writes `subagent_tokens: null` + `"telemetry_not_available"` to their headers. The summary must not error on those; today's loader already handles `None`.
- [ ] **Document the captured-estimate caveat** in `lib/metrics/writer.py`'s module docstring (already laying the groundwork in V1) and in `AGENTS.md` § "Subagent discipline" (V1 bullet stays, gets a second sub-bullet on the estimation methodology).
- [ ] **Fallback if `PostToolUse` for `Agent` is not supported.** Investigation may turn up that Claude Code doesn't fire hooks for the Agent tool. In that case the path forks to: (e1) parse the master session's transcript for `Agent` tool_use blocks, derive a heuristic estimate from the `description` and `prompt` length + the returned text length (worse signal than a hook can provide but available), or (e2) accept that subagent spend stays invisible and document it as a Claude Code limitation. Decide which only after (a) is confirmed dead.

### Acceptance

- `metrics.jsonl`'s `total_tokens` for a synthetic run that fans out 5 subagents matches (master_session_tokens + sum_of_5_subagent_estimates) within rounding.
- `agent-workbench metrics <run_id>` text output's `total` line is honest about fan-out — a run with heavy subagent use no longer reports an artificially low total.
- The board's per-run cost column is accurate within ~10% of true total cost for a fan-out run. (5% is the brief's stretch goal; 10% is realistic for an estimate-based capture.)
- `subagent_tokens_status` reports `"captured_estimate"` (or whatever literal we settle on) in the header row; the existing V1 unit tests that assert `"telemetry_not_available"` get updated to match.
- The synthetic test from V1 (`test_header_row_counts_agent_invocations`) still passes — invocation counting is independent of spend capture.
- A `bin/agent-workbench-subagent-hook` (or equivalent) script exists, is wired in `~/.claude/settings.json` (or the project's `.claude/settings.json`), and produces the sidecar JSONL on every Agent call.

### Non-goals

- **Throttling or capping subagent spawn.** Same as V1: "spawn when the work justifies it; measure honestly."
- **Per-subagent breakdown in the audit.** Recording "this run spawned 3 Explore subagents at 200k each + 2 general-purpose at 50k each" is genuinely useful but secondary to fixing `total_tokens`. Defer.
- **Replacing Claude Code's Agent tool with a custom SDK-driven spawner.** That's option (c) above; out of scope for Path B unless (a) and (e) both prove unworkable.
- **Cross-session aggregation.** A subagent invoked in session A whose record lands while session B is also writing the sidecar — define the schema with `session_id` so cross-contamination is filtered, but don't attempt cross-machine or cross-user sync.
- **Migrating existing v3 metrics.jsonl files.** Once Path B ships, new runs get accurate totals. Old v3 runs keep their `subagent_tokens: null` header; the summary handles it.

### Origin

Surfaced as a deferred-from-investigation TODO at the end of run `2026-05-27-subagent-cost-measurement`. The V1 pass (`/complete` pending review at time of writing) classified the gap as case (c) — "no, missing" — and shipped an honest sentinel + invocation counter + documentation. The user's pushback on V1's scope is the correct one: a metrics system whose `total_tokens` doesn't include subagent work isn't doing its job, and the board's cost column lies for any fan-out run. The "Path B" framing comes from DR-001 in that run's plan, which explicitly deferred this work. The conversation that surfaced the urgency: "What is metrics.jsonl counting currently? Is it not focused on total tokens and total cost?" — and the answer made clear that V1's sentinel was honest about the gap but didn't close the underlying accounting failure.

---

## 8. GitHub PR delivery: `publishing` stage + minimal lifecycle fork

Today the workbench is built for personal-repo, single-author work. `done` means "human accepted + locally merged to parent branch" — `cmd_complete` checks out the parent and runs `git merge --no-ff` directly. That model collapses two things that are separate in a team workflow: author sign-off and team sign-off. For team work the workbench needs to model the PR-review world as first-class lifecycle states, not a slash-command bolt-on after `done`.

The user-stated workflow:

> I give a Linear ticket so things are implemented → Human Review → approved means PR is created and run is marked as Done. If PR gets comments, it can get reopened somehow.

The key requirement: **the human must see and approve the PR description before anything gets pushed**. PR descriptions are not a fire-and-forget concern — they are an LLM-bearing artifact with its own drafting stage. And `done` for team work cannot mean "auto-merged into master" — it means "PR merged on GitHub."

### Design — minimal fork at `human_review`

The delivery choice is **not** declared at `new-run` time. Forcing it that early couples a run's identity to a decision the author hasn't made yet — often you don't know if a change is PR-worthy until you've built it. Instead, the fork happens at the `human_review` terminal boundary, by which slash command the author invokes:

```text
human_review --(/complete)----> done             # local merge (today's behavior, unchanged)
human_review --(/publish-pr)--> publishing       # PR-flow entry
human_review --(/bounce)------> building         # rebuild (unchanged)
human_review --(/abandon)-----> abandoned        # (unchanged)

# PR-flow continuation:
publishing       --(/publish-pr)--> in_pr_review  # human-confirmed; pushes + opens PR
publishing       --(/bounce)------> human_review  # draft rejected; nothing pushed
in_pr_review     --(/complete)----> done          # one-shot `gh pr view` confirms PRMerged
in_pr_review     --(/bounce)------> building      # human-invoked; pulls comments to change-request.md
in_pr_review     --(/abandon)-----> abandoned     # local abandon; PR is orphaned (see hard parts)
in_pr_review     --(/closed)------> closed        # human marks PR was closed on GitHub
any non-terminal --(/abandon)-----> abandoned
```

`completion.delivery` (`local-merge` | `github-pr`) is set by whichever terminal command runs — it is recorded, not declared. Metadata grows `completion.pr_number` + `completion.pr_url` once `/publish-pr` succeeds.

### The new stages

**`publishing` — LLM-bearing, drafts the PR description**

The single purpose of this stage is to produce a high-quality PR description before anything is pushed. It is the GitHub-shaped sibling of `/handoff`. Reuses TODO §3's curated-context pattern: `publishing --init` writes `publishing-context.md` deterministically from prior artifacts; the LLM session reads only that file.

Reads (via `publishing-context.md`):
- `brief.md` — original intent, acceptance criteria, non-goals
- `plan.md` — decisions, files-changed, test plan
- `build.md` — what got built, deviations from plan
- `validate-context.md` — already curated for review purposes; reused here
- `review.md` — reviewer's findings + decision
- `HUMAN_REVIEW.md` — author's sign-off notes
- The diff (`git diff <base_ref_sha>..HEAD`)
- Linked Linear ticket if `target.linear_ticket` is set (via Linear MCP)

Writes:
- `stages/7_publishing/pr-draft.md` — title (line 1) + body (rest). This file becomes the PR description verbatim.
- `stages/7_publishing/pr-meta.yaml` — base branch, suggested reviewers, labels, linked Linear ticket URL, draft-vs-ready flag.

STOPs with a banner instructing the human to review `pr-draft.md`, edit it directly if needed, then run `/publish-pr` to push — or `/bounce` if the draft reveals the implementation itself is wrong.

The draft is the artifact you said you need: "I want and need to see exactly what's going to get pushed." `pr-draft.md` is what gets pushed.

**`/publish-pr` — the human-gated push**

A thin command, not a stage. Validates `pr-draft.md` is non-empty, then forks on `completion.pr_number`:
- **Not set (first publish):** pushes the branch, runs `gh pr create --title "$(head -1 pr-draft.md)" --body-file <(tail -n +2 pr-draft.md)`, captures the returned PR number/URL into `completion.pr_number` + `completion.pr_url`, transitions `publishing → in_pr_review`.
- **Already set (re-publish, body changed):** runs `gh pr edit <pr_number> --title ... --body-file ...`. No `gh pr create`.
- **Already set, body unchanged:** `git push` only. PR auto-updates via the new commits.

`gh` failures (auth expired, branch protection forbids, network) keep the run in `publishing`, emit a structured error event, and the STOP banner reprints with the specific failure + remediation. Human fixes the cause, reruns `/publish-pr`. No partial state — either the PR exists and we transition, or it doesn't and we don't.

**`in_pr_review` — passive holding state, no polling**

No background process. No agent activity. No `pr-sync` command. The board shows `PR #1234 (link)` and the row sits until the human invokes one of:
- `/complete <run_id>` — does a one-shot `gh pr view --json state,mergeCommitOid`. Asserts `state == MERGED`. Records `completion.merge_sha` from `mergeCommitOid`. Transitions to `done`. Refuses if not yet merged.
- `/bounce <run_id>` — pulls open PR comments at invocation time (single `gh api repos/<owner>/<repo>/pulls/<n>/comments`), populates `change-request.md` from the response, transitions to `building`. No background sync — comments are fetched on demand only.
- `/closed <run_id>` — human marks "team closed this PR without merging." Transitions to `closed`.
- `/abandon <run_id>` — author's call; transitions to `abandoned`. Leaves PR open on GitHub untouched (see hard parts).

**Re-entering `building` from `in_pr_review` (`change-request.md`)**

When `/bounce` pulls PR comments, it writes `change-request.md` to the new building stage's directory. This is the curated entry point (analog of `*-context.md` from TODO §3). Shape:

```markdown
# Change request — PR #1234 (round N)

## Reviewer threads
### thread 1 — src/exports/csv.py:147 (reviewer: alice)
> "This unconditionally loads all archived profiles into memory. Can we stream?"

### thread 2 — tests/test_exports.py:89 (reviewer: bob)
> "Missing explicit test for the false case."

## CI failures (if any)
- buildkite job xyz: pytest tests/test_exports.py::test_archived_filter — assertion failed (link)
```

The builder reads `change-request.md` first; `brief.md` and `plan.md` remain available if the comments warrant replanning. After `building`, the run flows back through `validating → human_review → /publish-pr` as normal — re-validate is the existing invariant, not optional. Because `/publish-pr` is deterministic on `pr_number`, the same PR gets updated (no new PR created).

**`closed` — new terminal state**

PR was closed without merge (declined, superseded, abandoned by team). Terminal. Distinct from `abandoned` because `abandoned` was the author's call; `closed` was the team's. Both preserve artifacts. Reached only by explicit human `/closed` invocation — the workbench never closes PRs itself.

### What `/complete` does in `github-pr` mode

`/complete` in `in_pr_review` is a verification-only command, not a merge. It runs `gh pr view --json state,mergeCommitOid` once, asserts `state == MERGED`, and records the SHA. No `git merge`, no `gh pr merge`. The human does the actual merge via GitHub UI or `gh pr merge` themselves; `/complete` just acknowledges it landed.

This preserves the workbench's "we don't talk to remotes for write operations on behalf of the agent" stance. The only `gh` writes anywhere in the lifecycle are `gh pr create` and `gh pr edit --body/--title`, both gated behind explicit human `/publish-pr` invocation.

### Hard parts worth flagging

1. **CI failures vs. reviewer comments are different change types.** Both end up in `change-request.md` when the human bounces, but CI failures are deterministic and a future automation could act on them autonomously; reviewer comments often need judgment. Tag `change-request.md`'s top-level type (`ci_only`, `reviewer_only`, `mixed`) so future automation has a hook. V1: tag the field, don't act on it.
2. **Stale PR state on `/abandon`.** Abandoning a run with an open PR orphans the PR on GitHub. The workbench does **not** close it — that would be an unsolicited write. `/abandon` records the orphan in metadata (`completion.pr_orphaned: true` plus the URL); the human decides whether to close it on GitHub themselves. The STOP banner surfaces the PR URL and reminds the human it's still open.
3. **Branch-name stability across bounces.** PRs anchor on branch names. Today the branch (`agent/<slug>`) stays stable across `human_review → building` bounces; the same invariant must hold across `in_pr_review → building` bounces or PR updates will fail.
4. **Multi-round comment state.** PR comments accumulate across rounds. `/bounce` pulling at invocation time gets the *current* snapshot from GitHub, including comments marked resolved. The `gh api` query should filter to unresolved threads (or annotate resolved ones) so the builder doesn't re-address already-resolved feedback. Heuristic: `is_resolved == false` from GraphQL `pullRequestReviewThreads`. V1 may take the simpler "all comments since last push timestamp" approach; revisit if it produces noisy `change-request.md` files.
5. **Re-publish body diffing.** When `publishing` re-runs after a CR cycle, the new `pr-draft.md` may be substantially different from the previous one (different rationale, different test coverage). The human is reading `pr-draft.md` fresh each cycle — the previous draft is archived under `archive/`. No automatic diffing; the human reads the current draft as they would the first one.

### Tasks

This will land across several runs. Discrete unit-of-work breakdown:

- [ ] Update `schemas/transitions.yaml` with the new states (`publishing`, `in_pr_review`, `closed`) and their transition evidence requirements. `publishing → in_pr_review` needs `pr_number`, `pr_url`, `branch_pushed_sha`. `in_pr_review → done` needs `merge_sha`. `in_pr_review → closed` needs `closed_by`.
- [ ] Add `completion.delivery`, `completion.pr_number`, `completion.pr_url`, `completion.merge_sha`, `completion.pr_orphaned` to `schemas/run-metadata.yaml`. (`schemas/run-metadata.yaml` is now load-bearing per `lib/metadata.py`; add the fields to the schema so typos are caught.) No new fields under `target` — the choice is made at terminal-command time.
- [ ] Build the `publishing` LLM-bearing slash command. `publishing --init` writes `publishing-context.md` deterministically from brief + plan + build + validate-context + review + HUMAN_REVIEW + diff + linked Linear ticket. The LLM session reads only `publishing-context.md` and writes `pr-draft.md` + `pr-meta.yaml`.
- [ ] Build `cmd_publish_pr.py` — validates `pr-draft.md` non-empty; forks on `completion.pr_number` (create vs. edit vs. push-only). Captures `pr_number`/`pr_url` on creation. On `gh` failure, keeps run in `publishing` and emits structured error event for the STOP banner.
- [ ] Update `cmd_complete.py` for `in_pr_review`-state runs: one-shot `gh pr view --json state,mergeCommitOid`, assert merged, record `merge_sha`, transition to `done`. Local-merge path (called from `human_review`) preserved unchanged.
- [ ] Update `cmd_bounce.py` to handle the `in_pr_review → building` path: pulls open PR comments via `gh api repos/<owner>/<repo>/pulls/<n>/comments`, writes `change-request.md` to the new building stage, with `change_request_type: ci_only | reviewer_only | mixed` annotation.
- [ ] Add `cmd_closed.py` — small command for human-invoked `in_pr_review → closed` transition.
- [ ] Update `cmd_abandon.py` to detect an open PR and record `completion.pr_orphaned: true` + URL in metadata. Does **not** call `gh pr close`. STOP banner mentions the orphaned PR.
- [ ] Board changes — surface `completion.pr_number` + URL on `publishing` / `in_pr_review` / `closed` rows. No CI/approval status (those are read on GitHub directly).
- [ ] Documentation — `architecture.md` § "Non-goals for V1" currently says "No PR creation." Update with the new contract: `gh pr create` + `gh pr edit --body/--title` are the only writes; everything else is read-only `gh pr view` / `gh api`. Update `docs/lifecycle.md` with the new states and the `human_review` fork.
- [ ] Tests — E2E coverage for happy path (`human_review → publishing → in_pr_review → done` via simulated `gh` binary), CR path (`in_pr_review → /bounce → building → ... → publishing` with `change-request.md` populated from fake `gh api` output), closed path, abandon-with-open-PR path. `local-merge` regression suite stays untouched.

### Acceptance

- From `human_review`, `/publish-pr` drafts `pr-draft.md`, STOPs; a second `/publish-pr` (after human review) pushes and creates the PR via `gh pr create`, transitions to `in_pr_review` with `completion.pr_number` + `completion.pr_url` recorded.
- `pr-draft.md`'s body cites: acceptance criteria from `brief.md`, the actual diff (files + LOC), the test plan from `plan.md`, and any deviations from `build.md`. Title is one line, ≤72 chars, imperative mood.
- After the PR is merged on GitHub, `/complete` does a one-shot `gh pr view`, records the merge SHA, and transitions to `done`. No `git merge` runs locally.
- `/bounce` from `in_pr_review` pulls open PR comments via `gh api`, writes a populated `change-request.md` with `change_request_type` tag, transitions to `building`. A subsequent `/publish-pr` updates the existing PR (via `gh pr edit`), does not create a new one.
- `/abandon` from `in_pr_review` records `completion.pr_orphaned: true` in metadata, leaves the PR open on GitHub, and the STOP banner surfaces the PR URL.
- The workbench never calls `gh pr comment`, `gh pr review`, `gh pr merge`, `gh pr close`, `gh pr edit --add-reviewer`. Only `gh pr create`, `gh pr edit --title/--body`, `gh pr view`, `gh api .../comments` (read-only).
- `local-merge` runs continue to work exactly as today — no regression in the `/complete`-from-`human_review` path.
- The board shows distinct rows for `publishing`, `in_pr_review`, `closed`.
- `architecture.md` and `docs/lifecycle.md` document the new states and the `human_review` fork.

### Non-goals

- **No PR comment writes by the workbench.** The agent never posts comments, never resolves threads, never requests reviewers. The human does all of those via GitHub UI or `gh` themselves.
- **No auto-merge.** Even when CI + reviews are green, the human runs `gh pr merge` or clicks the GitHub button. `/complete` only verifies and records.
- **No auto-close on `/abandon`.** Orphaned PRs are recorded but left open; the human decides their fate.
- **No background polling.** No `pr-sync`, no cron, no webhooks. State changes happen only when the human invokes a command.
- **No auto-assigning reviewers from CODEOWNERS.** `pr-meta.yaml` may *suggest* reviewers in the draft for human review, but `gh pr create` is invoked without `--reviewer` flags. Reviewers are added on GitHub manually.
- **Multi-PR runs.** One run still maps to one branch maps to one PR.
- **Cross-repo PRs / monorepo PR splits.** Out of scope until the multi-repo run model lands.
- **Merge-strategy configurability (squash/rebase/merge).** Whatever the GitHub repo's settings allow is what happens; the workbench is uninvolved.

### Origin

Surfaced 2026-05-25 by the user after I sketched a too-thin `/publish` slash command in a prior turn. Refined 2026-05-26: an earlier draft of this section had a per-run `target.delivery` field set at `new-run` time, an automated `pr-sync` poller, an adversarial-review subagent inside `publishing`, and `/abandon` prompting to close PRs. All four were cut. The delivery choice belongs at the terminal boundary, not the run's identity. There is no polling because re-reading the PR on GitHub is the human's job; the workbench only fetches comments when the human explicitly bounces. The adversarial pass was redundant with `/validate`'s standard review. And the workbench never writes PR state it wasn't explicitly asked to write — closing a PR on the user's behalf is exactly the kind of unsolicited remote action the architecture refuses.

---

## 9. Restrictive tool policy for the `publishing` stage only (relevant once §8 ships)

Today the workbench's safety story is filesystem-via-worktrees + evidence-gated transitions. There's no per-run tool bounding because there's no need — `local_only: true` in `agent-workbench.yaml` means no remote calls, the worktree confines git operations to one branch, and the agent's shell tool is the agent's-harness problem.

§8 punctures that **for one stage**. `cmd_publish_pr.py` runs `gh pr create` (pushes the branch, creates a PR against a real GitHub repo). `cmd_pr_sync.py` runs `gh pr view --json …` and `gh api repos/<owner>/<repo>/pulls/<n>/comments`. The architecture statement "Talk to GitHub or any remote API → Agent Workbench does NOT do this" becomes false during `publishing`. Blast radius for that stage grew from "the worktree" to "the user's GitHub credentials + every repo they can write to."

The narrow threat: an agent inside `publishing` could run `gh pr merge`, `gh repo delete`, `gh api` against an unrelated repo, or `git push --force` to an unrelated branch. Restricting that one stage is sufficient. Every other stage stays safe under the user's default Claude Code allowlist — `git` is worktree-bounded, test runners and file I/O are filesystem-bounded, none touch remotes, and the default allowlist doesn't include `gh` for them to misuse.

### Design — one stage, one policy

**`publishing`** runs under a restrictive allowlist written per run. Every other stage (`shaping`, `planning`, `building`, `validating`, `followups`) inherits the user's default Claude allowlist with no per-run override and no per-run policy file.

Why this works:

- **The threat surface is exactly one stage.** `publishing` is the only stage that legitimately needs `gh`. There's nothing for a per-stage policy to add for the others that the global allowlist isn't already doing — the default allowlist doesn't include `gh`, so non-publishing stages can't call it regardless.
- **`in_pr_review` doesn't need a policy.** Per §8 it's a passive wait state — no agent activity. `cmd_pr_sync.py` is invoked by the human (or cron), not by an LLM session. The workbench's CLI code is trusted code, not agent-emitted shell.
- **Symmetry with worktrees.** Worktrees are the filesystem bound; this is the remote bound. Both narrow and load-bearing, not blanket.

### What the `publishing` policy contains

A static YAML file the workbench writes per run at `publishing`-stage entry. Loaded by the harness; commands outside the list are refused.

```yaml
# stages/7_publishing/tool-policy.yaml — written by `/publishing --init` for pull-request runs
schema_version: 1
kind: tool_policy
stage: publishing

shell_allowlist:
  - gh pr view                       # read PR state
  - gh pr create                     # create the PR (the one mutating call this stage needs)
  - gh api repos/<owner>/<repo>/*    # scoped reads against the target repo only
  - git push origin <branch>         # push the branch this PR will open against
  - git diff
  - git log
  - git status

shell_denylist_explicit:
  - gh pr merge                      # workbench never auto-merges; human merges via gh / GitHub UI
  - gh pr close                      # closing happens via /abandon, not by the publishing agent
  - gh repo *                        # no repo-level mutations
  - git push --force*
```

`<owner>/<repo>` and `<branch>` are templated at policy-write time from the run's `target.repo` and worktree branch name — so a `publishing` agent for a run targeting `klaviyo/app` cannot `gh api` against `klaviyo/fender` even though the user's credentials cover both. This is the "per-run scope" piece: not a separate concept, just substitution into the allowlist patterns.

The explicit denylist exists for clarity even though the allowlist would already block these — `gh pr merge` and `git push --force` are foot-guns worth naming so a future loosening of the allowlist (e.g. adding `gh pr *`) can't accidentally permit them.

### Enforcement path

**Harness-mediated.** The workbench writes the policy file at stage entry; the Claude Code harness reads it via a settings.json hook (PreToolUse) and refuses tool calls outside the list. No new infrastructure beyond emitting the file.

If a future harness can't honor the policy file, the escalation is a wrapped `gh` on a stage-specific PATH — but this is YAGNI until a second harness shows up. For V1, Claude Code is the harness, and its hooks are sufficient.

This is **not** capability tokens (no crypto, no expiry, no issuance). Static file, loaded at stage entry, denying anything not listed. AppArmor-shaped, not OAuth-shaped.

### Tasks

- [ ] **Do nothing until §8 actually starts.** Sequential dependency. Pre-§8, no stage has a remote-mutating tool surface, so there's nothing to restrict. Adding policy infrastructure now would be premature.
- [ ] **When §8 starts: spec the policy file.** Settle the exact `shell_allowlist` for `publishing` once `cmd_publish_pr.py` is landing — the allowlist follows the commands the implementation actually needs, not the other way around. Document the contract (`shell_allowlist`, `shell_denylist_explicit`, templated `<owner>/<repo>`/`<branch>`) in `schemas/tool-policy.yaml`.
- [ ] **Wire the hook.** Claude Code's settings.json PreToolUse hook reads `stages/7_publishing/tool-policy.yaml` when the `/publishing` command starts and applies the allowlist for that session. Spike on `gh pr view` first to confirm the hook shape end-to-end before encoding the full list.
- [ ] **Add a `doctor` check.** `agent-workbench doctor` extends to scan a run's `events.jsonl` for any tool call emitted during `publishing` that isn't in that run's policy. Retrospective audit complements the preventative hook — if the hook misfires or a future harness ignores the file, doctor catches it.
- [ ] **Document the contract.** `agent-workbench-live/AGENTS.md` § "Publishing stage rules" names the policy and explains why this stage is special. Note in `architecture.md` that the workbench's safety bounds are now (1) worktrees for filesystem, (2) `publishing`-stage policy for remote — and that every other stage inherits the harness default.

### Acceptance

- `publishing` cannot run `gh pr merge`, `gh pr close`, `gh repo delete`, `gh api` against any repo other than `target.repo`, or `git push --force`. Attempts are refused by the hook and recorded by `doctor`.
- `publishing` CAN run `gh pr view`, `gh pr create`, scoped `gh api repos/<target.repo>/*`, and `git push origin <branch>`.
- Every other stage (`shaping`, `planning`, `building`, `validating`, `followups`) runs with no per-run policy file and inherits the user's default Claude allowlist — verified by `doctor` not flagging anything and by the absence of a `tool-policy.yaml` under those stage directories.
- `local-merge` runs never produce a policy file under any stage (no `publishing` stage exists for them).
- A run's policy file missing or malformed at `publishing` entry: `transitions.transition(... → publishing)` rejects with a clear error.

### Non-goals

Per-stage policy for stages other than `publishing` (the default Claude allowlist already covers them; adding per-run policy elsewhere is overhead with no threat to mitigate). Capability tokens (no crypto, no expiry). Sandboxing the agent's shell tool generally (worktree is sufficient bound for filesystem; `publishing` policy is sufficient bound for remote). OS-level network egress filtering (per-command policy, not a firewall). MCP-server-level policy (harness's problem). Wrapper scripts as primary enforcement (escalation only, if a future harness can't honor the file).

### Origin

Surfaced 2026-05-25 in a discussion of agent-workbench's safety mechanisms. The first draft proposed a full per-stage allowlist for every lifecycle state. Pushed back 2026-05-26: every stage except `publishing` is already safe under the default Claude allowlist (no `gh` in it, worktree-bounded `git`, filesystem-bounded I/O). The only stage that needs a policy is the one that punctures `local_only`, so the mechanism should be scoped to it. Net: one policy file at one stage boundary, not a per-stage matrix.

---

## 10. Cross-run dependencies — `depends_on` + upstream artifact reads for coordinated multi-run work

### Symptom

A single user-facing task that spans two repos (e.g. a frontend ticket and a backend ticket that share an API contract) has no first-class representation in the workbench. Each `/new-run` creates a run with a single `target.repo`, no awareness of sibling runs, and `/shape` + `/plan` only read from the run's own `runs/<id>/` directory. The two practical workarounds today are: (a) write the API contract into a shared `raw-idea.md` before both `/new-run`s and rely on convention to keep them in sync, or (b) sequence runs manually — finish the backend run through `/complete`, then drop a reference to its merged diff or `plan.md` into the frontend's `raw-idea.md` by hand. Both are convention-strength; nothing in the lifecycle, metadata, or slash commands knows that two runs are coordinated.

The asymmetry: agent-workbench has a strong cross-stage contract *within* a run (`build-context.md` lifts plan + brief artifacts deterministically; §5 generalizes this to the other LLM-bearing stages). There is no cross-*run* contract. A run that should be planned against another run's plan or build output has no declarative way to say so.

### Confirmed root cause

`schemas/run-metadata.yaml` has no `depends_on` field. `lib/cli/cmd_new_run.py` accepts a single `--repo-path` (`cmd_new_run.py:16`) and writes a single `target.repo` object. `lib/cli/cmd_shape.py` and `lib/cli/cmd_plan.py` read from `metadata.run_dir(cfg, run_id)` exclusively — there's no `iter_upstream_runs(cfg, run_id)` enumerator and no per-run hook that says "before staging the curated-entry file, also read these foreign run dirs." `lib/build_context.py` and the future plan/shape/followups context builders (§5) are single-run by construction.

### Proposed shape

Three pieces, smallest first:

**1. Schema field — `depends_on`** at `target.depends_on` in `schemas/run-metadata.yaml`. List of `{run_id, kind}` pairs where `kind ∈ {plan, build, complete}` describes which upstream lifecycle stage the dependency reads from. `plan` means "read upstream's `plan.md` + `decisions.md`" (use when upstream is still in `planning` or `ready`); `build` means "read upstream's `build.md` + worktree diff" (upstream must be in `validating` or later); `complete` means "read upstream's merged diff against the parent ref" (upstream must be `done`). Optional `scope` string for free-form notes ("API contract" / "shared types"). Empty list (or absent) for standalone runs — today's default.

**2. CLI surface — `--depends-on <run_id>[:kind]`** as a repeatable flag on `agent-workbench new-run`. Resolves the run_id (errors if not found), validates the upstream's current state allows the requested `kind` (e.g. you can't say `--depends-on X:build` if X is still in `planning`), writes the dependency into `target.depends_on`. Default `kind` is `complete` (safest — upstream is fully merged) when the upstream is already `done`; otherwise `kind=plan`.

**3. Stage-context hook — `*-context.md` builders read upstream artifacts.** `lib/build_context.py` and the future `lib/plan_context.py` (§5) each gain an "Upstream dependencies" section that materializes summaries of the artifacts named by `target.depends_on`:
- For `kind=plan`: inline the upstream's `plan.md` "Proposed changes" + "Files likely to change" + "Data model changes" sections, plus all DR/ASM blocks from `decisions.md` / `assumptions.md`.
- For `kind=build`: inline the upstream's `build.md` "Implementation summary" + "Files changed" + "Acceptance criteria coverage", plus a `git diff <upstream-base-ref-sha>..<upstream-worktree-HEAD> --stat` rollup.
- For `kind=complete`: inline the upstream's `HUMAN_REVIEW.md` summary block, plus the merge SHA and a `git diff <merge-parent>..<merge-sha> --stat` rollup against the actual merged state.

The reader (planner, builder, etc.) gets the same curated-context discipline as today, just expanded to cover upstream runs. Cache cost is bounded — one curated section per dependency, not a free read of the foreign run dir.

### Tasks

- [ ] **Schema work in `schemas/run-metadata.yaml`** — add `target.depends_on` as an optional list. Define the `{run_id, kind, scope?}` shape; specify which `kind` values are valid against which upstream states. The schema is now load-bearing (consumed by `lib/metadata.py:_validate_against_schema`), so add the new structure there to keep typos caught.
- [ ] **`lib/cli/cmd_new_run.py`** — accept `--depends-on <run_id>[:kind]` (repeatable). Resolve via `metadata.load`, validate upstream state vs. requested kind, write into metadata. Emit a `DependencyRecorded` event per dependency for the audit trail.
- [ ] **`lib/dependencies.py` (new module)** — helpers: `resolve_upstream(cfg, run_id) -> list[UpstreamRun]`, `validate_kind_against_state(upstream_state, requested_kind) -> None | error`, `extract_upstream_artifacts(upstream_run, kind) -> UpstreamSnapshot`. Keep the I/O paths centralized so the context builders (next task) don't reimplement them.
- [ ] **Extend `lib/build_context.py`** — add an "Upstream dependencies" section that iterates `target.depends_on` and inlines per-kind summaries. Skip silently (with a comment) if the list is empty; today's runs are unaffected.
- [ ] **Extend the future `lib/plan_context.py` (§5)** with the same hook. The planner is the most likely consumer — frontend planning against a backend's `plan.md` is the canonical use case.
- [ ] **`.claude/commands/new-run.md`** — document the `--depends-on` flag. Add an example: backend run finishes planning → frontend run created with `--depends-on <backend-run-id>:plan`. Make clear the agent doesn't infer dependencies; the human declares them.
- [ ] **`.claude/commands/plan.md` and `build.md` (§3)** — add a line to the step-1 read instructions: "If `target.depends_on` is non-empty, the curated context file's 'Upstream dependencies' section is the source of truth for what upstream runs decided. Do not re-read their full run dirs."
- [ ] **`docs/lifecycle.md`** — add a new section "Cross-run dependencies" describing the schema field, the kind→state matrix, and how `*-context.md` materializes upstream summaries. Cross-link from § draft (where `--depends-on` is declared) and § planning / § building (where the artifacts are consumed).
- [ ] **Audit `cmd_complete.py` and `cmd_abandon.py` for downstream impact** — if a `done` run is the upstream of an in-flight dependent, completing/abandoning it doesn't break anything (the dependent already has the upstream's frozen artifacts in its own `<stage>-context.md`), but the audit should call this out. Decide: warn on `/abandon` if there's an active downstream dependent? Probably yes — surface the link, let the user decide. No hard block.
- [ ] **Tests under `tests/test_dependencies.py`** — schema validation (valid/invalid `kind` for given upstream states); `cmd_new_run` accepts `--depends-on` and writes metadata correctly; `build_context.build` produces an "Upstream dependencies" section when deps are present and omits the section when they aren't; the section correctly excerpts upstream `plan.md` / `build.md` per kind.
- [ ] **E2E test** — two synthetic runs against two synthetic repos. Run A: shape → plan → start → validate → complete. Run B: created with `--depends-on <run-A>:complete`. Drive Run B through `/plan`; assert `plan-context.md` contains Run A's merge SHA, file list, and brief excerpt. (Bundles a §5 acceptance test naturally.)

### Acceptance

- `agent-workbench new-run --repo-path <frontend-repo> --idea-file foo.md --depends-on <backend-run-id>:plan` succeeds when the backend run is in `planning`/`ready`/later; fails with a clear error when the kind is incompatible (e.g. `:build` against a backend run still in `shaping`).
- The frontend run's `plan-context.md` (when §5's plan-context ships) and `build-context.md` carry an "Upstream dependencies" section with concrete per-kind excerpts from the backend run. Without `--depends-on`, neither file has the section — today's behavior preserved.
- `runs/<frontend-run-id>/metadata.yaml` carries `target.depends_on: [{run_id: <backend-run-id>, kind: plan}]`. The schema validator (`lib/metadata.py`) accepts it.
- `agent-workbench abandon <backend-run-id>` while a downstream `<frontend-run-id>` is in-flight prints a warning that the downstream exists, names it, and continues. No hard block — the downstream has the upstream's frozen artifacts and can finish.
- An E2E test demonstrates the full flow on synthetic repos; would fail under today's behavior if the dependency-consuming code path were reverted.

### Non-goals

- **Autonomous chaining of runs.** This TODO adds declarative dependencies, not a scheduler. The user still runs `/new-run` + `/shape` + `/plan` + `/start` for each run individually; the only thing that changes is downstream runs can name upstream ones and consume their artifacts. Auto-firing `/start` on Run B when Run A hits `done` is explicitly out of scope — that collides with the `ready → building` human gate and isn't worth the blast-radius increase for the cardinality of cases we see (two coordinated runs, occasionally three).
- **Multi-repo single-run.** This is not a step toward "one run with N target repos." The cardinality stays one repo per run; coordination happens *between* runs via `depends_on`, not *inside* one.
- **Bidirectional dependencies / sibling sync.** No mechanism for Run A and Run B to keep their plans synchronized as they each evolve. The contract is strictly upstream → downstream, materialized at the downstream's `<stage>-context.md` build time. If both sides need to evolve together, the user re-runs `/plan` on the downstream after the upstream changes.
- **Cycle detection beyond trivial cases.** A → B → A is rejected at `--depends-on` time by checking the target's own `depends_on` graph; deeper cycles (A → B → C → A) are out of scope until they actually occur.
- **Cross-machine dependency resolution.** Upstream run dirs must be readable on the local filesystem. If Run A lives on a different machine, the workbench can't materialize its artifacts; this is the same constraint as everything else in the workbench today.
- **Auto-detecting dependencies from idea text.** The human declares dependencies explicitly via `--depends-on`. No NLP heuristic that says "this idea mentions a backend ticket, let me link to it."
- **Changing how `/complete` merges.** Downstream runs that depend on `:complete` read the merged diff from the parent branch's history; the merge mechanics in `cmd_complete.py` don't change.

### Origin

Surfaced 2026-05-27 in conversation about how to coordinate a frontend ticket and a backend ticket as one logical unit of work. First proposal was "multiple repos as input to one run"; the schema and CLI both rejected that. Second proposal was "sequence runs and have them cross-pollinate." Pushback: autonomous chaining of `/start`s is a real blast-radius increase against the lifecycle's human gates, and the actually-hard part isn't sequencing — it's giving the downstream run access to the upstream's artifacts in a curated, cache-disciplined way. Net: `depends_on` + upstream artifact reads from inside the existing `<stage>-context.md` contract is the right shape. Autonomous chaining stays out of scope until the manual sequencing pattern surfaces enough friction to justify it.




---
**06/06** (after moving to archive
EDIT EXISTING
- write summaries of what happened at end of prompt -> load into HUMAN_REVIEW.md
- allow role to prompt user with questions AFTER reading codebase 

- repo - move this logic to its own repo
- worktree pathing
  ```
  /Users/timothy.shee/GitHub/new-tech-monorepo/.claude/worktrees/agent-a023f6f24d0436263
  ```
  - need to move it to separate folder to not pollute master
- HUMAN_REVIEW.md always showing same text instead of the actual change summary
  ```
  - 2 doc(s) touched:
    - `README.md — added a /hello endpoint example`
    - `docs/api.md — documented the new response schema`
  ```
  >   One real blocker the human needs to know before deciding: the diffstat reads 0 files changed, +0 / −0 lines because the worktree's changes are still uncommitted. The 643-line diff exists
  on disk but is unstaged — /complete will need to merge whatever ends up committed on agent/subagent-cost-measurement, so commit the worktree before /complete.
  ```
  Diffstat:
    0 files changed, +0 / −0 lines
  ```
- `build.md` is blank???
  ```
  /Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260527__schema-level-validation-for-metadata-yaml/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-27-schema-level-validation-for-metadata-yaml/stages/4_building/build.md
  ```
- QA.md sometimes skipping smoke tests on things that NEED smoke tests. New features and regression tests are important
  - not always running smoke tests
- base ref SHA
  1. Fix lib/yaml_io._parse_scalar UTF-8 double-quoted-string corruption (bug_risk) — s.encode().decode("unicode_escape") shreds non-ASCII through Latin-1; each round-trip doubles the corruption. Discovered when the backfill turned a 263KB mojibake'd s2-attrs/metadata.yaml into 525KB. tools/backfill_completion_refs.py and any metadata.update caller is at risk. Replace with a real YAML escape table.
  2. Make test_human_review.py snapshot tests date-stable (tech_debt) — test_happy_snapshot and test_bounce_pass2_snapshot fail every day
  except 2026-05-22 because _normalize doesn't collapse YYYY-MM-DD- run-id prefixes. Hides real regressions. Either extend _normalize or inject a frozen test date.  
  3. Promote _effective_ref to a shared helper (refactor) — there are now three copies of the prefer-SHA / lazy-resolve pattern
  (metrics/lines.py, validate_context.py, plus inline two-liners in doc_claims.py + board/source.py). DR-001 deferred this at copy #2 saying "extract at the third copy" — that moment has arrived. Add lib/refs.py.
  4. Recover v2 source repo or relax AC 5 of the original brief (deferred_from_bounce) — AC 5 named 2026-05-22-token-efficiency-tracking as the dogfood target, but its source repo (a v2 LOCAL_worktrees path) no longer exists. Either re-clone v2 to verify the live number, or set a policy: future briefs shouldn't name specific historical runs as acceptance targets — use synthetic fixtures or "any one pre-fix run" wording.
  5. tools/backfill_base_ref_sha.py --write-audit-event mode (scope_extension) — AC 9 of this run forbade synthesizing BaseRefResolved
  events into old events.jsonl files (forward-only). That's the right default, but it means there's no audit-log evidence of the resolution for backfilled runs. Add an opt-in flag that emits a BaseRefResolved event tagged with backfilled_at + backfill_source so it's distinguishable from original events.
- Personal vs Work implementations
  - Personal - terminal state is to merge to master
  - Work - terminal state is to push up Draft PR
- clean up git history
- explain this threshold for number of turns
  - example failure case
    ```
    Run 2026-05-27-generalize-stage-context-md-followups reached the fresh-session handoff at the building → validating boundary. TODO §5 is implemented and committed on
    agent/generalize-stage-context-md-followups (commit f949c33, 23 files, +2569 LOC). The building session crossed the staleness threshold (241 / 100 turns) and the CLI is asking for a fresh Claude Code session to do the validation pass.
    ```
- explain this sudden stop
  ```
  ⏺ The CLI explicitly tells me to stop, exit Claude Code, and restart in the worktree with a fresh session (building session reached 109 turns; threshold 100). This is a built-in pause mechanism for context hygiene — the validate-context.md was generated and the next session will bootstrap from it.

  Per the contract, I stop here. The run is now in validating; build.md was promoted into stages/4_building/. The next session continues with /validate 2026-05-27-handoff-rendering-failure-cluster from inside the worktree.
  ```
- fix this suddent stop
  ```
  To continue the lifecycle, per the CLI's instruction:

  cd /Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260527__generalize-stage-context-md-followups
  claude
  /validate 2026-05-27-generalize-stage-context-md-followups

  The fresh session bootstraps from stages/5_validating/validate-context.md plus blast-radius.txt — both are already on disk.
  ```
- fix bugs in code
  ```
  Notable engineering decision during implementation: the brief's DR-004 said cfg should be a required positional argument on build_context.build(). I reversed that during implementation
  when I saw the existing unit-test fixtures call build() without cfg — making it optional (cfg=None defaults; section omitted when None or no deps) preserved all existing tests without
  code-changes and matched the existing "convenience artifact, fail safe" pattern. Documented inline in the new docstring.
  ```
  ```
  Also discovered a latent issue in lib/yaml_io.py: dumps emits empty lists as [] (flow style), but loads rejects flow style — so writing target.depends_on: [] would have round-trip-failed.
   Worked around by only writing target.depends_on to metadata when non-empty; readers treat absence as empty list. Worth a separate TODO if the maintainers want to address it generally;
  out of scope here.
  ```
- explain threshold for number of runs
- Playwright MCP for validation of UI features -> currently only ran backend testing
* [ ] Fix the malformed summary-of-changes formatting where file paths can get double backticks, for example:
  * Current bug: `` `lib/runs.py` ``
  * Expected: `` `lib/runs.py` ``
- fix: bugs in code
  - F-001: lib/yaml_io.dumps([]) emits flow-style [] that loads rejects — workaround is correct but the underlying defect is latent. Recommended as a future TODO §13.
  - F-002: The cmd_abandon downstream-dependent warning is unit-tested at the lookup level but not at the CLI-stderr level. Worth ~20 LOC to extend TestE2ECrossRunDependencies.
  - F-003 (process): build.md is the bare template — no narrative or "Deviations from plan" entry, which should have called out the DR-004 reversal. Curated context built from
  brief/plan/diff so not blocking, but worth knowing.
  - DR-004 reversal: Made cfg=None keyword-only instead of required positional. Reviewer says defensible (consistent with DR-005's never-raise-mid-render contract), but flags it for human
  sign-off.
- sort `agent-workbench list` output
- make output from `agent-workbench board` copy pastable
---
- Investigate how to speed up rereading entire repo of info? GBrain? GitNexus
- Investigate how to use Agent SDK and track cost more cleanly



BUILD FROM SCRATCH
Current issue is that there's too much code. I think I can strip it down and start from scratch again.

I need it to do this workflow
```
initialize
draft - ask me questions
shape - build brief
plan - brainstorm solutions after scanning files
implement - apply solutions
implement-unit-tests - create unit tests
qa - smoke test, optional to skip
complete / abandon / bounce
```
- logging
- quality assurance)