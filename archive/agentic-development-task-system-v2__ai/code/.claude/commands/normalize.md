---
description: Read raw-idea.md and stitch a fully-populated normalized-feature-input.md. Transitions the run draft → normalize → brainstorm with evidence. Use after /new-task or /ingest-linear to make the spec-ready input before brainstorming.
---

## User input

```text
$ARGUMENTS
```

## What this does

`/normalize <run_dir>` takes the raw idea and produces a spec-ready
normalized input. It:

1. Reads `raw-idea.md` and (if present) the Linear ticket body.
2. Fills every required section of `normalized-feature-input.md` —
   Problem, Desired outcome, Users, Constraints, Scope, Non-goals,
   Success metrics, Risks, Open questions.
3. Transitions `draft → normalize` (no evidence required by the state
   machine) and then `normalize → brainstorm` with
   `normalized_spec_path` as evidence.
4. Emits a `Normalized` event + two `TransitionApplied` events into
   `events.jsonl`.

This closes the gap documented in the 05/14 LOG entry: the README's
"draft → normalize → brainstorm → ready" lifecycle was documented but
unimplemented; `/normalize` is the first script to set status to
`normalize` or `brainstorm`.

## Workflow

### Step 1 — resolve and validate the run

Run this Bash block. Substitute `<run_dir>` from `$ARGUMENTS`. If empty,
stop and tell the user the usage: `/normalize <run_dir>`.

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
# /normalize is the gate between draft and brainstorm. Accept either:
#   - draft: fresh from /new-task or /ingest-linear, or
#   - normalize: a re-run (user wants to regenerate the normalized input).
# Reject everything else loudly — brainstorm/ready/in_progress runs have
# already moved past this step and re-running would lose context.
if md.status not in ("draft", "normalize"):
    print(
        f"ERR:status must be 'draft' or 'normalize' to run /normalize; "
        f"got {md.status!r}",
        file=sys.stderr,
    )
    sys.exit(1)

print(f"{md.run_id}|{md.status}|{md.linear_ticket}|{info.run_dir}")
PY
)" || { echo "load failed (see message above)"; exit 1; }

IFS='|' read -r RUN_ID CUR_STATUS LINEAR_TICKET RUN_DIR <<<"${INFO_RAW}"

echo "RUN_ID=${RUN_ID}"
echo "RUN_DIR=${RUN_DIR}"
echo "CUR_STATUS=${CUR_STATUS}"
echo "LINEAR_TICKET=${LINEAR_TICKET}"
echo "WORKBENCH_ROOT=${WORKBENCH_ROOT}"
```

### Step 2 — transition draft → normalize (if needed)

If `CUR_STATUS=draft`, advance the run to `normalize`. This edge has no
required evidence; the transition is purely a marker that normalization
is in progress.

```bash
if [[ "${CUR_STATUS}" == "draft" ]]; then
  PYTHONPATH="${WORKBENCH_ROOT}" python3 - "${RUN_DIR}" <<'PY' \
    || echo "warn: draft → normalize transition failed for ${RUN_DIR}" >&2
import sys
from pathlib import Path
from lib.metadata import load, save
from lib.transitions import transition_with_evidence, TransitionError
from lib.events import Event, append

run_dir = Path(sys.argv[1])
md = load(run_dir)
from_state = md.status
try:
    md, trimmed = transition_with_evidence(md, "normalize", {})
except TransitionError as exc:
    print(f"ERR:{exc}", file=sys.stderr)
    sys.exit(1)
save(run_dir, md)
try:
    append(run_dir, Event(
        event_type="TransitionApplied",
        actor="slash:normalize",
        from_state=from_state,
        to_state="normalize",
        payload=trimmed,
    ))
except Exception as exc:
    print(f"warn: event-log append failed: {exc}", file=sys.stderr)
