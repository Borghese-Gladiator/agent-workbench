---
description: Create a fresh ai-workbench run from a free-form task description. Calls new-feature.sh, then conducts a tight intake to populate raw-idea.md. Use when starting work that isn't from a Linear ticket — for the Linear case use /ingest-linear instead.
---

## User input

```text
$ARGUMENTS
```

## What this does

`/new-task <repo_key> <feature-slug> "<raw idea>"` creates a new run with
`status: draft` and populates `raw-idea.md` with the user's description.
Optionally conducts a 3-question intake to make the raw idea more complete
before status flips forward.

This is the free-form counterpart to `/ingest-linear`. Same scaffold step
(both call `scripts/new-feature.sh`); the difference is the source —
`/new-task` is from a thought, `/ingest-linear` is from a Linear ticket.

## Workflow

### Step 1 — parse and validate arguments

`$ARGUMENTS` is `<repo_key> <feature-slug> "<raw idea>"`. All three are
required.

- `<repo_key>` must exist in `config/repos.yaml`.
- `<feature-slug>` must be kebab-case, starting with a letter
  (`new-feature.sh` rejects bad slugs).
- `<raw idea>` is free-form text. Single line OK; multi-line goes through
  the user's shell quoting.

If any are missing, stop and tell the user the usage:

```
/new-task <repo_key> <feature-slug> "<raw idea>"

example:
  /new-task frontend better-onboarding "compress 5-step signup into 3 steps"
```

### Step 2 — scaffold the run

Run this Bash block. Substitute `<repo_key>`, `<feature-slug>`, and
`<raw_idea>` with the parsed args.

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
RAW_IDEA="<raw_idea>"

NEW_OUT="$(
  "${WORKBENCH_ROOT}/scripts/new-feature.sh" \
    "${REPO_KEY}" "${FEATURE_SLUG}" "${RAW_IDEA}"
)" || { echo "new-feature.sh failed"; exit 1; }

printf '%s\n' "${NEW_OUT}"

RUN_ID="$(printf '%s\n' "${NEW_OUT}" | sed -n 's/^created run: //p')"
[[ -n "${RUN_ID}" ]] || { echo "could not parse run_id from new-feature.sh"; exit 1; }

RUN_DIR="${WORKBENCH_ROOT}/runs/${RUN_ID}"

echo "RUN_ID=${RUN_ID}"
echo "RUN_DIR=${RUN_DIR}"
echo "WORKBENCH_ROOT=${WORKBENCH_ROOT}"
```

`new-feature.sh` has already:
- Created `runs/<run_id>/` populated from the 8 templates.
- Written `<raw_idea>` verbatim into `raw-idea.md` under the
  "Captured at run-creation time" heading.
- Rendered `metadata.yaml` with `status=draft`.
- Emitted a `TaskCreated` event into `events.jsonl`.
- Best-effort mirrored to Beads.

### Step 3 — intake the raw idea (3 short questions)

The template `raw-idea.md` has four sections: "What sparked this", "The
thought", "Why it might matter", "Adjacent thoughts / related work". The
user's `<raw_idea>` argument is already in the file under a
"Captured at run-creation time" heading. Your job is to fill in the
template's sections by asking the user three tight questions:

1. **What sparked this?** — one sentence on the trigger (observation,
   incident, frustration, opportunity).
2. **Why it might matter?** — one sentence on the underlying value.
3. **Anything adjacent?** — related ideas, existing tickets, prior threads.
   Skip if nothing comes to mind.

Use the `AskUserQuestion` tool with all three questions in one call so the
user answers them together. If any answer is just `(skip)` or empty,
that's fine — write `_(not specified)_` in the corresponding section.

### Step 4 — write raw-idea.md

Use the Read tool to read `<RUN_DIR>/raw-idea.md` and the Edit tool to
fill in the sections. Preserve the existing "Captured at run-creation
time" block at the bottom — that's the original verbatim quote. Replace
the template's `<!-- ... -->` comments under each of the four headings
with the user's answers (or `_(not specified)_`).

### Step 5 — report

Print:

- `RUN_ID` and `RUN_DIR`.
- Files written: `raw-idea.md` (filled), `metadata.yaml` (rendered).
- Next steps:
  1. `/normalize <run_dir>` — stitch the normalized-feature-input.
  2. `/brainstorm <run_dir>` — generate implementation approaches.
  3. `./scripts/create-worktree.sh runs/<run_id>` — start implementing.

For subdirectory projects (where `repos.yaml` sets `project_subpath`),
`create-worktree.sh` will print the project dir (`<worktree>/<project_subpath>`)
as the `cd` target. The git worktree itself is always cut at the full git
root — see README §"Subdirectory projects".

## Edge cases

- **Unknown `repo_key`.** `new-feature.sh` rejects with a clear error;
  surface it and stop.
- **Bad slug shape.** Same — `new-feature.sh` rejects.
- **User skips all three intake questions.** Still write
  `_(not specified)_` placeholders rather than leaving the
  `<!-- ... -->` template comments in place. The next stage
  (`/normalize`) will flag missing context if it's truly insufficient.
