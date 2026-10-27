---
description: Create an investigation run from a Linear ticket — fetches the body via Linear MCP into raw-idea.md and stitches normalized-feature-input.md. Replaces scripts/from-linear.sh.
---

## User input

```text
$ARGUMENTS
```

## What this does

`/ingest-linear <repo_key> <feature-slug> <linear_url_or_KEY>` creates an
investigation run from a Linear ticket. It:

1. Scaffolds `runs/<run_id>/` via `scripts/new-feature.sh`.
2. Patches `metadata.yaml` to set `linear_ticket=<KEY>` and
   `run_type=investigation`.
3. Uses Linear MCP to fetch the ticket body verbatim into `raw-idea.md`.
4. Stitches a `normalized-feature-input.md` from the ticket body following
   that template's section structure.
5. Mirrors the run as a bead with `run-type:investigation`.

This replaces `scripts/from-linear.sh`, which created the run dir but
printed instructions for the user to switch into a new Claude session and
do steps 3–4 manually.

## Workflow

### Step 1 — parse and validate arguments

`$ARGUMENTS` is `<repo_key> <feature-slug> <linear_url_or_KEY>`. All three
are required; if any are missing, stop and tell the user the usage.

`<linear_url_or_KEY>` may be either a full URL
(`https://linear.app/<workspace>/issue/KEY-NNN/...`) or a bare key
(`KEY-NNN`). Reject other shapes loudly.

### Step 2 — scaffold the run

Run this Bash block. Substitute `<repo_key>`, `<feature-slug>`, and
`<linear_input>` with the parsed args.

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
REPO_KEY="<repo_key>"
FEATURE_SLUG="<feature-slug>"
LINEAR_INPUT="<linear_input>"