PY
fi
```

### Step 3 — read the inputs

Use the Read tool to read:

1. `<RUN_DIR>/raw-idea.md` — the user's verbatim thought.
2. `<RUN_DIR>/normalized-feature-input.md` — the template you're filling.
3. `<WORKBENCH_ROOT>/templates/normalized-feature-input.md` — for
   reference on which sections are mandatory.

If `LINEAR_TICKET` is non-empty, the raw-idea.md should already contain
the Linear body (placed there by `/ingest-linear`). No separate MCP fetch
is needed — the body is on disk.

### Step 4 — stitch normalized-feature-input.md

Use the Write tool to overwrite `<RUN_DIR>/normalized-feature-input.md`
with a fully populated version. The template's section structure is:

| Section | What goes here |
|---|---|
| Problem | Concrete description of what's broken / missing / suboptimal. Pull from raw-idea.md's "What sparked this" + "The thought" sections. |
| Desired outcome | Observable end state (not mechanism-level). One paragraph. Pull from raw-idea.md and any "Why it might matter" content. |
| Users | Who's affected. Internal teams, external customers, personas. Infer from context if not explicit. |
| Constraints | Tech, time, security, compliance, dependencies. Surface anything the raw idea calls out; leave `(none identified)` if truly absent. |
| Scope | Bullet list of what IS in scope for this run. |
| Non-goals | Bullet list of what is explicitly NOT being attempted. Be ruthless — non-goals prevent scope creep. |
| Success metrics | Quantitative if possible (latency, conversion, error rate), qualitative if not. |
| Risks | Technical, product, organizational. Include a one-line mitigation per risk, even if "accept and monitor". |
| Open questions | Anything the raw idea can't answer alone. Tag with `@owner` if a specific person should resolve. |

Discipline:
- **Be honest about gaps.** If the raw idea doesn't supply Success
  metrics or Non-goals, write `_(not specified in raw idea — to be
  resolved during /brainstorm)_` rather than fabricating.
- **Don't lose verbatim user language.** When the raw idea contains a
  specific phrasing the user clearly cares about, preserve it.
- **Stay observable, not prescriptive.** Desired outcome is "users sign
  up faster", not "we should rewrite the signup component". The latter
  belongs in `/brainstorm`.

Drop the template's `<!-- ... -->` comments — they're authoring hints,
not content.

### Step 5 — transition normalize → brainstorm

Run this Bash block. `normalized_spec_path` is the evidence for this
edge — point it at the file you just wrote.

```bash
PYTHONPATH="${WORKBENCH_ROOT}" python3 - "${RUN_DIR}" "${RUN_ID}" <<'PY' \
  || echo "warn: normalize → brainstorm transition failed for ${RUN_DIR}" >&2
import sys
from pathlib import Path
from lib.metadata import load, save
from lib.transitions import transition_with_evidence, TransitionError
from lib.events import Event, append

run_dir = Path(sys.argv[1])
run_id = sys.argv[2]
md = load(run_dir)
from_state = md.status
spec_path = f"runs/{run_id}/normalized-feature-input.md"
evidence = {"normalized_spec_path": spec_path}
try:
    md, trimmed = transition_with_evidence(md, "brainstorm", evidence)
except TransitionError as exc:
    print(f"ERR:{exc}", file=sys.stderr)
    sys.exit(1)
save(run_dir, md)
try:
    append(run_dir, Event(
        event_type="Normalized",
        actor="slash:normalize",
        payload={"normalized_spec_path": spec_path},
    ))
    append(run_dir, Event(
        event_type="TransitionApplied",
        actor="slash:normalize",
        from_state=from_state,
        to_state="brainstorm",
        payload=trimmed,
    ))
except Exception as exc:
    print(f"warn: event-log append failed: {exc}", file=sys.stderr)
PY
```

### Step 6 — report

Print:

- `RUN_ID` and the path to the written `normalized-feature-input.md`.
- New status: `brainstorm`.
- A one-line summary of each filled section (Problem, Desired outcome,
  …) so the user can sanity-check at a glance.
- Suggest next step: `/brainstorm <run_dir>`.

## Edge cases

- **Run not in `draft` or `normalize`.** Step 1 refuses. The user must
  either pick a different run or back up via manual metadata edits.
- **`raw-idea.md` is essentially empty** (only template comments).
  Surface this fact and ask the user whether to continue with mostly
  `_(not specified)_` placeholders or to populate `raw-idea.md` first.
- **Linear ticket inferred but body missing.** If `LINEAR_TICKET` is set
  but `raw-idea.md` shows no ticket body, the user probably skipped
  Step 4 of `/ingest-linear`. Stop and tell them to re-run
  `/ingest-linear` first.
- **Re-run from `normalize`.** Idempotent: re-running just rewrites
  `normalized-feature-input.md` and re-emits the `normalize → brainstorm`
  transition. The event log will have two `TransitionApplied` entries
  in a row — that's intentional, it shows the regeneration history.
