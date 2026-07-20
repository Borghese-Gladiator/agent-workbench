# Run lifecycle

Every run moves through a small, explicit state machine. The current state lives in
`runs/<run_id>/metadata.yaml` under the `status:` key. The history of how a run got
to its current state lives in `runs/<run_id>/events.jsonl` — see
[`lib/events.py`](../lib/events.py).

Every transition that crosses a meaningful gate carries **evidence**: a small
dict of named fields that must be present and non-empty for the transition to be
accepted. The evidence is validated by `lib.transitions.transition_with_evidence`
([`lib/transitions.py`](../lib/transitions.py)) and recorded in the corresponding
`TransitionApplied` event's payload.

## States

| Status          | Phase | Meaning |
|-----------------|-------|---------|
| `draft`         | front | Run was created. `raw-idea.md` populated. Spec not written yet. |
| `normalize`     | front | `/normalize` is in flight: stitching `normalized-feature-input.md` from the raw idea. |
| `brainstorm`    | front | Normalized input exists. `/brainstorm` will spawn exploration subagents and pick an approach. |
| `ready`         | front | Spec is approved. Implementation can start |
| `planned`       | front | Legacy alias for `ready` while existing scripts migrate. Both are valid simultaneously. |
| `investigating` | front | (investigation runs only) Investigation is in flight in the parent's worktree. |
| `investigated`  | front | (investigation runs only) WBS is captured in `decisions.md`; children spawned. |
| `in_progress`   | back  | Worktree + branch exist. Active implementation. |
| `in_review`     | back  | A PR has been opened against the product repo. |
| `qa`            | back  | Implementation is feature-complete; QA pass(es) underway. |
| `merged`        | terminal | Feature branch merged into the product repo's default branch. |
| `abandoned`     | terminal | Run stopped before merging. Artifacts preserved as memory. |

## Run-type guard

`investigating` and `investigated` are gated to `run_type == "investigation"`.
`lib.metadata.transition()` and `lib.metadata.save()` reject these statuses on
any other run type with a clear error. If a run says it's investigating, its
`run_type` must confirm it.

## Transitions and their evidence

The table below lists every documented edge. **Required evidence** is the set
of keys that must be present and non-empty in the dict passed to
`transition_with_evidence`. Missing or empty keys are a hard rejection
(`TransitionError`).

### Feature path (canonical)

| From | To | Required evidence | Emitted by |
|---|---|---|---|
| `draft` | `normalize` | _(none — purely a marker that normalization is in flight)_ | `/normalize` |
| `normalize` | `brainstorm` | `normalized_spec_path` | `/normalize` |
| `brainstorm` | `ready` | `approved_by` | `/brainstorm` |
| `ready` | `in_progress` | `worktree_path`, `branch_name` | `scripts/create-worktree.sh` |
| `in_progress` | `qa` | `review_decision` | `scripts/qa-pass.sh` (pre-PR review) |
| `in_progress` | `in_review` | `pr_url` | `scripts/open-pr.sh` |
| `in_review` | `qa` | `review_decision` | `scripts/qa-pass.sh` (post-PR review) |
| `qa` | `in_review` | `pr_url` | `scripts/open-pr.sh` (PR opened after a passing pre-PR review) |
| `qa` | `merged` | `tests_passed`, `pr_url`, `merge_sha` | `scripts/complete-run.sh` |
| `in_review` | `in_progress` | `bounce_reason` | manual edit (review-bounce) |

### Legacy path

| From | To | Required evidence | Notes |
|---|---|---|---|
| `draft` | `planned` | `spec_path` | Manual flip — predates the front-half slash commands. |
| `draft` | `in_progress` | `worktree_path`, `branch_name` | `create-worktree.sh` on a fresh draft run that skips the front half. Deprecate once `/normalize` + `/brainstorm` are the default entry. |
| `planned` | `in_progress` | `worktree_path`, `branch_name` | Legacy equivalent of `ready → in_progress`. |

### Investigation path

| From | To | Required evidence | Emitted by |
|---|---|---|---|
| `planned` | `investigating` | `worktree_path` | manual edit |
| `investigating` | `investigated` | `wbs_children` | `scripts/spawn-children.sh` |
| `investigated` | `merged` | `children_complete` | `scripts/complete-run.sh` |

### Hotfix / skip-qa path

| From | To | Required evidence | Emitted by |
|---|---|---|---|
| `in_progress` | `merged` | `tests_passed`, `pr_url`, `merge_sha` | `scripts/complete-run.sh --skip-qa` |
| `in_review` | `merged` | `tests_passed`, `pr_url`, `merge_sha` | `scripts/complete-run.sh --skip-qa` |

`--skip-qa` prints a loud warning when used. Reserve it for emergency hotfixes
where QA happened outside the workbench.

