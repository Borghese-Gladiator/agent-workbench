# Plan — Theme A + D + F + C(TUI) + B(discipline)

This is the multi-pass plan agreed in the 05/14 brainstorm session. Scope is
deliberately wider than a single feature: the goal is to close the
front-half-of-lifecycle gap that the 05/14 LOG entry called out, activate the
infrastructure built on 05/13 (`lib/transitions.py`, `lib/events.py`) that has
zero callers today, and add a status TUI.

Themes B (multi-agent discipline) and E (retry budget) have been re-scoped or
dropped per the brainstorm — captured in the "Out of scope" section at the end.

---

## Brief

The README says the lifecycle is

```
draft → normalize → brainstorm → ready → in_progress → in_review → qa → merged
```

but only the back half (`in_progress → merged`) has slash commands and scripts.
The front half (`draft → normalize → brainstorm → ready`) is documented as
"edit `raw-idea.md → normalized-feature-input.md → spec.md` by hand or with an
agent" and "manually flip status." The new statuses `normalize`, `brainstorm`,
`ready` were added to `lib/metadata.py:VALID_STATUSES` on 05/13 but no script
or slash command emits them, so today every run goes `draft → in_progress`
directly via `create-worktree.sh`.

`lib/transitions.py:transition_with_evidence` was also added on 05/13. It
declares the required evidence for every documented edge (e.g.
`brainstorm → ready` needs `approved_by`) and validates the dict before
returning the new metadata. **Zero callers today.** Every script in `scripts/`
still calls bare `lib.metadata.transition()`.

This plan ships in four ordered passes.

---

## Pass 1 — Theme A (front-half slash commands) + Theme D (state-machine tightening)

### Goal

Make the front half a single command per stage. Wire every script that flips
status today to use `transition_with_evidence` with a real evidence payload.

### New slash commands under `.claude/commands/`

1. **`/new-task <repo_key> <slug> "<raw-idea>"`**

   The free-form equivalent of `/ingest-linear`. Calls `new-feature.sh` (same
   shape as `/ingest-linear`), then opens a tight 3-question intake in the
   session to populate `raw-idea.md` (Problem? Desired outcome? Constraints?).
   Status stays `draft`.

   *Why a slash command and not just a shell wrapper:* `/ingest-linear` is the
   precedent. It does the deterministic scaffold up front and then conducts an
   LLM-bearing intake in the same session. `/new-task` does the same thing,
   minus the Linear MCP fetch.

2. **`/normalize <run_dir>`**

   Reads `raw-idea.md` and (if present) the Linear ticket body in the run
   directory. Produces a fully populated `normalized-feature-input.md` using
   the template's section structure. Transitions `draft → normalize` (no
   evidence required) and then `normalize → brainstorm` with
   `normalized_spec_path=runs/<run_id>/normalized-feature-input.md` as
   evidence.

   Emits `Normalized` and `TransitionApplied` events.

