---
description: Generate 2–4 implementation approaches as DR-NNN entries in decisions.md, draft spec.md, and transition brainstorm → ready with the user's approval as evidence. Spawns parallel exploration subagents to research each approach in the product repo.
---

## User input

```text
$ARGUMENTS
```

## What this does

`/brainstorm <run_dir> [--approaches N]` is the second front-half command:

1. Reads `normalized-feature-input.md` (the output of `/normalize`).
2. **Spawns 2–4 parallel exploration subagents** — one per candidate
   implementation approach — each researching the relevant slice of the
   product repo.
3. Collates the subagents' findings into `DR-NNN` entries in
   `decisions.md`.
4. Asks the user to pick one approach (or accept the recommendation).
5. Drafts `spec.md` from the chosen approach.
6. Transitions `brainstorm → ready` with `approved_by` as evidence.

The subagent fan-out is the canonical "Theme B" pattern: master session
orchestrates, subagents handle parallelizable exploration. Each subagent
gets a narrowly scoped task and returns a concise findings packet.

## Workflow

### Step 1 — resolve and validate the run

`$ARGUMENTS` is `<run_dir> [--approaches N]`. Default `N=3`. Clamp to
`[2, 4]`.

Run this Bash block.

```bash
find_workbench_root() {
  local d="$PWD"
  while [[ "$d" != "/" ]]; do
    if [[ -d "$d/runs" && -f "$d/lib/run.py" ]]; then
      echo "$d"
      return 0
    fi
    d="$(dirname "$d")"
  done
  return 1
}

WORKBENCH_ROOT="$(find_workbench_root)" \
  || { echo "could not locate ai-workbench root above CWD ($PWD)"; exit 1; }
RUN_DIR_INPUT="<run_dir>"

INFO_RAW="$(
  PYTHONPATH="${WORKBENCH_ROOT}" python3 - "${RUN_DIR_INPUT}" <<'PY'
import sys
from lib.run import load_run, RunError

try:
    info = load_run(sys.argv[1])
except RunError as exc:
    print(f"ERR:{exc}", file=sys.stderr)
    sys.exit(1)

md = info.metadata
if md.status not in ("brainstorm", "ready"):
    print(
        f"ERR:status must be 'brainstorm' or 'ready' to run /brainstorm; "
        f"got {md.status!r}. Run /normalize first.",
        file=sys.stderr,
    )
    sys.exit(1)

print(f"{md.run_id}|{md.status}|{md.repo_key}|{md.repo_path}|{info.run_dir}")
PY
)" || { echo "load failed (see message above)"; exit 1; }

IFS='|' read -r RUN_ID CUR_STATUS REPO_KEY REPO_PATH RUN_DIR <<<"${INFO_RAW}"

echo "RUN_ID=${RUN_ID}"
echo "RUN_DIR=${RUN_DIR}"
echo "CUR_STATUS=${CUR_STATUS}"
echo "REPO_KEY=${REPO_KEY}"
echo "REPO_PATH=${REPO_PATH}"
echo "WORKBENCH_ROOT=${WORKBENCH_ROOT}"
```

### Step 2 — read the normalized input

Use the Read tool to load `<RUN_DIR>/normalized-feature-input.md`. This
is the spec-ready problem statement that drives the brainstorm.

### Step 3 — spawn exploration subagents (Theme B fan-out)

For each candidate approach (default 3), spawn a parallel Agent of type
`Explore` (read-only) with a tightly-scoped prompt. The prompt **must**:

- Be self-contained — the subagent sees only what you pass it.
- Name the product repo path (`<REPO_PATH>`) and tell it to scope its
  investigation there.
- Describe the problem from `normalized-feature-input.md` (paraphrase if
  long).
