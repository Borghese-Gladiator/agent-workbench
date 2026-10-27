#!/usr/bin/env bash
#
# qa-pass.sh <run_dir> [-r result] [-t tester] [-s scope] [-n notes]
#
# Append a new QA pass entry to runs/<run_id>/qa-log.md and flip status to "qa".
#
# Defaults:
#   tester  = $(git config user.name) or "unknown"
#   result  = pass-with-followups
#   scope   = "(unspecified)"
#   notes   = "(no findings recorded)"
#
# The QA-N ordinal is auto-computed by counting existing "## QA-" headings.
#
# Notes from stdin: pass `-n -` to read multi-line notes from stdin until EOF.
# Useful for piping verdicts from /review-run without shell-quoting bugs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKBENCH_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${WORKBENCH_ROOT}"

usage() {
  cat <<'EOF' >&2
usage: qa-pass.sh <run_dir> [-r result] [-t tester] [-s scope] [-n notes]

  result   pass | pass-with-followups | fail   (default: pass-with-followups)
  tester   name string                          (default: git config user.name)
  scope    short string of what was tested      (default: "(unspecified)")
  notes    multi-line findings text             (default: "(no findings recorded)")
EOF
  exit 2
}

[[ $# -ge 1 ]] || usage

RUN_DIR_INPUT="$1"; shift
RESULT="pass-with-followups"
TESTER="$(git config user.name 2>/dev/null || echo "unknown")"
SCOPE="(unspecified)"
NOTES="(no findings recorded)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -r) RESULT="${2:?missing value for -r}"; shift 2 ;;
    -t) TESTER="${2:?missing value for -t}"; shift 2 ;;
    -s) SCOPE="${2:?missing value for -s}";  shift 2 ;;
    -n)
      [[ $# -ge 2 ]] || { printf 'error: missing value for -n\n' >&2; exit 2; }
      if [[ "$2" = "-" ]]; then
        NOTES="$(cat)"
      else
        NOTES="$2"
      fi
      shift 2
      ;;
    -h|--help) usage ;;
    *) printf 'error: unknown option %s\n' "$1" >&2; usage ;;
  esac
done

case "${RESULT}" in
  pass|pass-with-followups|fail) ;;
  *) printf 'error: invalid -r %s (use pass | pass-with-followups | fail)\n' "${RESULT}" >&2; exit 2 ;;
esac

fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

RUN_DIR="$(cd "${RUN_DIR_INPUT}" 2>/dev/null && pwd)" \
  || fail "run directory does not exist: ${RUN_DIR_INPUT}"
QA_LOG="${RUN_DIR}/qa-log.md"
[[ -f "${QA_LOG}" ]] || fail "qa-log.md missing in ${RUN_DIR}"

# Compute next QA ordinal.
N=$(grep -cE '^## QA-[0-9]+' "${QA_LOG}" || true)
N=$((N + 1))

# Look up the build-under-test from the worktree, if available. Also
# capture the current status here so we can short-circuit before mutating
# any files when the precondition rejects.
BUILD_INFO=""
META_RAW="$(
  PYTHONPATH="${WORKBENCH_ROOT}" python3 - "${RUN_DIR}" <<'PY' || true
import sys
from pathlib import Path
from lib.metadata import load
md = load(Path(sys.argv[1]))
print(f"{md.branch_name}|{md.worktree_path}|{md.status}")
PY
)"
IFS='|' read -r BRANCH_NAME WORKTREE_PATH RUN_STATUS <<<"${META_RAW}"

# Precondition: qa-pass requires the run to be in implementation/review.
# Reject before we append to qa-log.md or anything else, so a refused call
# leaves no trace behind.
case "${RUN_STATUS}" in
  in_progress|in_review|qa) ;;
  *) fail "qa-pass refused — run status is '${RUN_STATUS}'; expected in_progress, in_review, or qa." ;;
esac
if [[ -n "${WORKTREE_PATH}" && -d "${WORKTREE_PATH}/.git" || -f "${WORKTREE_PATH}/.git" ]]; then
  SHA="$(git -C "${WORKTREE_PATH}" rev-parse --short HEAD 2>/dev/null || echo "(no sha)")"
  BUILD_INFO="${BRANCH_NAME} @ ${SHA}"
else
  BUILD_INFO="${BRANCH_NAME} (worktree not present)"
fi

DATE="$(date -u +%Y-%m-%d)"

# Append the QA entry.
{
  printf '\n## QA-%d — %s\n' "${N}" "${DATE}"
  printf '**Tester:** %s\n' "${TESTER}"
  printf '**Build under test:** %s\n' "${BUILD_INFO}"
  printf '**Scope:** %s\n' "${SCOPE}"
  printf '**Findings:**\n%s\n' "${NOTES}"
  printf '**Result:** %s\n' "${RESULT}"
} >> "${QA_LOG}"

# Status → qa.
PYTHONPATH="${WORKBENCH_ROOT}" python3 - "${RUN_DIR}" "${N}" "${RESULT}" "${TESTER}" "${SCOPE}" "${BUILD_INFO}" <<'PY'
import sys
from pathlib import Path
from lib.metadata import load, save
from lib.transitions import transition_with_evidence, TransitionError
from lib.events import Event, append

run_dir = Path(sys.argv[1])
ordinal, result, tester, scope, build_info = sys.argv[2:7]

md = load(run_dir)
from_state = md.status
# Precondition was already enforced in bash above. When the run is already
# in qa (e.g. a second review pass), skip the transition but still log the
# verdict. Otherwise transition with evidence.
trimmed = {}
transitioned = False
if from_state != "qa":
    evidence = {"review_decision": result}
    try:
        md, trimmed = transition_with_evidence(md, "qa", evidence)
    except TransitionError as exc:
        print(f"ERR:transition rejected — {exc}", file=sys.stderr)
        sys.exit(1)
    transitioned = True
    save(run_dir, md)

try:
    append(run_dir, Event(
        event_type="QAVerdict",
        actor="script:qa-pass.sh",
        payload={
            "ordinal": ordinal,
            "result": result,
            "tester": tester,
            "scope": scope,
            "build_info": build_info,
        },
    ))
    if transitioned:
        append(run_dir, Event(
            event_type="TransitionApplied",
            actor="script:qa-pass.sh",
            from_state=from_state,
            to_state="qa",
            payload=trimmed,
        ))
except Exception as exc:
    print(f"warn: event-log append failed: {exc}", file=sys.stderr)
PY

echo "appended QA-${N} (${RESULT}) to ${QA_LOG}; status → qa"

# Best-effort Beads mirror — surface the qa state.
"${SCRIPT_DIR}/sync-to-beads.sh" "${RUN_DIR}" || true
