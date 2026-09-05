# Decompose a request into a stacked-PR task DAG

Load this when the route says `shape=dag`.

The workbench drives a **DAG of tasks** where each task stacks on another: a
child's branch is based on its parent's delivered branch, and a child starts only
once its parent opens its **draft PR**. The result is a set of **stacked draft
PRs**, reviewed bottom-up — PR#0 against `main`, each later PR against the
previous task's branch.

## The model

- **Node = one workbench task = one draft PR.** Scope each node so its diff is
  one coherent, reviewable change.
- **Edges come in two modes**:
  - **`stack`** — the child's branch is *based on* the parent's delivered branch,
    AND the child does not start until that parent opens its draft PR. A git
    branch has exactly one base, so **each node has at most ONE `stack` parent**.
  - **`after`** — scheduling-only fan-in. The child does not start until the
    predecessor opens its draft PR, but it does not branch from it. A node may
    have **many `after` parents**.
- Fan-out is fine (children that share a base). Fan-in is expressible: a node
  with one `stack` base plus one or more `after` predecessors — for example a
  diamond, where D depends on B and C, and both depend on A.
- **Roots** have no parent. Their PR base is the repo default branch, and they
  start immediately.

## 1. Draft the split

Read the request. Skim the target repo when that helps. Decompose it into an
ordered set of nodes. For each node, write:

- a short `key` (`schema`, `api`, `ui`) — local to this declaration, used only
  for edges;
- a **tightly scoped prompt** that names the exact behavior and files for that
  PR;
- its parent, or none for a root.

Rules:

- **Prefer 2–5 substantial nodes** over many trivial ones.
- **Default to a linear chain** when each step builds on the previous one. Use
  fan-out only for genuinely independent slices that share a base.
- **Slice along seams the repo already has** — schema, then API, then UI; the
  migration, then the code that reads it. A slice that cannot compile without its
  sibling is the wrong slice.
- **Never create a throwaway umbrella task.** The first slice IS a root node.

## 2. Get approval — REQUIRED

Present the proposed DAG to the user BEFORE you declare anything. Show each node:
`key`, a one-line objective, and its parent. Draw the shape:

```
schema  (root, base=main)         "Add the task_dependencies columns + migration"
  └─ api   (base=schema branch)   "Expose /api/... reading the new columns"
       └─ ui  (base=api branch)   "Render the new field in the dashboard"
```

Ask the user to approve, edit, or reject. Do NOT proceed without approval. The
split is a product decision. When the user rejects it, offer to run the work as a
single ordinary task instead.

For a large or expensive split, run `/grill-me` on the proposal first. It attacks
unstated assumptions, non-falsifiable acceptance checks, and silent scope
expansion — cheaper here than at node 3 of 5.

## 3. Declare the DAG in one atomic call

The spec is validated whole — unique keys, every edge reference resolvable, no
self-edge, at most one `stack` parent per node, and no cycle — then topologically
sorted before a single row is written. A bad spec creates nothing.

```
pnpm --filter @awb/cli cli -- task task-dag create \
  --repo <path-or-id> \
  --node schema='Add the task_dependencies columns + migration' \
  --node api='Expose /api/... reading the new columns' --dep api=schema \
  --node ui='Render the new field in the dashboard' --dep ui=api
```

The response lists each node's real `taskId`, its `parentTaskId`, and its
`scheduleState` — `ready` for roots, `blocked` for children.

**`--dep` declares `stack` edges only.** For fan-in you need typed edges, so post
the spec directly (the CLI just POSTs this):

```
POST /api/task-dags
{ "repositoryId": "<id>",
  "nodes": [
    { "key": "api",    "prompt": "…", "dependsOn": "schema" },
    { "key": "worker", "prompt": "…", "dependsOn": "schema" },
    { "key": "ui",     "prompt": "…",
      "dependsOn": [ { "ref": "api",    "mode": "stack" },
                     { "ref": "worker", "mode": "after" } ] } ] }
```

`dependsOn` accepts a plain key string (one `stack` edge, for back-compat) or an
array of typed edges.

## 4. Let it run

- **Roots start immediately.** Each blocked child starts on its own the moment
  every predecessor has opened its draft PR. The release phase pushes the event
  to the daemon scheduler, and a periodic sweep from SQLite is the backstop
  across a daemon restart (`apps/daemon/src/scheduler.ts`).
- **Answer each task's gates normally** — Step 5 of `SKILL.md`, driving the whole
  graph from one poll loop with `awb fleet --md`.
- **Never set a node's base branch by hand, and never thread branch names between
  tasks.** Declare the edge. The scheduler resolves the base lazily from the
  parent's delivered branch.
- **A child never starts when its parent never released.** Children unblock on a
  draft PR only. If the parent landed some other way, that event never fired:
  check `scheduleState` in SQLite, and start the child with an explicit
  `--base-branch`.

The outcome is N stacked draft PRs. The workbench only ever opens DRAFT PRs.
Never mark one ready. The human reviews and merges bottom-up.

## Adding one node later

To stack a single new task onto an existing one without declaring a graph:

```
pnpm --filter @awb/cli cli -- task create "<prompt>" --parent-task <taskId>
```
