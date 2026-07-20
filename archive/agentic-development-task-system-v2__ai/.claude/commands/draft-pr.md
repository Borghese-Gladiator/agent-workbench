---
description: Stitch runs/<run_id>/pr-summary.md from the run's spec/decisions/qa-log/run-log artifacts and capture the diff stat into run-log.md. Replaces scripts/draft-pr-summary.sh.
---

## User input

```text
$ARGUMENTS
```

## What this does

`/draft-pr <run_dir>` finishes the deterministic part of PR-summary preparation
(diff capture into `run-log.md`) and then stitches `pr-summary.md` from the
run's artifacts following the canonical template structure.

This replaces the old `scripts/draft-pr-summary.sh`, which could only do the
deterministic part and printed instructions for the user to "open a Claude
session and ask…" — that's what you're already in. Do the work directly.

## Workflow

### Step 1 — resolve the run and capture the diff

Run this Bash block. Substitute `<run_dir>` with the user's argument from
`$ARGUMENTS`. If `$ARGUMENTS` is empty, stop and tell the user the usage:
`/draft-pr <run_dir>`.

```bash
# Find the workbench root by walking up from CWD looking for a dir with both
# runs/ and lib/run.py. Falls through if invoked from inside a worktree
# checkout that lives under the workbench.
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
if not md.worktree_path:
    print("ERR:run has no worktree_path; run create-worktree.sh first.", file=sys.stderr)
    sys.exit(1)

print(f"{md.run_id}|{md.branch_name}|{md.worktree_path}|{md.default_branch}|{info.run_dir}")
PY
)" || { echo "load failed (see message above)"; exit 1; }

IFS='|' read -r RUN_ID BRANCH WORKTREE DEFAULT_BRANCH RUN_DIR <<<"${INFO_RAW}"

[[ -d "${WORKTREE}" ]] || { echo "worktree not on disk: ${WORKTREE}"; exit 1; }

TIMESTAMP="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

DIFF_STAT="$(
  git -C "${WORKTREE}" --no-pager diff --stat "${DEFAULT_BRANCH}...HEAD" 2>&1 \
    || printf '(diff --stat failed; default branch=%s, HEAD ref may not exist yet)' "${DEFAULT_BRANCH}"
)"

DIFF_FILES="$(
  git -C "${WORKTREE}" --no-pager diff --name-only "${DEFAULT_BRANCH}...HEAD" 2>/dev/null \
    || true
)"

{
  printf '\n## Files changed (auto)  — %s\n\n' "${TIMESTAMP}"
  printf 'Captured by /draft-pr.\n\n'
  printf '```\n'
  printf '%s\n' "${DIFF_STAT}"
  printf '```\n\n'
  if [[ -n "${DIFF_FILES}" ]]; then
    printf 'Files:\n'
    printf '%s\n' "${DIFF_FILES}" | sed 's/^/  - /'
    printf '\n'
  fi
} >> "${RUN_DIR}/run-log.md"

echo "RUN_ID=${RUN_ID}"
echo "RUN_DIR=${RUN_DIR}"
echo "WORKTREE=${WORKTREE}"
echo "BRANCH=${BRANCH}"
```

The captured `RUN_ID` and `RUN_DIR` are what you'll use for the next steps.

### Step 2 — read the four source artifacts and the template

Use the Read tool to read each of these files:

1. `<RUN_DIR>/spec.md`
2. `<RUN_DIR>/decisions.md`
3. `<RUN_DIR>/qa-log.md`
4. `<RUN_DIR>/run-log.md`
5. `<WORKBENCH_ROOT>/templates/pr-summary.md`

The template tells you which sections to produce and what each section is
supposed to draw from.

### Step 3 — stitch pr-summary.md

Write `<RUN_DIR>/pr-summary.md` using the Write tool. Preserve the template's
heading structure exactly. Each heading's content comes from a specific
artifact:

| Section | Source |
|---|---|
| Title | One imperative-mood line summarizing the change. Pull from `spec.md` → goal. <70 chars. |
| Why | `normalized-feature-input.md` → Problem + Desired outcome. If absent, fall back to `spec.md`. |
| What changed | `spec.md` → Implementation plan. Bullet the actual deltas reflected in `run-log.md`'s diff. |
| How it was tested | `qa-log.md` (most recent QA-N entries) + any test notes in `run-log.md`. |
| Risk / rollout notes | `spec.md` → Rollout plan. Mention flags, monitoring, rollback. |
| Linked artifacts | Use the template's bullets; substitute `<run_id>` with the actual `RUN_ID`. |
| Checklist | Use the template's checklist verbatim. |

Drop the template's `<!-- comments -->` — they're authoring hints, not
content. Do not invent details; if a section's source is empty, write a
brief honest placeholder ("No risk notes recorded — review spec.md before
opening the PR.") rather than fabricating.

If `<RUN_DIR>/pr-summary.md` already exists, overwrite it. The prior content
is preserved in git history. Print a one-line note that it was overwritten.

### Step 4 — report

Print:

- Path to the written `pr-summary.md`.
- Which artifacts were used for which sections (a 1-line per section
  mapping).
- Suggest the user review the file, then run
  `./scripts/open-pr.sh runs/<run_id>` to open the draft PR.

## Edge cases

- **Worktree missing on disk.** Step 1 fails fast. The user needs to run
  `create-worktree.sh` first.
- **Default branch ref absent.** `git diff --stat` will fail; the captured
  block records the failure. Continue with stitching using the artifacts
  alone — the stitch doesn't require the diff.
- **Some artifacts empty.** Honest placeholders, not fabrication.