- Describe the **specific approach** this subagent is investigating
  (different from the other subagents' approaches).
- Ask for a fixed-shape return: (1) where the relevant code lives,
  (2) what would change under this approach, (3) risks specific to this
  approach, (4) a one-line verdict on feasibility.

**Send all subagent calls in a single tool-use message** so they run
concurrently. (The CLAUDE.md instruction is explicit: "When you launch
multiple agents for independent work, send them in a single message with
multiple tool uses so they run concurrently.")

Example shape (don't copy verbatim — tailor to the normalized input):

> Approach A: minimal-surface-area patch. Change only the entry point.
> Approach B: refactor first, then patch. Pull the affected logic into a
>             helper, then change the helper.
> Approach C: rewrite the affected component end-to-end.

Pick approaches that are **genuinely different** in scope/risk/cost.
Three approaches that are essentially the same waste subagent capacity.

### Step 4 — collate into decisions.md as DR-NNN entries

Once the subagents return, build `<RUN_DIR>/decisions.md` content with
one `## DR-NNN` block per approach (NNN = 001, 002, …). Each block
follows the template's format:

```markdown
## DR-001 — Approach A: minimal-surface-area patch (2026-05-14)
**Status:** proposed
**Context:** <one paragraph — the problem, drawing from
normalized-feature-input.md>
**Options considered:**
  - A — minimal-surface-area patch: pros (fast, low risk) / cons
    (doesn't fix root cause)
  - B — refactor first, then patch: pros (cleaner long term) / cons
    (longer reach, more reviewer load)
  - C — rewrite: pros (clears tech debt) / cons (high cost,
    high risk)
**Decision:** _(deferred to user — see Step 5)_
**Consequences:** _(filled after user picks)_
```

Don't duplicate the full A/B/C list under every DR — one consolidated
entry is fine, with `DR-002` and `DR-003` only added if there are
non-overlapping sub-decisions (e.g. dependency choice, migration
strategy) that deserve separate ADRs.

Use the Read tool to read the existing `decisions.md` first; use Write
to overwrite it with the new content. Preserve the template's intro
block (the `> Lightweight ADRs scoped to this run.` quote) at the top.

### Step 5 — ask the user to pick an approach

Use `AskUserQuestion` with one single-select question listing the 2–4
approaches as options. Include a recommended option marked
"(Recommended)" if one approach is clearly superior on cost/risk
tradeoff. Phrase options as one short label + one-line description per
the AskUserQuestion contract.

Capture the user's choice as `CHOSEN_APPROACH`.

### Step 6 — finalize decisions.md and draft spec.md

Use the Edit tool to update `decisions.md`:

- Change `**Status:** proposed` → `**Status:** accepted` on the chosen
  DR.
- Fill the `**Decision:**` line with the chosen approach + one sentence
  on why.
- Fill `**Consequences:**` with what this commits the run to and what
  becomes harder.

Use the Read tool to read `<RUN_DIR>/spec.md` (currently the template
skeleton). Use the Write tool to overwrite it with a full spec drawn
from the chosen approach. Section structure must match the template:

| Section | Source |
|---|---|
| Summary | 2–3 sentences synthesizing the normalized input + chosen approach. |
| Architecture → Current state | Subagent's findings on "where the relevant code lives". |
| Architecture → Target state | Subagent's findings on "what would change". |
| Architecture → Key components affected | Bullet from the subagent's "what would change", one rationale per bullet. |
| Implementation plan | Ordered atomic steps. Each should be reviewable as one commit. |
| Data / schema changes | If any. `(none)` otherwise. |
| Interface changes | API / RPC / UI surfaces. Mark breaking vs. additive. |
| Dependencies | Other services, runs, libraries. |
| QA plan → Automated | Unit / integration / e2e to add. |
| QA plan → Manual | Browser steps or python/curl per the project conventions. |
| QA plan → Out of scope | Pair with non-goals. |
| Rollout plan → Deployment | Flag? Staged? |
| Rollout plan → Monitoring | Dashboards, alerts. |
| Rollout plan → Rollback | Procedure. "Revert PR" is acceptable if sufficient. |
| Open questions | Anything still unresolved. |

Drop the template's `<!-- ... -->` comments. Don't fabricate — if a
section has no real content (e.g. there are no data changes), write
`_(none)_` rather than inventing.

### Step 7 — transition brainstorm → ready

Run this Bash block. `approved_by` is the evidence — pass either the
user's git config name, or the literal string `"user"` if no better
identifier is available.

```bash
APPROVED_BY="$(git config user.name 2>/dev/null || echo 'user')"

PYTHONPATH="${WORKBENCH_ROOT}" python3 - "${RUN_DIR}" "${APPROVED_BY}" "${CHOSEN_APPROACH}" <<'PY' \
  || echo "warn: brainstorm → ready transition failed for ${RUN_DIR}" >&2
import sys
from pathlib import Path
from lib.metadata import load, save
from lib.transitions import transition_with_evidence, TransitionError
from lib.events import Event, append

run_dir = Path(sys.argv[1])
approved_by = sys.argv[2]
chosen = sys.argv[3]

md = load(run_dir)
from_state = md.status
# Re-running /brainstorm on a ready run: just emit a Brainstormed event
# (no transition needed — already past the gate).
if md.status == "ready":
    try:
        append(run_dir, Event(
            event_type="Brainstormed",
            actor="slash:brainstorm",
            payload={"approved_by": approved_by, "chosen_approach": chosen, "rerun": "true"},
        ))
    except Exception as exc:
        print(f"warn: event-log append failed: {exc}", file=sys.stderr)
    sys.exit(0)

evidence = {"approved_by": approved_by}
try:
    md, trimmed = transition_with_evidence(md, "ready", evidence)
except TransitionError as exc:
    print(f"ERR:{exc}", file=sys.stderr)
    sys.exit(1)
save(run_dir, md)

try:
    append(run_dir, Event(
        event_type="Brainstormed",
        actor="slash:brainstorm",
        payload={"approved_by": approved_by, "chosen_approach": chosen},
    ))
    append(run_dir, Event(
        event_type="TransitionApplied",
        actor="slash:brainstorm",
        from_state=from_state,
        to_state="ready",
        payload=trimmed,
    ))
except Exception as exc:
    print(f"warn: event-log append failed: {exc}", file=sys.stderr)
PY
```

Substitute `${CHOSEN_APPROACH}` with the value captured in Step 5
(e.g. `"approach-A-minimal-patch"`).

### Step 8 — report

Print:

- Path to `decisions.md` (with the accepted DR).
- Path to `spec.md` (now drafted).
- New status: `ready`.
- A one-line summary of the chosen approach.
- Suggest next step: `./scripts/create-worktree.sh runs/<run_id>` to
  start implementing.

## Edge cases

- **Run not in `brainstorm` or `ready`.** Step 1 refuses. Run
  `/normalize` first.
- **Subagent returns nothing useful.** Note in the corresponding DR
  block that the approach is "not feasible — subagent could not locate
  relevant code." Continue with the remaining approaches.
- **User picks "none of these"** in Step 5. Treat as "go back and
  brainstorm again." Don't transition. Tell the user to re-run
  `/brainstorm` (perhaps with `--approaches 4`) or to manually edit
  `normalized-feature-input.md` to clarify scope before re-running.
- **`AskUserQuestion` not available in this runtime.** Fall back to
  printing the approaches and asking the user to reply with a number.
  Skip the transition — wait for the user's reply.
- **Re-running on `ready`.** Allowed. Emits a `Brainstormed` event
  with `rerun: "true"` payload but doesn't re-transition. Useful when
  the user wants to regenerate the spec from the same approach choice.

## Why parallel subagents

This command is the canonical example of the subagent discipline
documented in [`docs/architecture.md` § Subagent discipline](../../docs/architecture.md#subagent-discipline):
the master session is the orchestrator and owns state (metadata.yaml
transitions, event-log writes, file I/O on the run directory). The
subagents handle parallelizable exploration (independent reads of the
product repo, one per candidate approach). Their results flow back to
the master session, which collates them into a single artifact
(`decisions.md`) and asks the user for approval.

This is **not** multi-process. Every subagent runs inside the same
Claude Code session via the Agent tool. The orchestration boundary is
session-internal.