# Validate the linear input shape.
if [[ "${LINEAR_INPUT}" =~ ^https://linear\.app/[^/]+/issue/[A-Z][A-Z0-9]*-[0-9]+(/.*)?$ ]]; then
  :
elif [[ "${LINEAR_INPUT}" =~ ^[A-Z][A-Z0-9]*-[0-9]+$ ]]; then
  :
else
  echo "linear arg must be a Linear URL or KEY-### (e.g. CORE-577); got '${LINEAR_INPUT}'"
  exit 2
fi

# Append "-investigation" to the slug so the run dir name reads as one.
INVESTIGATION_SLUG="${FEATURE_SLUG}-investigation"

# Skip the in-script bd mirror — we'll sync after patching run_type so the
# bead is labeled investigation from the start.
NEW_OUT="$(
  WORKBENCH_SKIP_BEADS_SYNC=1 \
    "${WORKBENCH_ROOT}/scripts/new-feature.sh" \
      "${REPO_KEY}" "${INVESTIGATION_SLUG}" "see linear: ${LINEAR_INPUT}"
)" || { echo "new-feature.sh failed"; exit 1; }

printf '%s\n' "${NEW_OUT}"

RUN_ID="$(printf '%s\n' "${NEW_OUT}" | sed -n 's/^created run: //p')"
[[ -n "${RUN_ID}" ]] || { echo "could not parse run_id from new-feature.sh"; exit 1; }

RUN_DIR="${WORKBENCH_ROOT}/runs/${RUN_ID}"

# Patch metadata: set linear_ticket + run_type=investigation.
PYTHONPATH="${WORKBENCH_ROOT}" python3 - "${RUN_DIR}" "${LINEAR_INPUT}" <<'PY'
import sys
from pathlib import Path
from dataclasses import replace
from lib.metadata import load, save

run_dir = Path(sys.argv[1])
linear = sys.argv[2]
md = load(run_dir)
md = replace(md, linear_ticket=linear, run_type="investigation")
save(run_dir, md, touch_updated_at=True)
PY

echo "RUN_ID=${RUN_ID}"
echo "RUN_DIR=${RUN_DIR}"
echo "LINEAR_INPUT=${LINEAR_INPUT}"
echo "WORKBENCH_ROOT=${WORKBENCH_ROOT}"
```

### Step 3 — extract the bare KEY from the linear input

If `LINEAR_INPUT` is a URL, extract the `KEY-NNN` portion (between `/issue/`
and the next `/` or end of string). If it's already a bare key, use it
as-is. Call this `LINEAR_KEY`.

### Step 4 — fetch the ticket body via Linear MCP

Use the Linear MCP tool to fetch the issue. Try in this order:

1. `mcp__claude_ai_Linear__get_issue` with `id=<LINEAR_KEY>` — preferred
   because the `claude_ai_Linear` server is already authenticated and
   indexed.
2. If unavailable, fall back to `mcp__linear-server__*` (call
   `mcp__linear-server__authenticate` first if it returns auth-required).

Capture the ticket's title, description (markdown body), state, and any
parent/child links you find useful.

### Step 5 — write raw-idea.md

Overwrite `<RUN_DIR>/raw-idea.md` with:

```markdown
# Raw idea

> Sourced from Linear: <LINEAR_INPUT>

## Linear ticket body

**Title:** <ticket title>
**State:** <ticket state>

<the verbatim markdown description from the ticket>
```

Preserve the ticket markdown verbatim (don't reformat). If the description
is empty, write `_(no description in Linear)_` under the heading.

### Step 6 — stitch normalized-feature-input.md

Read `<WORKBENCH_ROOT>/templates/normalized-feature-input.md` to see the
canonical sections (Problem / Desired outcome / Users / Constraints / Scope
/ Non-goals / Success metrics / Risks / Open questions).

Overwrite `<RUN_DIR>/normalized-feature-input.md` with one section per
heading. Pull from the ticket body:

- **Problem** — what is broken/missing per the ticket.
- **Desired outcome** — observable end state per the ticket.
- **Users** — who's affected (often implicit; infer or write `(unspecified
  in Linear)`).
- **Constraints** — any tech/time/compliance limits the ticket calls out.
- **Scope** — what's in scope per the ticket. Bullet list.
- **Non-goals** — what's explicitly not in scope. If absent, write
  `(none called out in Linear)`.
- **Success metrics** — quantitative or qualitative success signals.
- **Risks** — what could go wrong.
- **Open questions** — anything the ticket leaves unanswered.

Be honest when the ticket doesn't supply something — write `(not specified
in Linear)` rather than fabricating.

### Step 7 — sync to beads

Run:

```bash
"${WORKBENCH_ROOT}/scripts/sync-to-beads.sh" "${RUN_DIR}" || true
```

Best-effort. If `bd` is missing, the script no-ops.

### Step 8 — report

Print:

- `RUN_ID` and `RUN_DIR`.
- Linear ticket key + title.
- Files written: `raw-idea.md`, `normalized-feature-input.md`,
  patched `metadata.yaml`.
- Next steps:
  1. Review `runs/<run_id>/normalized-feature-input.md` and edit as needed.
  2. Author `runs/<run_id>/spec.md`.
  3. Manually flip `metadata.yaml` status: `draft → planned →
     investigating` when the spec is ready.
  4. `./scripts/create-worktree.sh runs/<run_id>` to start investigating.

## Edge cases

- **Unknown `repo_key`.** `new-feature.sh` rejects with a clear error; that
  bubbles up.
- **Bad slug shape.** Same — `new-feature.sh` rejects.
- **Linear MCP not authenticated.** Run the corresponding `*_authenticate`
  tool first; if the user hasn't completed the OAuth dance, stop and ask
  them to do so.
- **Ticket not found.** Surface the MCP error verbatim and stop. The run
  dir is left in place; the user can fix the key and re-run by deleting
  the partial run dir or re-running with a corrected slug (which will
  auto-increment to `-002`).
- **`bd` missing.** Step 7's `|| true` swallows it. Validate later via
  `validate-workbench.sh`.
