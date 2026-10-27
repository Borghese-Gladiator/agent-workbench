---
description: Run an adversarial review skill (default /dg) inside the run's worktree, then record the verdict via qa-pass.sh. Replaces scripts/review.sh.
---

## User input

```text
$ARGUMENTS
```

## What this does

`/review-run <run_dir> [--agent <name>]` resolves the run, validates that
it's in a reviewable state, invokes the chosen review skill against the
worktree's working tree, and records the verdict in `qa-log.md`.

`<name>` defaults to `dg`. Other reasonable choices: `simplify`, `pr-review`.

This replaces the old `scripts/review.sh`, which printed a paragraph asking
the user to switch into a new Claude session in the worktree and run the
skill manually.

## Workflow

### Step 1 — parse arguments

`$ARGUMENTS` is `<run_dir> [--agent <name>]`. Default `<name>` to `dg` if
absent. If `<run_dir>` is empty, stop and tell the user the usage.

### Step 2 — validate the run

Run this Bash block. Substitute `<run_dir>` from the user's argument.

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
if not md.worktree_path:
    print("ERR:run has no worktree_path; run create-worktree.sh first.", file=sys.stderr)
    sys.exit(1)

if md.status not in {"in_progress", "in_review"}:
    print(
        f"ERR:status must be 'in_progress' or 'in_review' to run a review; "
        f"got {md.status!r}",
        file=sys.stderr,
    )
    sys.exit(1)

print(f"{md.run_id}|{md.branch_name}|{md.worktree_path}|{info.run_dir}")
PY
)" || { echo "load failed (see message above)"; exit 1; }

IFS='|' read -r RUN_ID BRANCH WORKTREE RUN_DIR <<<"${INFO_RAW}"

CURRENT_BRANCH="$(git -C "${WORKTREE}" branch --show-current)"
[[ "${CURRENT_BRANCH}" = "${BRANCH}" ]] \
  || { echo "worktree on branch ${CURRENT_BRANCH}, expected ${BRANCH}"; exit 1; }

echo "RUN_ID=${RUN_ID}"
echo "RUN_DIR=${RUN_DIR}"
echo "WORKTREE=${WORKTREE}"
echo "BRANCH=${BRANCH}"
echo "WORKBENCH_ROOT=${WORKBENCH_ROOT}"
```

### Step 3 — invoke the review skill

Use the Skill tool with `skill="<name>"` (the parsed agent name, default
`dg`). The skill is meant to operate against the worktree's working tree —
its `cwd` should be `<WORKTREE>`. If your Skill invocation mechanism doesn't
set cwd, instruct the skill in the args that the worktree under review is
`<WORKTREE>` and ask it to scope its review to that path.

Capture the skill's final user-visible message — that's the verdict text.

If the named skill isn't installed, the Skill tool will surface an error.
Catch it and report:

> `skill <name> not available — install or pick another with --agent`.

Then stop without recording any QA entry.

### Step 4 — categorize the verdict

Read the verdict text and decide a result code:

- **`pass`** — the skill found no blocking issues.
- **`fail`** — the skill found issues that block merging.
- **`pass-with-followups`** — the skill flagged non-blocking concerns.

If the skill's verdict isn't clearly any of those, default to
`pass-with-followups` and note that ambiguity in the recorded notes.

### Step 5 — record the verdict via qa-pass.sh

Pipe the verdict text into `qa-pass.sh -n -` (stdin form). Substitute
`<result>` with the code from step 4 and `<agent>` with the chosen name.

```bash
printf '%s\n' "<verdict text from step 3>" \
  | "${WORKBENCH_ROOT}/scripts/qa-pass.sh" "${RUN_DIR}" \
      -r "<result>" \
      -t "<agent>" \
      -s "adversarial review" \
      -n -
```

`qa-pass.sh` appends the QA entry, flips status to `qa`, and best-effort
mirrors to beads.

### Step 6 — report

Print:

- Result code.
- One-line summary of the verdict.
- New status (`qa`).
- Path to the QA log (`<RUN_DIR>/qa-log.md`).
- Suggest next step: if pass, `/draft-pr <run_dir>` then `open-pr.sh`. If
  fail, fix the flagged issues and re-run `/review-run`.

## Edge cases

- **No worktree.** Step 2 rejects fast.
- **Wrong branch in worktree.** Step 2 rejects fast.
- **Skill not installed.** Step 3 fails cleanly without recording anything.
- **Verdict text is huge.** Truncate the recorded notes to ~2000 chars and
  add a "(verdict truncated; full output in <session transcript>)" note.

## Future: multi-reviewer fan-out

The current command accepts a single `--agent <name>`. The natural
extension is `--agents dg,simplify,pr-review` (or repeated `--agent`),
spawning all named review skills concurrently in a single tool-use turn
and merging the verdicts before recording one QA-N entry.

This is the canonical Theme B pattern for the back half — master
session orchestrates, reviewer subagents run in parallel — and matches
what `/brainstorm` already does for the front half. See the "Subagent
discipline" section in [`docs/architecture.md`](../../docs/architecture.md).
Not implemented yet; filed as a follow-up.