### Abandon

| From | To | Required evidence | Emitted by |
|---|---|---|---|
| _any non-terminal_ | `abandoned` | `abandoned_reason` | `scripts/complete-run.sh --abandon --reason "..."` |

This edge is encoded as a wildcard in [`lib/transitions.py`](../lib/transitions.py)
(`ANY_NON_TERMINAL`). Terminal states (`merged`, `abandoned`) cannot be abandoned.

## Diagram — feature path

```
                /new-task or /ingest-linear
                          │
                          ▼
                       ┌──────┐
                       │draft │
                       └──┬───┘
                          │  /normalize
                          ▼
                    ┌───────────┐
                    │ normalize │
                    └─────┬─────┘
                          │  /normalize  (evidence: normalized_spec_path)
                          ▼
                    ┌────────────┐
                    │ brainstorm │
                    └──────┬─────┘
                           │  /brainstorm  (evidence: approved_by)
                           ▼
                       ┌──────┐
                       │ready │
                       └──┬───┘
                          │  create-worktree.sh  (evidence: worktree_path, branch_name)
                          ▼
                   ┌─────────────┐
                   │ in_progress │◄──────────┐
                   └──────┬──────┘           │
              qa-pass.sh  │  open-pr.sh      │  manual revert (evidence: bounce_reason)
       (review_decision)  │  (pr_url)        │
                          │                  │
                          ▼                  │
                    ┌───────────┐            │
                    │ in_review ├────────────┘
                    └─────┬─────┘
                          │  qa-pass.sh  (evidence: review_decision)
                          ▼
                       ┌────┐
                       │ qa │
                       └─┬──┘
                         │  complete-run.sh  (evidence: tests_passed, pr_url, merge_sha)
                         ▼
                   ┌──────────┐
                   │  merged  │
                   └──────────┘

Any non-terminal state can transition → abandoned via complete-run.sh --abandon --reason "...".
```

## Diagram — investigation path

```
                /ingest-linear
                       │
                       ▼
                    ┌──────┐
                    │draft │
                    └──┬───┘
              (manual: review the auto-stitched
               normalized-feature-input.md, author spec.md,
               flip status to "planned")
                       │
                       ▼
                  ┌────────┐
                  │planned │
                  └───┬────┘
              (manual: status → "investigating",
               investigation runs in parent's worktree)
                       │
                       ▼
                ┌───────────────┐
                │ investigating │
                └───────┬───────┘
                spawn-children.sh  (evidence: wbs_children)
                       │
                       ▼
                ┌──────────────┐
                │ investigated │
                └──────┬───────┘
                complete-run.sh  (evidence: children_complete)
                       │
                       ▼
                ┌──────────┐
                │  merged  │
                └──────────┘
```

Each spawned child is its own `run_type=feature` run that follows the feature
path above.

## Rules

- Status changes happen via:
  - `scripts/new-feature.sh` and `/ingest-linear` (set `draft`)
  - `/normalize` (sets `normalize`, then `brainstorm`)
  - `/brainstorm` (sets `ready`)
  - `scripts/create-worktree.sh` (sets `in_progress`)
  - `scripts/spawn-children.sh` (parent: `investigating` → `investigated`)
  - `scripts/qa-pass.sh` (sets `qa`) — also called by `/review-run`
  - `scripts/open-pr.sh` (sets `in_review`)
  - `scripts/complete-run.sh` (sets `merged` or `abandoned`)
  - Manual edits of `metadata.yaml` for `draft → planned` (legacy) and
    `planned → investigating` (investigation entry).
- `complete-run.sh` requires `qa` for the canonical merge path. Pass
  `--skip-qa` to merge from `{in_progress, in_review}` with a loud warning.
- Terminal states (`merged`, `abandoned`) cannot transition further.
  Re-opening a feature means creating a new run.
- Run artifacts are **never** deleted, regardless of terminal status. The
  `worktrees/<run_id>/` directory may be removed; `runs/<run_id>/` stays.

## Why this matters

The state machine is the contract between the human, the agents, and the scripts.
Evidence-bearing transitions tighten the contract: a `qa → merged` transition
without `merge_sha` is rejected at the boundary, not silently accepted. The
event log preserves the evidence in the `TransitionApplied` payload, so future
queries like "which runs got merged with `tests_passed=false`?" or "which
abandons had no recorded reason?" are answerable.

By keeping the state machine small, explicit, and evidence-bearing, we avoid:

- "Half-merged" states that nobody knows how to reason about.
- Lost runs that disappear without leaving a record.
- Implicit transitions hidden inside multi-step scripts.
- Status flips that look legitimate but lack the supporting context to debug.

If a new state seems necessary, prefer adding a sub-document to the run (e.g.,
an extra heading in `run-log.md`) or a new event type before adding a new
status value.
