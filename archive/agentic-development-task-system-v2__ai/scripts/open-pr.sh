#!/usr/bin/env bash
#
# open-pr.sh <run_dir> [--remote NAME] [--no-push]
#
# Push the feature branch to the configured remote and create a draft PR via
# `gh`. Updates metadata.yaml with pr_url + pr_number, prepends a "PR opened"
# header to pr-summary.md, and transitions status to in_review.
#
# Idempotent: if metadata already has pr_url, we re-print it and exit 0
# without re-pushing or re-creating.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKBENCH_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${WORKBENCH_ROOT}"

usage() {
  cat <<'EOF' >&2
usage: open-pr.sh <run_dir> [--remote NAME] [--no-push]

  --remote NAME   override the metadata-configured remote (default: from metadata)
  --no-push       skip `git push`; only run `gh pr create` (assumes branch already pushed)
EOF
  exit 2
}

[[ $# -ge 1 ]] || usage

RUN_DIR_INPUT="$1"; shift
REMOTE_OVERRIDE=""
DO_PUSH=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote)   REMOTE_OVERRIDE="${2:?missing value for --remote}"; shift 2 ;;
    --no-push)  DO_PUSH=0; shift ;;
    -h|--help)  usage ;;
    *) printf 'error: unknown option %s\n' "$1" >&2; usage ;;
  esac
done

fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# --- Tooling preflight --------------------------------------------------------

command -v gh >/dev/null 2>&1 \
  || fail "gh (GitHub CLI) is not installed. Install it from https://cli.github.com/ and run 'gh auth login'."

if ! gh auth status >/dev/null 2>&1; then
  fail "gh is installed but not authenticated. Run: gh auth login"
fi

# --- Load metadata ------------------------------------------------------------

RUN_DIR="$(cd "${RUN_DIR_INPUT}" 2>/dev/null && pwd)" \
  || fail "run directory does not exist: ${RUN_DIR_INPUT}"

[[ -f "${RUN_DIR}/metadata.yaml" ]] || fail "metadata.yaml missing in ${RUN_DIR}"

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
required = ("run_id", "repo_path", "github_repo", "default_branch", "branch_name", "worktree_path")
missing = [f for f in required if not getattr(md, f)]
if missing:
    print(f"ERR:metadata is missing field(s): {', '.join(missing)}. Run create-worktree.sh first.", file=sys.stderr)
    sys.exit(1)
remote = md.remote_name or "origin"
print(f"{md.run_id}|{md.repo_path}|{md.github_repo}|{md.default_branch}|{md.branch_name}|{md.worktree_path}|{md.status}|{md.pr_url}|{md.pr_number}|{remote}")
PY
)" || fail "failed to load metadata"

IFS='|' read -r RUN_ID REPO_PATH GITHUB_REPO DEFAULT_BRANCH BRANCH_NAME WORKTREE_PATH STATUS EXISTING_PR_URL EXISTING_PR_NUMBER REMOTE_NAME <<<"${META_RAW}"

if [[ -n "${REMOTE_OVERRIDE}" ]]; then
  REMOTE_NAME="${REMOTE_OVERRIDE}"
fi

# --- Idempotency: already opened? --------------------------------------------

if [[ -n "${EXISTING_PR_URL}" ]]; then
  cat <<EOF
PR already opened for this run.
  pr_url:    ${EXISTING_PR_URL}
  pr_number: ${EXISTING_PR_NUMBER}
  status:    ${STATUS}

(Use scripts/check-pr.sh to refresh CI status, or edit metadata.yaml to clear
 pr_url if you really want to open another PR.)
EOF
  exit 0
fi

# --- Worktree + branch sanity -------------------------------------------------

[[ -d "${WORKTREE_PATH}" ]] || fail "worktree does not exist: ${WORKTREE_PATH} (run create-worktree.sh)"

CURRENT_BRANCH="$(git -C "${WORKTREE_PATH}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
if [[ "${CURRENT_BRANCH}" != "${BRANCH_NAME}" ]]; then
  fail "worktree is on branch '${CURRENT_BRANCH}', expected '${BRANCH_NAME}'"
fi

# Has the feature branch diverged from default at all?
if ! git -C "${REPO_PATH}" show-ref --verify --quiet "refs/heads/${BRANCH_NAME}"; then
  fail "branch ${BRANCH_NAME} does not exist in product repo ${REPO_PATH}"
fi
if ! git -C "${REPO_PATH}" show-ref --verify --quiet "refs/heads/${DEFAULT_BRANCH}"; then
  fail "default branch ${DEFAULT_BRANCH} not found in product repo ${REPO_PATH}"
fi

AHEAD_COUNT="$(git -C "${REPO_PATH}" rev-list --count "${DEFAULT_BRANCH}..${BRANCH_NAME}" || echo 0)"
if [[ "${AHEAD_COUNT}" -eq 0 ]]; then
  fail "branch ${BRANCH_NAME} has no commits ahead of ${DEFAULT_BRANCH}; nothing to open a PR for"
fi
echo "branch is ${AHEAD_COUNT} commit(s) ahead of ${DEFAULT_BRANCH}"

# --- Remote check -------------------------------------------------------------

