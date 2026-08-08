---
name: implement-feature
description: The house workflow for implementing a feature or fix in agent-workbench itself — plan.md first, converge on the smallest correct change, keep slices few, verify before claiming done. Use when asked to implement, add, change, or fix something IN this repo (not to drive a task against another repo). Points at create-worktree / run-workbench-task / close-worktree rather than duplicating them.
---

# Implement a feature (in agent-workbench)

This is the authoring/planning workflow for changing **this repo's own code**.
It is deliberately thin: it encodes the *order of operations* and hands off the
mechanical steps to the skills that already own them. If you instead want to
drive an implementation *through the workbench against another repo*, use
`run-workbench-task` — not this.

Read `AGENTS.md` first (it is the source of truth for architecture, the "Where
things live" map, and the "Things NOT to do" list). For anything under the
Temporal worker, also read `workers/temporal-worker/src/activities/AGENTS.md`.

## 1. Plan first — always

Per the global CLAUDE.md, no non-trivial change starts without a `plan.md`:

```
plan.md
- brief          # what's wrong / what to do, in 2–3 sentences
- changes        # the specific files + the edit each gets
- tests
  - unit         # focused, parametrized, co-located with source (Vitest)
  - manual       # a concrete way to observe it working (a script, a CLI run)
```

Keep the plan honest and small. If the change spans more than a few files,
say why in the brief — do not silently fan out.

## 2. Isolate the work (worktree)

Non-trivial or parallel work goes in its own worktree off local `main`:

- Create it with the **`create-worktree`** skill (bases off LOCAL main, routes
  to `LOCAL_worktrees/`). Always operate with explicit `git -C <worktree-path>`.
- One worktree per independent unit of work. If you need to run the workbench
  runtime from a worktree, boot it **pinned** (`pnpm -C <path> build` then
  `awb up`) — see create-worktree's "Running the workbench from this worktree".

Note: two `awb up` stacks from two worktrees still collide on ports/queue today
(TASK-59). Don't run a second live stack until that lands.

## 3. Implement — smallest correct change

Follow the repo's coding philosophy (AGENTS.md "Coding philosophy"):

- Simplest solution that satisfies the spec; no speculative abstraction.
- Strict TypeScript, no `any`, Zod at every process/persistence boundary.
- Default to **no comments** — write one only when the *why* is non-obvious.
- Respect the package boundaries: no I/O in `@awb/workflow` (Workflow code is
  deterministic — I/O lives in `workers/temporal-worker/src/activities/`); writes
  go through the daemon (single writer); agents never decide phase completion.
- Keep the change in as few "slices" as the work honestly needs. A slice that
  balloons past the guardrail cap (`slice-guardrail.ts`) is a signal to stop and
  checkpoint, not to push through.

## 4. Verify — before claiming done

Prove it, don't assert it. From the worktree root:

```bash
pnpm -C <worktree-path> build        # dist must build (packages compile in dep order)
pnpm -C <worktree-path> test         # Vitest; a bare run leaves telemetry OFF
```

- Add/extend **focused, parametrized** unit tests co-located with the source.
- Do the **manual** check from your plan and report its real output — if a test
  fails or a step was skipped, say so. Never report green you didn't observe.
- For a runtime-level change, a MOCK `awb up` is a plumbing dry-run only (fake PR
  in ~90s, zero tokens); a real behavioral claim needs a `claude`-runtime run
  (`run-workbench-task` covers driving one). Distinguish the two in your report.

## 5. Land it

When the change is verified, land + clean up with the **`close-worktree`** skill
(checks for an already-merged branch, else rebases onto local main and
fast-forwards, then removes the worktree and deletes the branch). Commit directly
with git; **do not push unless explicitly asked**.

## Anti-patterns (from this repo's live dogfood)

- Ending a session at "here's the plan" without writing the code — the global
  CLAUDE.md forbids it. Plan *and* implement in the same session unless told to
  stop at planning.
- Reporting a DB row count of "0 changes" when the agent's worktree actually has
  a diff — check the worktree, not just the daemon state.
- Trusting a green from string-grep QA over an adversarial correctness read — the
  static checks miss runtime/data-integrity bugs.
- Editing source while a workbench **task** is editing the same worktree under
  `awb up --dev` — a save hot-reloads the daemon mid-run. Use pinned mode.
