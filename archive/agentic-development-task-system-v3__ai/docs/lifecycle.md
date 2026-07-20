# Run Lifecycle

Every run moves through a small explicit state machine.

The current state lives in:

```text
runs/<run_id>/metadata.yaml
```

The append-only history lives in:

```text
runs/<run_id>/events.jsonl
```

Status only ever changes through `lib/transitions.transition`. Manual edits to `metadata.yaml`'s `status` field are not valid transitions — `transitions_require_evidence` is enforced and `manual_metadata_status_edits_are_invalid` is set in `schemas/transitions.yaml`. Each meaningful transition appends a `TransitionApplied` event with the evidence the engine accepted; some transitions also emit a secondary event (`WorktreeCreated`, `RunCompleted`, `RunAbandoned`, `BounceRequested`).

## On-disk layout for new runs

Runs created on or after the TODO §1 (Renovate task workflow) change use a **staged layout**. Each stage's canonical outputs live under `stages/<N>_<stage>/`; superseded outputs land in `archive/<N>_<stage>/`; the reviewer's entry point is `HUMAN_REVIEW.md` at the run root.

```text
runs/<run_id>/
  stages/                        # directory names are N_<stage> so `ls`
                                 # sorts by lifecycle flow.
    1_draft/raw-idea.md
    2_shaping/brief.md
    3_planning/plan.md            # folds preflight + decisions/assumptions
    4_building/build.md           # merges implementation-summary + diff-summary
    5_validating/review.md
    5_validating/qa/
    6_followups/follow-ups.md     # forward-looking candidates for future runs
  archive/                        # present only on bounce-supersession
    4_building/build-v1.md
    5_validating/review-v1.md
    5_validating/qa-v1/
    6_followups/follow-ups-v1.md
  HUMAN_REVIEW.md                 # code-derived; replaces handoff.md
  audit.md
  events.jsonl
  metadata.yaml
  metrics.jsonl                   # token + cost rollup; written at validate/followups/abandon
```

The numbered stage directories landed in TODO §1 (V2). Runs created before that change kept their unnumbered names; the helpers in `lib/lifecycle.py` (`_resolve_stage_dir`) prefer an existing legacy dir over the numbered one, so in-flight staged runs are never renamed implicitly.

Stage names map to numbers via `_STAGE_NUMBER` in `lib/lifecycle.py`:

```text
1_draft   2_shaping   3_planning   4_building   5_validating   6_followups
```

There is no on-disk stage directory for `ready` (no new artifacts) or `human_review` (no new artifacts beyond `HUMAN_REVIEW.md` at the run root).

### Move-on-transition

The transition engine moves a stage's run-root outputs into `stages/<N>_<stage>/` as the stage closes. The move table is `_STAGE_OUTPUTS` in `lib/lifecycle.py`; the hook is `on_transition`. It is **idempotent**: re-running it on already-promoted files is a no-op, and the evidence-path rewrites it returns are relative to the run root so `events.jsonl` stays portable.

Some evidence keys point at the *same* canonical file via an anchor:

```text
preflight_path    -> plan.md#preflight
assumptions_path  -> plan.md#decisions--assumptions
decisions_path    -> plan.md#decisions--assumptions
diff_summary_path -> build.md#files-changed
audit_path        -> HUMAN_REVIEW.md#run-timeline
```

These are the `_ANCHORED_EVIDENCE` aliases in `lib/lifecycle.py`. The planner now produces ONE `plan.md` with folded sections (no separate `preflight.md` / `assumptions.md` / `decisions.md` files), and the builder produces ONE `build.md` (no separate `implementation-summary.md` / `diff-summary.md`). The aliases let the transition schema continue to require those evidence keys without forcing multiple physical files.

### Stage-by-stage move table

