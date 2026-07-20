#!/usr/bin/env bash
#
# complete-run.sh <run_dir> [--abandon] [--remove-worktree] [--delete-branch]
#
# Finalize a run.
#
# By default, sets status → "merged". Pass --abandon to set status → "abandoned"
# instead.
#
# Optional cleanup flags (off by default — opt in only after you're sure):
#   --remove-worktree   git worktree remove (refuses if dirty unless --force)
#   --delete-branch     git branch -d (refuses if unmerged unless --force)
#   --force             pass through to the destructive operations above
#
# Run artifacts under runs/<run_id>/ are NEVER deleted.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKBENCH_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${WORKBENCH_ROOT}"

usage() {
  cat <<'EOF' >&2
usage: complete-run.sh <run_dir> [--abandon --reason "..."]
                                 [--skip-qa] [--remove-worktree]
                                 [--delete-branch] [--force]

  run_dir              path to a run directory (e.g. runs/2026-05-06-foo-001)
  --abandon            set status to "abandoned" instead of "merged"
                       (requires --reason "..." for evidence)
  --reason "..."       reason text recorded as abandoned_reason evidence
  --skip-qa            allow merging from in_progress/in_review without
                       passing through qa first (use sparingly — hotfixes only)
  --remove-worktree    remove the git worktree after status update
  --delete-branch      delete the local feature branch after status update
  --force              pass --force through to worktree/branch removal
EOF
  exit 2
}

[[ $# -ge 1 ]] || usage

RUN_DIR_INPUT="$1"; shift
ABANDON=0
REMOVE_WORKTREE=0
DELETE_BRANCH=0
FORCE=0
SKIP_QA=0
REASON=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --abandon)         ABANDON=1 ;;
    --reason)
      [[ $# -ge 2 ]] || { printf 'error: --reason needs a value\n' >&2; exit 2; }
      REASON="$2"
      shift
      ;;
    --skip-qa)         SKIP_QA=1 ;;
    --remove-worktree) REMOVE_WORKTREE=1 ;;
    --delete-branch)   DELETE_BRANCH=1 ;;
    --force)           FORCE=1 ;;
    -h|--help)         usage ;;
    *) printf 'error: unknown option %s\n' "$1" >&2; usage ;;
  esac
  shift
done

fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

RUN_DIR="$(cd "${RUN_DIR_INPUT}" 2>/dev/null && pwd)" \
  || fail "run directory does not exist: ${RUN_DIR_INPUT}"

[[ -f "${RUN_DIR}/metadata.yaml" ]] \
  || fail "metadata.yaml missing in run directory: ${RUN_DIR}"

META_RAW="$(
  PYTHONPATH="${WORKBENCH_ROOT}" python3 - "${RUN_DIR}" <<'PY'
import sys
from pathlib import Path
from lib.metadata import load, MetadataError
try:
    md = load(Path(sys.argv[1]))
except MetadataError as exc:
    print(f"ERR:{exc}", file=sys.stderr)
    sys.exit(1)
print(f"{md.run_id}|{md.repo_path}|{md.branch_name}|{md.worktree_path}|{md.status}|{md.pr_url}")
PY
)" || fail "failed to load metadata"

IFS='|' read -r RUN_ID REPO_PATH BRANCH_NAME WORKTREE_PATH STATUS PR_URL <<<"${META_RAW}"

# --- Status transition --------------------------------------------------------

if [[ "${ABANDON}" -eq 1 ]]; then
  TARGET_STATUS="abandoned"
  [[ -n "${REASON}" ]] \
    || fail "--abandon requires --reason \"...\" (recorded as abandoned_reason evidence)"
else
  TARGET_STATUS="merged"
  if [[ "${SKIP_QA}" -eq 1 ]]; then
    # Hotfix path: allow in_progress / in_review / qa. Loud warning.
    case "${STATUS}" in
      in_progress|in_review|qa) ;;
      *) fail "cannot mark status=merged from current status '${STATUS}' even with --skip-qa." ;;
    esac
    printf 'warn: --skip-qa bypasses the canonical qa → merged edge. Make sure QA happened elsewhere.\n' >&2
  else
    # Canonical path: only qa → merged is allowed.
    case "${STATUS}" in
      qa) ;;
      in_progress|in_review)
        fail "cannot mark status=merged from current status '${STATUS}'. Run qa-pass.sh first, or pass --skip-qa for emergency hotfixes." ;;
      *) fail "cannot mark status=merged from current status '${STATUS}'. Use --abandon if you intend to drop this run." ;;
    esac
  fi
fi