3. **`/brainstorm <run_dir>`**

   Reads `normalized-feature-input.md`. Generates 2–4 implementation approaches
   as real `DR-NNN` entries in `decisions.md`. Prompts the user (in-session)
   to pick one or accept the recommendation. Drafts `spec.md` scaffold using
   the chosen approach as the implementation plan.

   Requires `approved_by` (the user's name or "agent") to flip
   `brainstorm → ready`. Emits `Brainstormed` and `TransitionApplied`.

   **Subagent discipline (Theme B):** when generating multiple approaches,
   spawn 2–4 parallel exploration subagents — one per candidate approach —
   each researching the relevant slice of the product repo. The master
   session collates their outputs into the DR entries. This is the canonical
   pattern Theme B is asking for: subagents fan out for parallelizable work,
   master session orchestrates.

4. **`/spec <run_dir>`** *(optional — may fold into `/brainstorm`)*

   Final polish on `spec.md` before status flips to `ready`. If
   `/brainstorm` already produces a complete `spec.md`, this command may not
   be needed. **Decision point:** ship `/brainstorm` end-to-end first, then
   decide if `/spec` is a distinct command or a polish step inside
   `/brainstorm`'s session. Default: skip `/spec` for Pass 1.

### Script edits — wire `transition_with_evidence` into every status flip

The 5 scripts that mutate state today, with the evidence each must now supply:

| Script | Edge | Evidence keys |
|---|---|---|
| `new-feature.sh` | (none — only creates a `draft` run) | — |
| `create-worktree.sh` | `ready → in_progress` (and legacy `planned → in_progress`) | `worktree_path`, `branch_name` |
| `open-pr.sh` | `in_progress → in_review` | `pr_url` |
| `qa-pass.sh` | `in_review → qa` | `review_decision` |
| `complete-run.sh` (merge path) | `qa → merged` | `tests_passed`, `pr_url`, `merge_sha` |
| `complete-run.sh` (abandon path) | `* → abandoned` | `abandoned_reason` |

For each: capture the required values before the Python block, pass them in
as argv, build the evidence dict in the Python block, call
`transition_with_evidence`, then `save` and `append`.

The `merge_sha` for the merge path is fetched from the product repo via
`git rev-parse <branch>` after the PR has merged. If the PR hasn't merged
yet, `complete-run.sh` should refuse without `--force-merge` (or
equivalent) — that mirrors the existing refusal-when-dirty behavior.

### Tightening (Theme D)

- **`qa-pass.sh` precondition.** Today it accepts any current status and
  flips to `qa`. Tighten to accept only `{in_progress, in_review}`. A
  `draft` run cannot have a QA pass.
- **`complete-run.sh --abandon` requires a reason.** Add `--reason "..."`,
  pipe it through as `abandoned_reason` evidence. Without it, exit 2 with
  a usage error.
- **`complete-run.sh` merge path requires `qa`.** Today the script accepts
  `{in_progress, in_review, qa}` for merge. Tighten to `qa` only.
  Migration path: an explicit `--skip-qa` flag with a stern warning, for
  runs where QA was done outside the workbench (e.g. emergency hotfixes).
- **Idempotent transitions.** `create-worktree.sh` and `open-pr.sh` already
  short-circuit when state is already right; preserve that and skip the
  `transition_with_evidence` call on the short-circuit path.

### Tests

`tests/test_transitions.py` already covers the evidence machinery. New
tests for the wired-in scripts go in a new file `tests/test_e2e.py` —
tempdir harness same shape as the 05/11 `/draft-pr` test and the 05/13
events-wiring test. One harness per script edit; assert the right edge
fires with the right evidence, and that bad evidence is refused with a
`TransitionError`.

---

## Pass 2 — Theme F (docs + template polish)

Land in the same session as Pass 1 (it's mostly text edits that should ship
alongside the code).

1. **Rewrite `docs/lifecycle.md`.** Currently shows 6 of the 12 valid
   statuses. Add the front half, the investigation branch, and document
   what evidence each edge needs (link to `lib/transitions.py:EVIDENCE`).
2. **`decisions.md` template — front-half scaffold.** Add a commented-out
   block at the top showing the DR-NNN format for normalize/brainstorm
   decisions, so `/brainstorm`'s output has a canonical shape to fill.
3. **`pr-summary.md` template — link `events.jsonl`.** Add it under
   "Linked artifacts" so reviewers can replay the run.
4. **`scripts/pr-summary.sh` — align or delete.** It's a thin print-only
   helper that does strictly less than `/draft-pr`. Delete it; `/draft-pr`
   is the canonical path.
5. **Missing end-to-end smoke tests** from the 05/14 audit:
   - real `gh pr create` against a real GitHub remote (still gated — needs
     a throwaway GitHub repo)
   - `/ingest-linear` against a real Linear ticket
   - `/review-run` happy path + bad-state rejection
   - `spawn-children.sh` with a real WBS block
   - `sync-to-beads.sh` against a real `bd` install

   Items 1, 2 need external resources and stay manual. Items 3–5 get
   tempdir harness tests in `tests/test_e2e.py`.

---

## Pass 3 — Theme C (watch-mode TUI dashboard)

New file: `scripts/wb-watch.py` (Python, stdlib-only if possible — falls
back to `rich` install if curses-only TUI is too painful).

### Read-only first

Per the brainstorm agreement: read-only viewer in Pass 3. Interactive
mode (advance status, open PR, abandon) is a follow-up if it earns its
keep.

### View

Single-screen layout:

```
ai-workbench — 2026-05-14 15:23 UTC                         [q] quit  [r] refresh

┌─ runs ────────────────────────────────────────────────────────────────────────┐
│  run_id                                  status      age   last event   PR    │
│  2026-05-14-foo-001                      in_progress 2h    create-wt    -     │
│  2026-05-13-bar-001                      in_review   1d    pr-opened    #423  │
│  2026-05-12-baz-001  (investigation)     investigat. 2d    spawn-child  -     │
│   └─ 2026-05-13-baz-001-impl-001          in_progress 1d    create-wt    -    │
│   └─ 2026-05-13-baz-001-tests-001         draft       1d    task-created -    │
└───────────────────────────────────────────────────────────────────────────────┘

[selected run drill-down — toggle with arrow keys / enter]
  feature_slug: foo
  repo: frontend (klaviyo/fender)
  branch: ai/2026-05-14-foo-001
  worktree: /Users/.../worktrees/2026-05-14-foo-001
  evidence pending for next edge (in_progress → in_review): pr_url

  events (last 5):
    2026-05-14T13:11Z TaskCreated         draft       script:new-feature.sh
    2026-05-14T13:15Z TransitionApplied   in_progress script:create-worktree.sh
```

### Refresh strategy

- Read `runs/*/metadata.yaml + events.jsonl` on every refresh.
- Default refresh: 2s. Configurable via flag.
- Watch-mode driven by `inotify`/`fsevents`? Probably overkill — polling
  every 2s on a single-user setup is fine and avoids platform code.

### Tests

Unit test the renderer against a fixture of `metadata.yaml + events.jsonl`
files. Skip the TUI loop itself — that's pure terminal plumbing.

---

## Pass 4 — Theme B (multi-agent subagent discipline)

Not a code change. Encoded as guidance in `docs/architecture.md` and
demonstrated in the Pass 1 slash commands (`/brainstorm` spawns parallel
exploration subagents; `/review-run` may fan out to multiple reviewer
skills in parallel).

### Concrete edits

1. Add a section to `docs/architecture.md` titled "Subagent discipline"
   that documents:
   - The master session is the orchestrator and owns lifecycle state.
   - Subagents (via the Agent tool) handle parallelizable work:
     independent file edits, parallel exploration, parallel reviews.
   - Subagents are scoped via the Agent type system (Explore, Plan,
     general-purpose) — pick the narrowest type that fits.
   - Multi-agent ≠ multi-process. Everything runs inside one Claude
     Code session.
2. Document the canonical pattern in `/brainstorm`: spawn 2–4 parallel
   exploration subagents (one per candidate approach), master session
   collates into DR entries.
3. Document the canonical pattern in `/review-run` (existing command):
   when `--agents` is plural, fan out to multiple reviewer skills in
   parallel and merge verdicts.

---

## Out of scope

- **Theme E (retry budget).** Per brainstorm: the human inspects failures
  and re-enqueues via a skill that invokes a CLI command. No automated
  3-cycle test/fix loop. Keep CI-fix manual.
- **Per-stage worker processes.** "Multi-agent" was clarified to mean
  subagent discipline within slash commands, not spawning separate worker
  processes for each lifecycle stage. The master session stays in charge.
- **GitHub Actions integration** (auto-flip status on PR merge webhook),
  **run archival**, **cross-run search CLI**, **run cloning** — all
  filed but deferred. Theme G items from the brainstorm.
- **Real `gh pr create`** and **real Linear `/ingest-linear`** end-to-end
  tests — need external resources, stay manual.

---

## Order of implementation (this session, single PR)

1. Write this plan to `plan.md`. Commit.
2. Commit existing in-progress changes (LOG.md and README.md edits from
   the 05/14 audit, plus the `plan.md` → `plan_archive.md` rotation).
3. **Pass 1 — Theme A + D:**
   1. `/new-task` slash command (mirror `/ingest-linear` structure).
   2. `/normalize` slash command.
   3. `/brainstorm` slash command.
   4. Wire `transition_with_evidence` into `create-worktree.sh`,
      `open-pr.sh`, `qa-pass.sh`, `complete-run.sh`.
   5. Tighten preconditions in `qa-pass.sh` and `complete-run.sh`.
   6. Tempdir-harness tests for each script edit.
4. **Pass 2 — Theme F:** docs + templates + delete `pr-summary.sh`.
5. **Pass 3 — Theme C:** `wb-watch.py` read-only TUI.
6. **Pass 4 — Theme B:** docs/architecture.md "Subagent discipline"
   section + documented patterns in the new slash commands.

Each pass commits separately so the history reads as a coherent rollout.

---

## What this leaves alone

- `lib/metadata.py:transition()` keeps its existing signature. New code
  uses `transition_with_evidence`. Existing tests that call `transition()`
  directly keep working.
- The Beads sync layer is unchanged. One-way, best-effort, optional.
- `ideas/raw/` and `ideas/normalized/` directories are kept (created by
  `init-repo.sh`) but Theme A doesn't use them — the canonical home for
  every artifact is `runs/<run_id>/`.
- `scripts/check-pr.sh` is unchanged — it doesn't flip status, just
  refreshes `run-log.md`.
- The investigation branch (`/ingest-linear` → `spawn-children.sh`) is
  unchanged. Theme A is about the feature branch front half; the
  investigation branch already has its own front half.
