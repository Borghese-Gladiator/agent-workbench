# Beads integration

[Beads](https://github.com/steveyegge/beads) (`bd`) is the workbench's
**task-graph index**. Each run is mirrored as one Beads issue; investigation
parents and their spawned children are linked via Beads' `--parent`
hierarchical-child mechanism. Beads is the answer to "show me all runs for
CORE-577" — `bd search` + `bd children` replace the previously-deferred
SQLite cross-run query layer.

The integration is **optional**. ai-workbench works fully without `bd`
installed; lifecycle scripts that call `sync-to-beads.sh` short-circuit
cleanly when `bd` is missing.

## The hard rule

Beads state lives **in ai-workbench**, never in product repos.
`scripts/validate-product-repos-clean.sh` enforces this by failing on any
`/beads/` directory inside a product source tree.

## Where Beads state lives

```
ai-workbench/
  .beads/                    ← Beads database (committed; see "Why we commit")
  runs/<run_id>/
    metadata.yaml            ← still canonical; gains a `beads_task_id` field
    spec.md
    ...
```

`scripts/init-repo.sh` runs `bd init --non-interactive --prefix wb` if `bd`
is on PATH and `.beads/` does not exist. Idempotent: safe to re-run.

### Why we commit `.beads/`

Single-user workbench; committing the dir makes the task graph at any
commit reproducible. If team mode arrives or `.beads/` size becomes a
problem, switch to JSONL export + `.gitignore` and revisit. Documented in
`.gitignore`.

## Mapping table

| ai-workbench concept                       | Beads representation                                  |
|--------------------------------------------|-------------------------------------------------------|
| run                                        | one issue                                             |
| `run_id`                                   | `external_ref = "ai-workbench:<run_id>"`              |
| `run_type`                                 | label `run-type:<value>` + `workbench` label          |
| `linear_ticket`                            | included in description                               |
| `parent_run_id` → child-of-parent          | `bd create --parent <parent_bead_id>` (hierarchical)  |
| `status: in_progress`                      | `bd update --claim <id>` (sets status to in_progress) |
| `status: in_review`                        | `bd set-state <id> review=in-progress`                |
| `status: qa`                               | `bd set-state <id> review=qa`                         |
| `status: merged` / `abandoned`             | `bd close <id>`                                       |
| `status: draft` / `planned` / `investigating` / `investigated` | no-op                          |
| Cross-run query "all runs for CORE-577"    | `bd search "linear.app/.../CORE-577"`                 |
| List children of a parent                  | `bd children <parent_bead_id>`                        |

## Sync behavior

`scripts/sync-to-beads.sh <run_dir>` is the single integration point:

1. If `bd` is not on PATH: print warning, exit 0.
2. If `.beads/` is not initialized: `bd init`.
3. Load the run's `metadata.yaml`.
4. If `parent_run_id` is set, recurse: sync the parent first so its
   `beads_task_id` is available before the child is created.
5. If the run has no `beads_task_id`: `bd create` with the title, description
   (including back-pointers to run_id, repo_key, linear_ticket, worktree,
   pr_url), `--external-ref ai-workbench:<run_id>`, the appropriate labels,
   and `--parent <parent_bead_id>` if applicable. Write the new bead ID into
   `metadata.yaml`.
6. If the run already has a `beads_task_id`: confirm it exists in Beads. If
   not, raise loudly — workbench/Beads have drifted and we don't want to
   silently re-create.
7. Map the current workbench status to a Beads operation (see table above).

The sync is **idempotent**: re-running on the same run with no metadata
changes is a no-op (modulo a `bd update --claim` re-claim, which Beads
itself treats as idempotent).

The lifecycle scripts (`new-feature.sh`, `create-worktree.sh`, `qa-pass.sh`,
`open-pr.sh`, `complete-run.sh`, `spawn-children.sh`) call sync as their
last step with `|| true` — a Beads hiccup never blocks the deterministic
part of the lifecycle.

`/ingest-linear` and `spawn-children.sh` set the env var
`WORKBENCH_SKIP_BEADS_SYNC=1` when invoking `new-feature.sh` so the bead is
created **after** `run_type` and `parent_run_id` are patched in. This keeps
"one bead per run" with the correct labels and parent link from the start.

## What Beads does NOT change

- `metadata.yaml` remains the source of truth for run state. Beads is a
  derived index.
- Markdown artifacts in `runs/<run_id>/` remain the canonical content.
- Product repos stay clean.
- All scripts in `scripts/` continue to work without `bd` installed.

## One-way sync (deliberate limitation)

We sync workbench → Beads. We do **not** read Beads to mutate workbench
state. If a user closes a Beads issue manually, that closure does not flow
back into `metadata.yaml`. This is enforced by omission: no script reads
Beads as a state source.

`validate-workbench.sh` surfaces drift (e.g., `beads_task_id` set but `bd
show` cannot find it; non-draft run with no `beads_task_id`) as warnings
with a suggested fix (`./scripts/sync-to-beads.sh runs/<run_id>`). It does
not auto-repair.

Bidirectional sync is a separate, larger project — not in scope.

## What Beads is NOT used for (today)

- `beads_required: "true"` enforcement flag. Mirroring `gh`'s posture, Beads
  is always optional. If a run cannot proceed without Beads we add the flag
  later in one line.
- Bulk-close cascades. Abandoning an investigation does not auto-close its
  spawned children's beads. Each run closes independently.
- Cross-workbench sync. The Beads database is local to one ai-workbench
  checkout.

## Wiring summary

| Script                       | Beads call site                                  |
|------------------------------|--------------------------------------------------|
| `init-repo.sh`               | `bd init` if missing                             |
| `new-feature.sh`             | trailing `sync-to-beads.sh` (skipped via env var when called from `/ingest-linear` / `spawn-children.sh`) |
| `/ingest-linear`             | trailing `sync-to-beads.sh` after run_type=investigation patched |
| `spawn-children.sh`          | trailing `sync-to-beads.sh` for parent + each child after parent_run_id patched |
| `create-worktree.sh`         | trailing `sync-to-beads.sh` (status → in_progress) |
| `qa-pass.sh`                 | trailing `sync-to-beads.sh` (status → qa)        |
| `open-pr.sh`                 | trailing `sync-to-beads.sh` (status → in_review) |
| `complete-run.sh`            | trailing `sync-to-beads.sh` (status → merged/abandoned) |
| `validate-workbench.sh`      | `[bd]` line in `[tooling]`; per-run drift checks |