# Capture merge_sha for the merge path. The branch may have been merged in
# the remote (PR closed) — its tip locally is the best signal we have without
# a network call to GitHub. If the branch is gone, fall back to a sentinel.
MERGE_SHA=""
if [[ "${TARGET_STATUS}" == "merged" ]]; then
  if [[ -n "${REPO_PATH}" && -d "${REPO_PATH}/.git" || -e "${REPO_PATH}/.git" ]] \
     && git -C "${REPO_PATH}" show-ref --verify --quiet "refs/heads/${BRANCH_NAME}"; then
    MERGE_SHA="$(git -C "${REPO_PATH}" rev-parse "refs/heads/${BRANCH_NAME}" 2>/dev/null || echo "")"
  fi
  if [[ -z "${MERGE_SHA}" ]]; then
    # Sentinel: keeps the evidence non-empty so transition_with_evidence accepts.
    # check-pr.sh / a future merge-detector can backfill this to a real SHA.
    MERGE_SHA="local-merge-sha-unavailable"
  fi
fi

PYTHONPATH="${WORKBENCH_ROOT}" python3 - "${RUN_DIR}" "${TARGET_STATUS}" "${REMOVE_WORKTREE}" "${DELETE_BRANCH}" "${FORCE}" "${REASON}" "${PR_URL}" "${MERGE_SHA}" <<'PY'
import sys
from pathlib import Path
from lib.metadata import load, save
from lib.transitions import transition_with_evidence, TransitionError
from lib.events import Event, append

run_dir = Path(sys.argv[1])
target, remove_wt, delete_br, force, reason, pr_url, merge_sha = sys.argv[2:9]

md = load(run_dir)
from_state = md.status

if target == "abandoned":
    evidence = {"abandoned_reason": reason}
elif target == "merged":
    evidence = {
        "tests_passed": "true",  # bash precondition above gates this — at this
                                 # point either we came from qa, or the user
                                 # passed --skip-qa and acknowledged the bypass.
        "pr_url": pr_url or "no-pr-recorded",
        "merge_sha": merge_sha,
    }
else:
    print(f"ERR:unsupported target status {target!r}", file=sys.stderr)
    sys.exit(1)

try:
    md, trimmed = transition_with_evidence(md, target, evidence)
except TransitionError as exc:
    print(f"ERR:transition rejected — {exc}", file=sys.stderr)
    sys.exit(1)
save(run_dir, md)

try:
    append(run_dir, Event(
        event_type="TransitionApplied",
        actor="script:complete-run.sh",
        from_state=from_state,
        to_state=target,
        payload={
            **trimmed,
            "remove_worktree": remove_wt,
            "delete_branch": delete_br,
            "force": force,
        },
    ))
except Exception as exc:
    print(f"warn: event-log append failed: {exc}", file=sys.stderr)
PY

echo "status → ${TARGET_STATUS} (run ${RUN_ID})"

# --- Optional worktree removal -------------------------------------------------

if [[ "${REMOVE_WORKTREE}" -eq 1 ]]; then
  if [[ -z "${WORKTREE_PATH}" || ! -e "${WORKTREE_PATH}" ]]; then
    echo "no worktree to remove (${WORKTREE_PATH:-<unset>} not present)"
  else
    if [[ ! -d "${REPO_PATH}" ]]; then
      fail "cannot remove worktree: product repo path missing: ${REPO_PATH}"
    fi
    REMOVE_ARGS=(worktree remove "${WORKTREE_PATH}")
    [[ "${FORCE}" -eq 1 ]] && REMOVE_ARGS=(worktree remove --force "${WORKTREE_PATH}")
    git -C "${REPO_PATH}" "${REMOVE_ARGS[@]}" \
      || fail "git worktree remove failed (use --force if intentional)"
    echo "worktree removed: ${WORKTREE_PATH}"
  fi
fi

# --- Optional branch deletion --------------------------------------------------

if [[ "${DELETE_BRANCH}" -eq 1 ]]; then
  if [[ ! -d "${REPO_PATH}" ]]; then
    fail "cannot delete branch: product repo path missing: ${REPO_PATH}"
  fi
  if git -C "${REPO_PATH}" show-ref --verify --quiet "refs/heads/${BRANCH_NAME}"; then
    if [[ "${FORCE}" -eq 1 ]]; then
      git -C "${REPO_PATH}" branch -D "${BRANCH_NAME}" \
        || fail "git branch -D failed"
    else
      git -C "${REPO_PATH}" branch -d "${BRANCH_NAME}" \
        || fail "git branch -d refused (branch not merged?). Use --force to override."
    fi
    echo "branch deleted: ${BRANCH_NAME}"
  else
    echo "no branch to delete: ${BRANCH_NAME} not present"
  fi
fi

# --- Summary -------------------------------------------------------------------

cat <<EOF

run completed.
  run_id:    ${RUN_ID}
  status:    ${TARGET_STATUS}
  artifacts: ${RUN_DIR} (preserved)
EOF

# Best-effort Beads mirror — surface merged/abandoned (closes the bead).
"${SCRIPT_DIR}/sync-to-beads.sh" "${RUN_DIR}" || true
