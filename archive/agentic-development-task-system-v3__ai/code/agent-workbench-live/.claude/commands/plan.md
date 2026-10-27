---
description: Run an Agent Workbench planning pass against the target repo. Writes plan.md, preflight.md, assumptions.md, decisions.md. Use when a run is in planning.
---

# /plan

LLM-bearing. Reads `brief.md` and the target repo, writes the four planning artifacts, then advances `planning -> ready`.

## Step 1 — stage templates and verify state

```bash
agent-workbench plan "$RUN_ID" --init
```

That:
- copies `templates/{plan,preflight,assumptions,decisions}.md` into the run dir if missing (staged runs get a single merged `plan.md`)
- writes `runs/$RUN_ID/stages/3_planning/plan-context.md` — the curated entry point for this stage (TODO §5)

## Step 2 — read the curated context

Read `runs/$RUN_ID/stages/3_planning/plan-context.md`. That file carries the full `brief.md`, a deterministic repo-map block (top-level dirs, detected languages, build/test commands inferred from target-repo manifests), the brief's "Files likely to change" section, the worktree metadata, and the `plan.md` template skeleton — all built without an LLM call.

**Do NOT re-read** `brief.md` or `templates/plan.md` separately if `plan-context.md` already covers what you need. The cache cost of those reads sticks in the session prefix forever.

You still need to read code in the worktree — that's where the planner's leverage lives. Use the repo-map in `plan-context.md` as a starting point.

## Step 3 — inspect the target repo

You may spawn `Explore` subagents to map the repo:

- one to find relevant files
- one to map data models or schemas
- one to map the UI surface

The master session collates their findings into `plan.md`. Subagents must not write to the run directory directly.

## Step 4 — write the four artifacts

### `plan.md`
- Current repo understanding
- Relevant files
- Proposed changes
- Files likely to change
- Data model changes
- UI changes
- Test plan
- QA plan
- Risks
- Definition of done

### `preflight.md`
Fill out the repo_path / repo_name / base_ref / branch_name / worktree_name fields and the checks block. Note any warnings.

### `assumptions.md`
Every assumption you made instead of asking the user. Use IDs `ASM-001`, `ASM-002`, … Each needs Text, Reason, Impact.

### `decisions.md`
Every design / implementation decision. Use IDs `DR-001`, `DR-002`, … Each needs Decision, Rationale, Alternatives considered, Why not the alternatives.

**Rules:**
- **Do NOT ask the user questions.** If something is ambiguous, record it as an assumption and choose the safest small implementation.
- If the task is too broad, reduce scope. Note in the plan what was deferred.

## Step 5 — finalize the transition

```bash
agent-workbench plan "$RUN_ID"
```

That:
- verifies all four artifacts are non-empty
- parses `assumptions.md` and `decisions.md` to emit `AssumptionRecorded` / `DecisionRecorded` events
- emits `PreflightCompleted`
- transitions `planning -> ready`

## Next step

Auto-chain: immediately invoke `/start $RUN_ID` once `planning -> ready` has been recorded by the CLI. The CLI still emits a `STOP.` banner on the `planning -> ready` transition for audit purposes, but `ready` is a transient state that the agent passes through — it is no longer an agent-stopping gate. The next (and only) human gate is `human_review`, owned by `/complete`, `/bounce`, and `/abandon`.

Before invoking `/start`, briefly tell the user:

- The `run_id` and that planning is complete.
- The path to `plan.md`.
- A one-paragraph summary of the proposed changes and the top risks.
- That you are now invoking `/start $RUN_ID` to create the worktree and begin implementation.

Then invoke `/start $RUN_ID`. `/start` will obtain `--approved-by` from the current user automatically (no prompt needed on the auto-chain path).

### Stop conditions (do NOT auto-chain)

Stop and hand control back to the user only if:

- The user explicitly told you to stop after `/plan` ("just plan it", "stop after plan", "don't start yet", etc.).
- The CLI returned a warning or non-zero status from `agent-workbench plan`.

## Reference

`docs/lifecycle.md` § `planning`.