| Closing stage | Source at run root | Destination | Evidence key |
|---|---|---|---|
| `draft`       | `raw-idea.md`, `answers.md` (optional) | `stages/1_draft/{raw-idea,answers}.md`   | `raw_idea_path`, `answers_path` (optional) |
| `shaping`     | `brief.md`           | `stages/2_shaping/brief.md`              | `brief_path` |
| `planning`    | `plan.md`            | `stages/3_planning/plan.md`              | `plan_path` (+ anchored aliases) |
| `building`    | `build.md`           | `stages/4_building/build.md`             | `implementation_summary_path` (+ `diff_summary_path` via anchor) |
| `validating`  | `review.md` + `qa/`  | `stages/5_validating/{review.md, qa/}`   | `review_report_path` |
| `followups`   | `follow-ups.md`      | `stages/6_followups/follow-ups.md`       | `followups_path` |

On the final hop into `human_review`, `prune_empty_dirs` removes any empty subtrees under `stages/` and `archive/` so the directory listing reflects what was actually produced.

### HUMAN_REVIEW.md is code-derived, not LLM-authored

When a staged run closes the `followups` stage, `lib/human_review.render` writes `HUMAN_REVIEW.md` at the run root as a projection of metadata + `events.jsonl` + the staged artifacts. The file is overwritten on every render — whatever any earlier stage staged at that path is replaced. The render runs **before** the `followups -> human_review` transition; the engine then gates that transition on `validate_human_review_sections`, which rejects the transition if any of these literal headings is missing:

```text
## Files
## Summary of changes
## Testing
## Run timeline
```

(Source of truth: `lib.lifecycle.REQUIRED_HUMAN_REVIEW_HEADINGS`.)

After the transition, `cmd_followups` also appends a `## Token efficiency` block delimited by `<!-- metrics:start -->` / `<!-- metrics:end -->` HTML comments. The block is best-effort and idempotent: a later re-render replaces the prior block in place.

The renderer's `## Summary of changes` body is extracted from `stages/4_building/build.md`. The **canonical narrative heading is `## What changed`** (defined in `templates/build.md`) — the renderer reads that section for the one-paragraph "what was implemented and why" bullet that opens the summary. The legacy `## Implementation summary` heading is no longer recognized; builders that emit only the old heading will produce a summary missing its narrative bullet. See TODO §13 for the failure-cluster fix that established this contract.

### Bounce supersession

A bounce (`human_review → building`) calls `lifecycle.archive_for_bounce` *before* the transition fires. It moves the entire contents of `stages/4_building/`, `stages/5_validating/`, and `stages/6_followups/` into `archive/<stage>/` with versioned names: regular files become `<stem>-v<N><suffix>` and the `qa/` directory moves as a whole to `qa-v<N>/`. Versions are computed by scanning the destination for the highest existing `-v<N>` per stem, then adding one. The source stage directories are recreated empty so the rebuild can write into them again. `followups` is included so prior brainstorms don't leak into the rebuild.

The `human_review → building` transition does **not** destroy the worktree or branch — those are preserved across the bounce.

### Back-compat (flat-layout runs)

Runs created before staged-layout landed keep their flat layout (everything at the run root) forever. The flat-layout legacy path uses the `validating → human_review` transition directly (still present in the schema) and writes `handoff.md` at the run root instead of `HUMAN_REVIEW.md`. The CLI and helpers detect layout per-run via `lifecycle.is_staged_run`; flat runs are read-only and never migrated implicitly.

## States

| Status | Meaning | May ask human questions? | May read code? |
|---|---|---:|---:|
| `draft` | Raw idea exists. Clarification may happen. | Yes | No |
| `shaping` | Convert raw input and answers into a code-blind brief. | No | No |
| `planning` | Inspect the target repo if applicable and create an implementation plan. | No | Yes |
| `ready` | Human approval gate before code changes begin. | No | No |
| `building` | Branch and worktree exist. Agent is implementing. | No | Yes |
| `validating` | Agent runs review, tests, QA, and records evidence. | No | Yes |
| `followups` | Agent brainstorms forward-looking candidates for future runs and writes `follow-ups.md`. Staged runs only. | No | Yes (read-only) |
| `human_review` | Worktree and branch are ready for human inspection. | Yes, by human choice | Yes |
| `done` | Human accepted the work or closed it as complete. | No | No |
| `abandoned` | Run intentionally stopped. Artifacts are preserved. | No | No |