if ! git -C "${REPO_PATH}" remote get-url "${REMOTE_NAME}" >/dev/null 2>&1; then
  fail "remote '${REMOTE_NAME}' is not configured on ${REPO_PATH}. Add it with: git -C ${REPO_PATH} remote add ${REMOTE_NAME} <url>"
fi

# --- Push ---------------------------------------------------------------------

if [[ "${DO_PUSH}" -eq 1 ]]; then
  echo "pushing ${BRANCH_NAME} to ${REMOTE_NAME}..."
  # -u sets upstream so future fetches/pulls Just Work for the user.
  git -C "${REPO_PATH}" push -u "${REMOTE_NAME}" "${BRANCH_NAME}" \
    || fail "git push failed; check the remote, credentials, and branch protection settings"
else
  echo "--no-push given; assuming ${BRANCH_NAME} is already on ${REMOTE_NAME}"
fi

# --- PR title + body ----------------------------------------------------------

# Pull a sensible default title from pr-summary.md if it has been customized.
DEFAULT_TITLE="ai/${RUN_ID}: ${RUN_ID#*-*-*-}"   # falls back to run_id minus the date prefix
PR_BODY_FILE="${RUN_DIR}/pr-summary.md"
[[ -f "${PR_BODY_FILE}" ]] || fail "pr-summary.md missing in ${RUN_DIR}"

# --- Create draft PR ----------------------------------------------------------

echo "creating draft PR via gh against ${GITHUB_REPO}..."
GH_OUTPUT="$(
  gh pr create \
    --repo "${GITHUB_REPO}" \
    --base "${DEFAULT_BRANCH}" \
    --head "${BRANCH_NAME}" \
    --title "${DEFAULT_TITLE}" \
    --body-file "${PR_BODY_FILE}" \
    --draft \
    2>&1
)" || {
  printf '%s\n' "${GH_OUTPUT}" >&2
  fail "gh pr create failed (see message above)"
}

# `gh pr create` prints the PR URL on its own line. Grab the first https://... URL.
PR_URL="$(printf '%s\n' "${GH_OUTPUT}" | grep -oE 'https://github\.com/[^[:space:]]+' | head -n 1)"
[[ -n "${PR_URL}" ]] || fail "could not parse PR URL from gh output: ${GH_OUTPUT}"

# Strip a trailing slash if present, then take the trailing path component as the PR number.
PR_NUMBER="$(basename "${PR_URL%/}")"
if ! [[ "${PR_NUMBER}" =~ ^[0-9]+$ ]]; then
  fail "could not parse PR number from URL: ${PR_URL}"
fi

# --- Persist to metadata ------------------------------------------------------

PYTHONPATH="${WORKBENCH_ROOT}" python3 - "${RUN_DIR}" "${PR_URL}" "${PR_NUMBER}" "${REMOTE_NAME}" <<'PY'
import sys
from pathlib import Path
from lib.metadata import load, save
from lib.transitions import transition_with_evidence, TransitionError
from lib.events import Event, append

run_dir = Path(sys.argv[1])
pr_url, pr_number, remote_name = sys.argv[2], sys.argv[3], sys.argv[4]

md = load(run_dir)
from_state = md.status
md.pr_url = pr_url
md.pr_number = pr_number
md.remote_name = remote_name
trimmed = {}
transitioned = False
# Legal `from` states for in_review: in_progress (no pre-PR review) or qa
# (pre-PR review already passed). Anything else stays put — open-pr.sh's
# preflight already caught merged/abandoned, but be belt-and-braces.
if md.status in ("in_progress", "qa"):
    evidence = {"pr_url": pr_url}
    md, trimmed = transition_with_evidence(md, "in_review", evidence)
    transitioned = True
save(run_dir, md)

try:
    append(run_dir, Event(
        event_type="PROpened",
        actor="script:open-pr.sh",
        payload={
            "pr_url": pr_url,
            "pr_number": pr_number,
            "remote_name": remote_name,
        },
    ))
    if transitioned:
        append(run_dir, Event(
            event_type="TransitionApplied",
            actor="script:open-pr.sh",
            from_state=from_state,
            to_state="in_review",
            payload=trimmed,
        ))
except Exception as exc:
    print(f"warn: event-log append failed: {exc}", file=sys.stderr)
PY

# --- Update pr-summary.md with the PR pointer ---------------------------------

# Prepend a small banner so the file reflects the live PR. Skip if already present.
if ! grep -q "<!-- pr-opened-banner -->" "${PR_BODY_FILE}"; then
  TMP_BODY="$(mktemp)"
  {
    printf '<!-- pr-opened-banner -->\n'
    printf '> **PR:** %s — opened as draft on %s\n\n' "${PR_URL}" "$(date -u +%Y-%m-%d)"
    cat "${PR_BODY_FILE}"
  } > "${TMP_BODY}"
  mv "${TMP_BODY}" "${PR_BODY_FILE}"
fi

cat <<EOF

draft PR opened.
  pr_url:    ${PR_URL}
  pr_number: ${PR_NUMBER}
  status:    in_review

Next: scripts/check-pr.sh ${RUN_DIR_INPUT}   # refresh CI + review status
EOF

# Best-effort Beads mirror — surface in_review.
"${SCRIPT_DIR}/sync-to-beads.sh" "${RUN_DIR}" || true
