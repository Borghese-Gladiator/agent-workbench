---
description: Run an Agent Workbench shaping pass. Code-blind. Reads raw-idea.md and writes brief.md per the lifecycle contract. Use when a run is in draft and needs a brief.
---

# /shape

LLM-bearing. Converts raw idea into a code-blind brief, then advances `draft -> shaping -> planning`.

## Step 1 — verify state and stage the template

Run this first (deterministic):

```bash
agent-workbench shape "$RUN_ID" --init
```

That:
- transitions `draft -> shaping`
- copies `templates/brief.md` into `runs/$RUN_ID/brief.md`
- writes `runs/$RUN_ID/stages/2_shaping/shape-context.md` — the curated entry point for this stage (TODO §5)
- prints the path you need to edit

If it fails (e.g. status is wrong), stop and tell the user. Do not edit metadata.yaml directly.

## Step 2 — read the curated context

Read `runs/$RUN_ID/stages/2_shaping/shape-context.md`. That file carries the raw idea verbatim, any clarifying answers from `/draft`, the brief.md template skeleton, and the two shaping rules — all built deterministically from the existing artifacts.

**Do NOT re-read** `raw-idea.md`, `answers.md`, or `templates/brief.md` separately if `shape-context.md` already covers what you need. The cache cost of those reads sticks in the session prefix forever.

## Step 3 — write the brief

Write a complete brief to `runs/$RUN_ID/brief.md`. Use the section headers already in the template:

- Goal
- User-facing behavior
- Acceptance criteria
- Non-goals
- Good examples
- Bad examples
- Constraints
- Assumptions
- Suggested QA scenarios

**Rules:**

- **Do NOT read code** in the target repo. This phase is code-blind.
- **Do NOT ask the user questions.** Only `draft` may. If something is ambiguous, write it as an assumption in the brief.
- Be specific. Bad examples and non-goals are as important as the goal.

## Step 4 — finalize the transition

When `brief.md` is complete:

```bash
agent-workbench shape "$RUN_ID"
```

That verifies the brief is non-empty and transitions `shaping -> planning`.

## Next step

Auto-chain: immediately invoke `/plan $RUN_ID` once `shaping -> planning` has been recorded by the CLI. Do not stop here. `/plan` itself auto-chains into `/start`, so the agent flows straight through `planning -> ready -> building` without stopping. The next (and only) human gate is `human_review`.

## Reference

`docs/lifecycle.md` § `shaping`.