Terminal states:

```text
done
abandoned
```

Terminal states cannot transition further (`terminal_states_cannot_transition: true` in `schemas/transitions.yaml`). Reopening work means creating a new run, or bouncing from `human_review` before accepting.

## Canonical flow

```text
draft
  -> shaping
  -> planning
  -> ready
  -> building
  -> validating
  -> followups        (staged runs only)
  -> human_review
  -> done
```

Flat-layout legacy runs skip the `followups` hop and go directly `validating -> human_review`.

Bounce-back flow:

```text
human_review -> building
```

### Slash-command auto-chain

The Claude slash commands auto-chain `/new-run → /draft → /shape → /plan` so the agent only stops at the two real human gates:

1. `ready` — the user must run `/start` to supply `--approved-by` evidence.
2. `human_review` — the user picks `/complete`, `/bounce`, or `/abandon`.

`/draft` may pause inside the chain to ask clarifying questions via `AskUserQuestion` (per the `draft` stage rules); that pause is a question, not an approval gate. `/draft` is the **only** stage that asks questions — `/shape` and `/plan` convert unknowns into Assumptions/Decisions instead. The state machine itself is unchanged — this is a convention enforced at the slash-command layer only.

Abandon flow (wildcard):

```text
any non-terminal -> abandoned
```

## Transition evidence

Required evidence per transition (from `schemas/transitions.yaml`). Evidence values must be non-empty (`evidence_values_must_be_non_empty: true`); missing or empty evidence rejects the transition with a `TransitionRejected` event.

| From | To | Required evidence | Emits |
|---|---|---|---|
| `draft` | `shaping` | `raw_idea_path` | `TransitionApplied` |
| `shaping` | `planning` | `brief_path` | `TransitionApplied` |
| `planning` | `ready` | `plan_path`, `assumptions_path`, `decisions_path`, `preflight_path`, `repo_path`, `repo_name`, `worktree_name`, `branch_name` | `TransitionApplied` |
| `ready` | `building` | `approved_by`, `repo_path`, `repo_name`, `base_ref`, `branch_name`, `worktree_name`, `worktree_path`, `preflight_path` | `TransitionApplied`, `WorktreeCreated` |
| `building` | `validating` | `implementation_summary_path`, `diff_summary_path`, `build_iterations`, `build_exit_reason` | `TransitionApplied` |
| `validating` | `followups` (staged) | `review_report_path`, `qa_report_path`, `audit_path` | `TransitionApplied` |
| `validating` | `human_review` (flat) | `review_report_path`, `qa_report_path`, `audit_path`, `handoff_path`, `branch_name`, `worktree_path` | `TransitionApplied` |
| `followups` | `human_review` | `followups_path`, `handoff_path`, `branch_name`, `worktree_path` | `TransitionApplied` |
| `human_review` | `building` | `bounce_reason` (`requested_by`, `handoff_path`, `change_request_path` optional) | `TransitionApplied`, `BounceRequested` |
| `human_review` | `done` | `accepted_by`, `completion_ref`, `audit_path` | `TransitionApplied`, `RunCompleted` |
| any non-terminal | `abandoned` | `abandoned_reason` (`abandoned_by` optional) | `TransitionApplied`, `RunAbandoned` |

The engine's secondary-event payloads (`WorktreeCreated`, `RunCompleted`, `RunAbandoned`, `BounceRequested`) are filled from the evidence dict by `transitions._secondary_payload`.

## Stage contracts

Every non-terminal stage has its own contract: what it reads, what it produces, what it must write before it can exit, and what it must not do.

The artifacts listed under **Produces** are required to advance to the next state. The transition engine rejects the transition if any required artifact is missing or empty.

---

