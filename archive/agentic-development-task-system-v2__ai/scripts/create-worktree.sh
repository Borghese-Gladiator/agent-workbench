#!/usr/bin/env bash
#
# create-worktree.sh <run_dir>
#
# Create a git worktree + feature branch for the run described by <run_dir>.
#
# Safe re-runs:
#   - If the worktree already exists at the expected path AND points at the
#     expected branch, succeed without touching anything.
#   - If the branch already exists in the product repo but no worktree is
#     attached, create a worktree from that branch (don't reset it).
#   - Refuse to overwrite a worktree at the expected path that points elsewhere.
#   - Refuse to create a branch that already exists at a different SHA than the
#     default branch's tip — the user must investigate.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKBENCH_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${WORKBENCH_ROOT}"

usage() {
  cat <<'EOF' >&2
usage: create-worktree.sh <run_dir>

  run_dir   path to a run directory (e.g. runs/2026-05-06-better-onboarding-001)
EOF
  exit 2
}

[[ $# -eq 1 ]] || usage

RUN_DIR_INPUT="$1"
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Normalize to absolute path.
RUN_DIR="$(cd "${RUN_DIR_INPUT}" 2>/dev/null && pwd)" \
  || fail "run directory does not exist: ${RUN_DIR_INPUT}"

[[ -f "${RUN_DIR}/metadata.yaml" ]] \
  || fail "metadata.yaml missing in run directory: ${RUN_DIR}"

# Read all the fields we need in one Python call to keep error handling tight.
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
required = ("run_id", "repo_path", "default_branch", "branch_name")
missing = [f for f in required if not getattr(md, f)]
if missing:
    print(f"ERR:metadata is missing field(s): {', '.join(missing)}", file=sys.stderr)
    sys.exit(1)
print(f"{md.run_id}|{md.repo_path}|{md.default_branch}|{md.branch_name}|{md.status}|{md.project_subpath}")
PY
)" || fail "failed to load metadata"

IFS='|' read -r RUN_ID REPO_PATH DEFAULT_BRANCH BRANCH_NAME STATUS PROJECT_SUBPATH <<<"${META_RAW}"

WORKTREE_PATH="${WORKBENCH_ROOT}/worktrees/${RUN_ID}"

# --- Validate product repo ----------------------------------------------------

[[ -d "${REPO_PATH}" ]]              || fail "repo path does not exist: ${REPO_PATH}"
[[ -e "${REPO_PATH}/.git" ]]         || fail "not a git repo: ${REPO_PATH}"

git -C "${REPO_PATH}" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || fail "git refuses to recognize ${REPO_PATH} as a working tree"

# Ensure the configured default branch actually exists in the product repo.
if ! git -C "${REPO_PATH}" show-ref --verify --quiet "refs/heads/${DEFAULT_BRANCH}"; then
  fail "default branch '${DEFAULT_BRANCH}' does not exist in ${REPO_PATH}"
fi

DEFAULT_TIP="$(git -C "${REPO_PATH}" rev-parse "refs/heads/${DEFAULT_BRANCH}")"

# --- Existing-state handling --------------------------------------------------

# Does the worktree path already exist?
if [[ -e "${WORKTREE_PATH}" ]]; then
  # Is it a registered worktree of the product repo?
  if git -C "${REPO_PATH}" worktree list --porcelain \
        | awk '/^worktree /{print $2}' \
        | grep -Fxq "${WORKTREE_PATH}"; then
    EXISTING_BRANCH="$(git -C "${WORKTREE_PATH}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
    if [[ "${EXISTING_BRANCH}" == "${BRANCH_NAME}" ]]; then
      echo "worktree already in place: ${WORKTREE_PATH} (branch ${BRANCH_NAME})"
      # Make sure metadata reflects reality even if a prior run died mid-way.
      # Emit an event iff this catch-up actually transitions the run.
      PYTHONPATH="${WORKBENCH_ROOT}" python3 - "${RUN_DIR}" "${WORKTREE_PATH}" "${BRANCH_NAME}" "${DEFAULT_BRANCH}" "${DEFAULT_TIP}" <<'PY' \
        || echo "warn: idempotent metadata sync failed for ${RUN_DIR}" >&2
import sys
from pathlib import Path
from lib.metadata import load, save
from lib.transitions import transition_with_evidence
from lib.events import Event, append
run_dir = Path(sys.argv[1])
worktree, branch_name, default_branch, default_tip = sys.argv[2:6]
md = load(run_dir)
from_state = md.status
trimmed = {}
transitioned = False
if md.worktree_path != worktree or md.status not in ("in_progress", "in_review", "qa"):
    md.worktree_path = worktree
    if md.status in ("draft", "planned", "ready"):
        evidence = {"worktree_path": worktree, "branch_name": branch_name}
        md, trimmed = transition_with_evidence(md, "in_progress", evidence)
        transitioned = True
    save(run_dir, md)
if transitioned:
    try:
        append(run_dir, Event(
            event_type="TransitionApplied",
            actor="script:create-worktree.sh",
            from_state=from_state,
            to_state="in_progress",
            payload={
                **trimmed,
                "default_branch": default_branch,
                "base_sha": default_tip,
                "note": "idempotent re-attach",
            },
        ))
    except Exception as exc:
        print(f"warn: event-log append failed: {exc}", file=sys.stderr)
PY
      exit 0
    fi
    fail "worktree path ${WORKTREE_PATH} exists but is on branch ${EXISTING_BRANCH}, not ${BRANCH_NAME}"
  fi
  fail "worktree path ${WORKTREE_PATH} exists but is not a registered git worktree; refusing to overwrite"
fi

# Does the branch already exist in the product repo?
BRANCH_EXISTS=0
if git -C "${REPO_PATH}" show-ref --verify --quiet "refs/heads/${BRANCH_NAME}"; then
  BRANCH_EXISTS=1
fi

mkdir -p "${WORKBENCH_ROOT}/worktrees"

# --- Create the worktree ------------------------------------------------------

if [[ "${BRANCH_EXISTS}" -eq 1 ]]; then
  echo "branch ${BRANCH_NAME} already exists; attaching worktree to existing branch"
  git -C "${REPO_PATH}" worktree add "${WORKTREE_PATH}" "${BRANCH_NAME}" \
    || fail "git worktree add failed"
else
  echo "creating worktree ${WORKTREE_PATH} on new branch ${BRANCH_NAME} from ${DEFAULT_BRANCH} (${DEFAULT_TIP:0:12})"
  git -C "${REPO_PATH}" worktree add -b "${BRANCH_NAME}" "${WORKTREE_PATH}" "refs/heads/${DEFAULT_BRANCH}" \
    || fail "git worktree add -b failed"
fi

# --- Update metadata ----------------------------------------------------------

PYTHONPATH="${WORKBENCH_ROOT}" python3 - "${RUN_DIR}" "${WORKTREE_PATH}" "${BRANCH_NAME}" "${DEFAULT_BRANCH}" "${DEFAULT_TIP}" <<'PY'
import sys
from pathlib import Path
from lib.metadata import load, save
from lib.transitions import transition_with_evidence
from lib.events import Event, append

run_dir = Path(sys.argv[1])
worktree, branch_name, default_branch, default_tip = sys.argv[2:6]

md = load(run_dir)
from_state = md.status
md.worktree_path = worktree
# Move into in_progress regardless of whether we were in draft, planned, or
# ready. transition_with_evidence enforces that the front half supplied the
# right shape; the evidence keys are the same across all three legal `from`
# states (see lib/transitions.py:EVIDENCE).
trimmed = {}
transitioned = False
if md.status in ("draft", "planned", "ready"):
    evidence = {"worktree_path": worktree, "branch_name": branch_name}
    md, trimmed = transition_with_evidence(md, "in_progress", evidence)
    transitioned = True
save(run_dir, md)

if transitioned:
    try:
        append(run_dir, Event(
            event_type="TransitionApplied",
            actor="script:create-worktree.sh",
            from_state=from_state,
            to_state="in_progress",
            payload={
                **trimmed,
                "default_branch": default_branch,
                "base_sha": default_tip,
            },
        ))
    except Exception as exc:
        print(f"warn: event-log append failed: {exc}", file=sys.stderr)
PY

if [[ -n "${PROJECT_SUBPATH}" ]]; then
  PROJECT_DIR_LINE="  project dir:   ${WORKTREE_PATH}/${PROJECT_SUBPATH} (subdir of worktree)"
  CD_TARGET="${WORKTREE_PATH}/${PROJECT_SUBPATH}"
else
  PROJECT_DIR_LINE="  project dir:   ${WORKTREE_PATH} (== worktree)"
  CD_TARGET="${WORKTREE_PATH}"
fi

cat <<EOF
worktree ready.
  run_id:        ${RUN_ID}
  worktree:      ${WORKTREE_PATH}
${PROJECT_DIR_LINE}
  branch:        ${BRANCH_NAME}
  base:          ${DEFAULT_BRANCH} (${DEFAULT_TIP:0:12})
  product repo:  ${REPO_PATH}
  status:        in_progress

cd ${CD_TARGET}   # to start implementing
EOF

# Best-effort Beads mirror — surface in_progress to Beads.
"${SCRIPT_DIR}/sync-to-beads.sh" "${RUN_DIR}" || true
