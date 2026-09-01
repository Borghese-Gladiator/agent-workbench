---
name: decompose-into-dag
description: Split one implementation request into a DAG of stacked-PR workbench tasks and declare it, so the Agentic Workbench drives them as stacked DRAFT PRs (each child's branch based on its parent's, each child starting when its parent opens its draft PR). Use when a request is too big for one PR and should land as an ordered chain (or fan-out) of smaller, individually-reviewable stacked draft PRs. Proposes the split, gets human approval describing each child task, then declares the graph via `awb task-dag create`.
---

# Decompose a request into a stacked-PR task DAG

This repo IS the Agentic Workbench. It can drive a **DAG of tasks** where each task
stacks on another: a child task's branch is based on its parent's delivered branch,
and a child only starts once its parent opens its **draft PR**. The result is a set of
**stacked draft PRs** reviewed bottom-up (PR#0 on `master`/`main`, each later PR based
on the previous task's branch).

Your job in this skill: turn ONE request into that graph. You do the thinking
(how to slice, what each child is, the edges); the workbench does the execution
(worktrees, branches, stacked draft PRs, scheduling). **You never run the
plan→implement→verify→QA loop yourself** — the scheduler + Temporal own that.

## When to use

- A request is clearly more than one reviewable PR (touches a schema + an API + a UI;
  or a sequence where step 2 builds on step 1's new code).
- The user asks to "split this", "break this into stacked PRs", "do this as a chain".

Do NOT use for a single self-contained change — create one ordinary task instead
(`awb task create`). A one-node "DAG" is just a normal task with ceremony.

## The mental model (read once)

- **Node = one workbench task = one draft PR.** Scope each node so its diff is one
  coherent, reviewable change.
- **Edges come in TWO modes** (TASK-102):
  - **`stack`** — the child's branch is **based on** the parent's delivered branch AND the
    child does not **start** until that parent opens its **draft PR**. Because a git branch
    has exactly one base, **each node has at most ONE `stack` parent.**
  - **`after`** — scheduling-only fan-in: the child does not **start** until the predecessor
    opens its draft PR, but it does **not** branch off it. A node may have **many `after`
    parents.**
- So the graph is a DAG, not just a forest: **fan-OUT** is fine (children sharing a base),
  and **fan-IN** is now expressible — a node with one `stack` base and one or more `after`
  predecessors, e.g. a **diamond** (D `after` B and C, both `after`/`stack` on A). Use
  `after` when a node must wait on extra predecessors it does not branch from; still pick a
  single `stack` base (or none, for a root that fans in purely for ordering).
- **Root(s)** have no parent → their PR base is the repo default branch, and they start
  immediately.

## Steps

### 1. Draft the split (you propose it)

Read the request (and skim the target repo if helpful). Decompose into an ordered set
of nodes. For each node write:

- a short `key` (e.g. `schema`, `api`, `ui`) — local to this declaration, used for edges,
- a **tightly-scoped prompt** pointing at the exact behavior/files for that PR,
- its parent (the node it stacks on), or none if it's a root.

Default to a **linear chain** when each step builds on the previous. Use **fan-out**
only for genuinely independent slices that share a common base. Keep nodes few and
meaningful — prefer 2–5 substantial PRs over many trivial ones.

There is no separate "umbrella" task: the first slice IS a root node. Do not create an
extra empty task to hold the others.

### 2. Get human approval (REQUIRED — describe each child)

Present the proposed DAG to the user for approval BEFORE declaring anything. Show, per node:
`key`, one-line objective, and its parent. Draw the shape, e.g.:

```
schema  (root, base=master)         "Add the task_dependencies columns + migration"
  └─ api   (base=schema branch)     "Expose /api/... reading the new columns"
       └─ ui  (base=api branch)     "Render the new field in the dashboard"
```

Ask the user to approve / edit / reject. Do NOT proceed to step 3 without approval.
If they reject the split, offer to run it as a single ordinary task instead.

### 3. Declare the DAG (the workbench executes it)

Once approved, declare the whole graph in ONE atomic call — it is validated (unique
keys, known refs, acyclic, single-parent) and topo-sorted before anything is written,
so a bad spec creates nothing.

Buildless CLI (from this repo):

```
pnpm --filter @awb/cli cli -- task task-dag create \
  --repo <path-or-id> \
  --node schema='Add the task_dependencies columns + migration' \
  --node api='Expose /api/... reading the new columns' --dep api=schema \
  --node ui='Render the new field in the dashboard' --dep ui=api
```

Equivalent HTTP (the CLI just POSTs this):

```
POST /api/task-dags
{ "repositoryId": "<id>",
  "nodes": [
    { "key": "schema", "prompt": "..." },
    { "key": "api", "prompt": "...", "dependsOn": "schema" },
    { "key": "ui",  "prompt": "...", "dependsOn": "api" } ] }
```

`dependsOn` accepts a plain key string (a single `stack` edge, back-compat) OR an array of
typed edges for fan-in, e.g. a diamond where `d` stacks on `b` and also waits on `c`:

```
{ "key": "d", "prompt": "...",
  "dependsOn": [ { "ref": "b", "mode": "stack" }, { "ref": "c", "mode": "after" } ] }
```

The response lists each node's real `taskId`, `parentTaskId`, and `scheduleState`
(`ready` for roots, `blocked` for children).

### 4. Let it run — do NOT hand-drive the chain

- **Roots start immediately.** Each blocked child starts on its own the moment its
  parent opens its **draft PR** (the scheduler resolves the child's base = parent's
  delivered branch and starts it). Independent siblings run in parallel.
- You still answer each task's normal gates (contract approval up front, etc.) per the
  `run-workbench-task` skill — but you never manually set base branches or thread
  branch names between tasks; the DAG does that.
- The outcome is N **stacked draft PRs**: PR#0 based on `master`/`main`, each later PR
  based on the previous task's branch. The workbench only ever opens DRAFT PRs — never
  mark them ready; the human reviews and merges bottom-up.

## Guardrails

- **At most one `stack` parent per node.** A node branches from exactly one base. If work
  needs extra predecessors it does not branch from, add them as `after` edges (fan-in) —
  do not force a second `stack` parent.
- **Never create a throwaway umbrella task.** The first slice is a root node.
- **Never push a node's base off `master` by hand** — declare the edge and let the
  scheduler resolve it lazily when the parent releases.
- **Approval is mandatory** before declaring (step 2). The split is a product decision.
- Keep this model-agnostic: the decision list here is mechanical enough for any model to
  follow; the only judgment is the slicing in step 1.