### draft

| | |
|---|---|
| Owner | Human + intake agent |
| May read code? | No |
| May ask questions? | Yes |
| Next state | `shaping` |

**Reads**

- User input (raw idea pasted at run creation).

**Produces**

- `raw-idea.md` — the original user request, captured verbatim.
- `answers.md` *(optional)* — clarifying Q&A, only if the run asked questions.

**Rules**

- The only state in which the agent may ask the human clarifying questions. The `/draft` slash command (LLM-bearing) reads `raw-idea.md`, decides whether material intent ambiguity exists, and either captures clarifications in `answers.md` via `AskUserQuestion` or skips writing the file entirely.
- Good questions materially change goal, target repo, user-facing behavior, or acceptance criteria.
- Bad questions can be resolved by existing repo conventions or by recording a reasonable assumption — defer those to `/shape` or `/plan`.
- For self-modifying runs (workbench is inside the target repo), `new-run` creates the worktree at draft time so subsequent stages (shaping, planning, ready) work inside the worktree. Abandoning a draft removes a real worktree (TODO §1A1).

**To exit → `shaping`**

- `raw_idea_path` must point at a non-empty `raw-idea.md`.
- `answers_path` is **optional** evidence. Present iff `/draft` wrote a non-empty `answers.md`; absent when the raw idea was unambiguous.
- The `agent-workbench draft <run_id>` CLI command (default mode) performs the transition. `/new-run` no longer auto-chains directly to `/shape`; it auto-chains to `/draft`, which then auto-chains to `/shape`.

---

### shaping

| | |
|---|---|
| Owner | Shaping agent |
| May read code? | No |
| May ask questions? | No |
| Next state | `planning` |

**Curated entry context**

- `stages/2_shaping/shape-context.md` — written deterministically by `/shape --init`. Lifts `raw-idea.md` verbatim, `answers.md` verbatim if present, the `brief.md` template skeleton, and the two shaping rules into one file. Read this instead of `raw-idea.md` + `answers.md` + `templates/brief.md` separately. Generated by `lib/shape_context.py`. Mirrors the `build-context.md` / `validate-context.md` pattern (TODO §5).

**Reads**

- `stages/2_shaping/shape-context.md` (preferred — the curated entry above).
- `stages/1_draft/raw-idea.md` (moved there on `draft → shaping`) — reach for this only when `shape-context.md`'s sections are insufficient.
- `stages/1_draft/answers.md` *(if `/draft` asked questions)* — same caveat.

**Produces**

- `brief.md` — code-blind specification of the work.

**`brief.md` sections**

```text
Goal
User-facing behavior
Acceptance criteria
Non-goals
Good examples
Bad examples
Constraints
Assumptions
Suggested QA scenarios
Files likely to change         # used by the scope-creep check at validate
```

**Rules**

- Shaping must not read the target repo.
- Shaping must not ask the human questions.
- If the idea is too broad to shape, the brief should identify a smaller first run (bootstrap, vertical slice, roadmap) rather than try to spec the full thing.

**To exit → `planning`**

- `brief_path` must point at a non-empty `brief.md`.

---

### planning

| | |
|---|---|
| Owner | Planning agent |
| May read code? | Yes |
| May ask questions? | No |
| Next state | `ready` |

**Curated entry context**

- `stages/3_planning/plan-context.md` — written deterministically by `/plan --init`. Lifts the full `brief.md`, a repo-map block (top-level dirs + detected languages + build/test commands inferred from target-repo manifests), the brief's "Files likely to change" section, the worktree metadata, the `plan.md` template skeleton, and the planning rules into one file. Read this instead of `brief.md` + `templates/plan.md` separately. Generated by `lib/plan_context.py`. Mirrors the `build-context.md` / `validate-context.md` pattern (TODO §5).

**Reads**

- `stages/3_planning/plan-context.md` (preferred — the curated entry above).
- `brief.md` — reach for it only when `plan-context.md`'s Brief section is insufficient.
- Target repo files (if applicable). The repo-map block in `plan-context.md` is deterministic; deeper code reads still go straight to the worktree.

**Produces**

- `plan.md` — implementation plan grounded in the actual repo. Folds the preflight check and the decisions/assumptions log into anchored sections rather than separate files:
  - `## Preflight` (addressed by `preflight_path` → `plan.md#preflight`)
  - `## Decisions & assumptions` (addressed by both `decisions_path` and `assumptions_path` → `plan.md#decisions--assumptions`)

**`plan.md` sections**

```text
Current repo understanding
Relevant files
Proposed changes
Files likely to change
Data model changes
UI changes
Test plan
QA plan
Risks
Definition of done
Preflight                       # anchored: #preflight
Decisions & assumptions         # anchored: #decisions--assumptions
```

**Rules**

- Planning may read code; planning may not ask the human questions.
- If planning finds ambiguity, it records an assumption and chooses the safest small implementation.
- If the task is too broad, planning should reduce scope to a useful first run.

**To exit → `ready`**

- `plan_path` must exist and be non-empty.
- `preflight_path`, `assumptions_path`, `decisions_path` are required evidence keys but resolve to anchors on the same `plan.md`.
- `repo_path`, `repo_name`, `worktree_name`, `branch_name` must be set in metadata.

---

### ready

| | |
|---|---|
| Owner | Human |
| May read code? | N/A |
| May ask questions? | N/A |
| Next state | `building` |

**Reads**

- `plan.md` (with its preflight and decisions/assumptions sections).

**Produces**

- No new artifacts. This is a human approval gate.

**Rules**

- For self-modifying runs (workbench is inside the target repo), the branch + worktree were created at `new-run` time and the run dir already lives inside the worktree (TODO §1A1). `/start` is a state-only transition.
- For non-self-modifying runs, the branch and worktree do not exist yet — they are created on the `ready -> building` transition.
- The human reviews the plan and approves (or abandons and starts a new run with a corrected brief).

**To exit → `building`**

- `approved_by` must be set.
- Branch and worktree must be created or verified (the transition emits `WorktreeCreated`).
- `worktree_path`, `worktree_name`, `branch_name`, `repo_path`, `repo_name`, `base_ref` must be populated as transition evidence.

---

### building

| | |
|---|---|
| Owner | Building agent |
| May read code? | Yes |
| May ask questions? | No, unless hard-blocked |
| Next state | `validating` |

**Works inside**

```text
agent-workbench/worktrees/<repo_name>/<worktree_name>/
```

**Curated entry context**

- `build-context.md` — written deterministically by `/start` at the `ready → building` boundary. Lifts the brief's Acceptance criteria + Non-goals, the plan's Proposed changes + Files likely to change + Test plan + Definition of done, every DR/ASM block, the worktree metadata, and the `build.md` template skeleton into one file. Read this instead of `brief.md` + `plan.md` + `templates/build.md` separately. Generated by `lib/build_context.py`. Mirrors the `validate-context.md` pattern at the `validating` boundary (TODO §1).

**Reads**

- `build-context.md` (preferred — the curated entry above).
- `plan.md`, `brief.md` — reach for these only when `build-context.md`'s sections are insufficient. Re-reading them in the master session is a cache cost; the curated file exists precisely to make those reads avoidable.
- The worktree.
- On a rebuild after `/bounce`: `change-request.md` at the run root.

**Produces**

- `build.md` — single merged artifact covering implementation summary, files changed, AC coverage, and the diff rundown. The `diff_summary_path` evidence key points at `build.md#files-changed`.

**`build.md` sections**

```text
What changed                    # canonical narrative heading; renderer extracts the opening bullet from this section
Files changed                   # anchored: #files-changed
Reviewer reading order
Acceptance criteria coverage
Deviations from plan
Known issues
Commands run
Documentation touched           # checked at validate against the actual diff
```

**Rules**

- Follow `plan.md`.
- Keep scope bounded by `brief.md`.
- Record deviations explicitly.
- Do not modify the original checkout.
- Do not silently skip acceptance criteria.
- The transition engine requires `build_iterations` and `build_exit_reason` evidence; `validate --init` fills sensible defaults (`1` / `tests_green`) into `metadata.yaml`'s `build:` block when the builder didn't set them, so the reviewer sees the defaults explicitly and can challenge them.

**To exit → `validating`**

- `build.md` must exist and be non-empty (the `implementation_summary_path` and `diff_summary_path` evidence keys both point at it).
- `build_iterations` and `build_exit_reason` must be set in metadata.

---

### validating

| | |
|---|---|
| Owner | Review + QA agents |
| May read code? | Yes |
| May ask questions? | No |
| Next state | `followups` (staged) or `human_review` (flat legacy) |

**Reads**

- The worktree and all preceding artifacts.

**Produces**

- `review.md` — adversarial self-review against the brief and plan. Moves to `stages/5_validating/review.md` on transition.
- `qa/report.md` — QA results, including a `## Manual testing` section.
- `qa/commands.txt` — every command run, in order.
- `qa/artifacts/`, `qa/recordings/`, `qa/traces/` — supporting evidence captured during QA.
- `audit.md` at the run root — human-readable timeline rendered from `events.jsonl` + artifacts by `lib.audit.render`. (Not moved into a stage directory; it's a run-level rollup, addressed by the `audit_path` evidence key.)
- `metrics.jsonl` at the run root — token + cost rollup written by `lib.metrics.writer.record_run_metrics`.

**`review.md` should answer**

```text
Did the implementation satisfy the brief?
Did it accidentally expand scope?
Are there fragile assumptions?
Are there missing tests?
Are there security, data loss, or migration risks?
What should the human review first?
```

Plus two sections appended by `cmd_validate` (staged runs only):

- `## Documentation claims` — TODO §1d. `validate` reads `build.md`'s "Documentation touched" section, compares claimed paths against `git diff` in the target worktree, and appends unverified claims here. A `DocClaimsVerified` event records `{verified, unverified}`.
- `## Scope creep check` — TODO §1g. `validate` parses `brief.md`'s `## Files likely to change` (or `## Scope`) and compares it against `git diff --name-only <base_ref>...HEAD`. Unexpected files surface here. A `ScopeCreepChecked` event records `{creep}`.

The deeper blast-radius traversal — depth-3 callers of changed symbols — is authored by the reviewer agent itself during `/validate` step 3 via `git diff` + `git grep`, and lives in the same `review.md` under its own `## Blast radius` section.

**QA should run at least one of**

```text
unit tests
integration tests
lint / typecheck
Playwright (MCP or direct)
custom smoke scripts
```

**Rules**

- Validation is adversarial. The reviewer is not the builder.
- A failed command does not auto-abandon the run. The agent may repair, retry, or hand off with known issues — but the audit must say what happened.

**To exit → `followups`** (staged)

- `review_report_path`, `qa_report_path`, `audit_path` must exist and be non-empty.
- Emits `ReviewCompleted` (with parsed `review_decision`) and `QACompleted` (with `tests_passed` and `known_issues_count`).

**To exit → `human_review`** (flat legacy only)

- `review_report_path`, `qa_report_path`, `audit_path`, `handoff_path`, `branch_name`, `worktree_path` must all be set.
- Emits `HumanHandoffCreated`.

---

### followups (staged runs only)

| | |
|---|---|
| Owner | Followups agent (read-only) |
| May read code? | Yes (read-only) |
| May ask questions? | No |
| Next state | `human_review` |

**Curated entry context**

- `stages/6_followups/followups-context.md` — written deterministically by `/followups --init`. Lifts brief's Non-goals, plan's Risks, review's Decision + findings, qa report's Known issues, build's Deviations from plan, the `follow-ups.md` schema (category enum + frontmatter rules), and the followups rules into one file. Read this instead of all the prior artifacts separately. Generated by `lib/followups_context.py`. Mirrors the `build-context.md` / `validate-context.md` pattern (TODO §5).

**Reads**

- `stages/6_followups/followups-context.md` (preferred — the curated entry above).
- The just-finished run's outputs (brief, plan, build, review, qa) — reach for them only when `followups-context.md`'s curated sections are insufficient.

**Produces**

- `follow-ups.md` — a 1–5 entry list of forward-looking candidates for *future* runs.

**`follow-ups.md` entry contract**

Each entry has YAML frontmatter validated by `lib/followups.py`. Allowed categories:

```text
tech_debt
scope_extension
bug_risk
refactor
docs
deferred_from_bounce
no_followups                    # explicit sentinel
```

`no_followups` is required when there is genuinely nothing forward-looking to surface. An empty file is rejected.

**Rules**

- The stage is purely authoring — **nothing is executed**.
- Reads are allowed; writes outside `follow-ups.md` are not.
- `cmd_followups` emits a `FollowupsRecorded` event with `{followups_path, entry_count, categories}`.
- The CLI then renders `HUMAN_REVIEW.md` from events + artifacts via `lib.human_review.render` and emits `HumanHandoffCreated`. The engine validates the required headings on the transition.

**To exit → `human_review`**

- `followups_path` must point at a non-empty, schema-valid `follow-ups.md`.
- `handoff_path` (`HUMAN_REVIEW.md` at the run root) must exist with all four required headings:
  `## Files`, `## Summary of changes`, `## Testing`, `## Run timeline`. Missing any heading rejects the transition (`TransitionRejected` + `TransitionError`).
- `branch_name` and `worktree_path` must be set.

---

### human_review

| | |
|---|---|
| Owner | Human |
| May read code? | Yes (human decides) |
| May ask questions? | Yes (human decides) |
| Next states | `done`, `building`, `abandoned` |

**Reads**

- `HUMAN_REVIEW.md` (the code-derived reviewer entry point), `audit.md`, `review.md`, `qa/report.md`, the branch and worktree, and `follow-ups.md`.

**Produces**

- No required new artifacts. The human may add notes.
- On `bounce` via the `/bounce` slash command: writes (or appends a new `## Bounce N` section to) `change-request.md` in the run dir. Manual CLI bounces may omit this artifact.

**Exits**

```text
complete -> done       (accepted; sets completion_ref, stamps completion metadata)
bounce   -> building   (requires bounce_reason; archives prior stages, preserves worktree)
abandon  -> abandoned  (stopped; requires abandoned_reason)
```

`human_review` is not `done`. It means the system has handed off local work for inspection.

---

### done (terminal)

| | |
|---|---|
| Owner | Human / system |
| Terminal? | Yes |

**Required evidence on entry**

- `accepted_by`
- `completion_ref`
- `audit_path`

**What `cmd_complete` does**

1. Verifies the run is in `human_review` and that `audit.md` exists.
2. Inside a per-run lock:
   a. Refuses if the worktree at `metadata.target.worktree.path` has uncommitted changes.
   b. Resolves `metadata.target.repo.base_ref` to a concrete parent branch (for `base_ref: HEAD`, reads the target repo's current `HEAD`).
   c. Refuses if the target repo's working tree is dirty.
   d. Checks out the parent branch in the target repo and runs `git merge --no-ff <worktree_branch>` with a descriptive merge message.
   e. On success: captures the new merge SHA via `git rev-parse HEAD`, restores the target repo's original branch via `git checkout -`, then calls `transitions.transition(..., "done", ...)` with `completion_ref="merge:<sha>"`. The engine appends `TransitionApplied` and the secondary `RunCompleted` event. `cmd_complete` then appends a `WorktreeMerged` event with `{worktree_branch, parent_branch, merge_sha, merge_strategy: "no-ff", repo_path}`.
   f. On conflict: runs `git merge --abort`, appends a `MergeConflict` event with `{worktree_branch, parent_branch, conflicted_files, repo_path, stderr}`, leaves status at `human_review`, and returns a non-zero exit code. The parent branch is left checked out so the human is dropped where they need to resolve.
3. Updates `metadata.completion` with `accepted_by`, `completion_ref`, and `completed_at`.
4. Prints the new status, the `completion_ref` (formatted `merge:<sha>`), and a `merged <branch> into <parent_branch> (<sha-short>)` confirmation line.

`done` means **both** "human signed off" AND "code integrated into the parent branch." There is no separate `merged` state.

**What `cmd_complete` does NOT do**

- Push to a remote. Merging is local-only; the human pushes themselves if they want.
- Resolve conflicts in-line. On conflict it aborts and bounces the human back to manual resolution.
- Clean up the worktree. Worktrees stay on disk after `done`; removal (`git worktree remove`) is a manual / future-task concern.
- Support rebase or squash strategies. The strategy is pinned to `--no-ff` for now.

**Escape hatches**

- `--no-merge` — skip the merge step and record `completion_ref: local-branch:<branch_name>`. The board surfaces such runs with a `⚠ unmerged` badge. Use when target-repo state makes auto-merging unsafe.
- `--completion-ref <value>` — explicit override (skips the merge). Used to backfill runs that were merged outside the lifecycle.

`completion_ref` examples:

```text
merge:c635745ab2f1...                 # the post-Option-A default
local-branch:agent/add-login-form      # legacy or --no-merge run; flagged on the board
accepted-local-worktree:/path/...      # explicit --completion-ref override
```

---

### abandoned (terminal)

| | |
|---|---|
| Owner | Human / system |
| Terminal? | Yes |
| Reachable from | Any non-terminal state |

**Required evidence on entry**

- `abandoned_reason`
- `abandoned_by` (optional)

**What `cmd_abandon` does**

1. Refuses if the run is already in a terminal state.
2. Calls `transitions.transition(..., "abandoned", ...)`; the engine appends `TransitionApplied` and the secondary `RunAbandoned` event.
3. Writes `abandoned_reason` into `metadata.completion`.
4. Refreshes `metrics.jsonl` (best-effort) at the terminal boundary.

**Rules**

- Artifacts are preserved (`abandoned_preserves_artifacts: true`).
- Worktrees may be cleaned up later by an explicit command, but the run record stays.

## Scope classification

Each run may classify its scope in metadata:

```yaml
scope:
  kind: implementation
```

Allowed values:

```text
implementation
bootstrap
roadmap
research
repair
```

This field does not change the lifecycle. It only clarifies what the run is trying to accomplish.

Rules:

- Clear ideas may go directly to implementation after `ready`.
- Broad ideas should become a bootstrap, roadmap, or vertical slice.
- One run must still target one repo and one worktree.

## Transition rules

- Status changes must go through the transition engine.
- Manual metadata edits are not valid transitions.
- Each transition appends a `TransitionApplied` event; rejected transitions append a `TransitionRejected` event (best-effort) before raising `TransitionError`.
- Missing or empty evidence rejects the transition.
- Terminal states cannot transition.
- Run artifacts are never deleted by lifecycle transitions. Bounce *archives* prior stages with `-v<N>` suffixes; it never deletes them.
- Worktrees may be cleaned up later, but run records stay.

## Token-efficiency tracking

`metrics.jsonl` at the run root is written by `lib.metrics.writer.record_run_metrics` at three points:

- end of `validating` (so the followups stage's HUMAN_REVIEW rendering has fresh numbers),
- end of `followups` (so the metrics block injected into `HUMAN_REVIEW.md` reflects the final pre-accept spend),
- on `abandon` (terminal boundary).

The `## Token efficiency` block in `HUMAN_REVIEW.md` is delimited by `<!-- metrics:start -->` / `<!-- metrics:end -->` comments and re-runs replace it in place. `accepted_*` fields stay at 0 until the run reaches `done` (and, under TODO §1 Option A, the merge has happened).
