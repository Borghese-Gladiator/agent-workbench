#!/usr/bin/env bash
#
# new-feature.sh <repo_key> <feature_slug> "<raw_idea_text>"
#
# Create a new run directory under runs/, populated with templates and a
# rendered metadata.yaml. status starts at "draft".
#
# This script does NOT touch the product repo, does NOT create a worktree,
# and does NOT create a branch. Those happen in create-worktree.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKBENCH_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${WORKBENCH_ROOT}"

usage() {
  cat <<'EOF' >&2
usage: new-feature.sh <repo_key> <feature-slug> "<raw idea text>"

  repo_key       key from config/repos.yaml (e.g. "frontend")
  feature-slug   kebab-case, starts with a letter (e.g. "better-onboarding")
  raw idea       free-form text, written verbatim into raw-idea.md
EOF
  exit 2
}

if [[ $# -ne 3 ]]; then
  usage
fi

REPO_KEY="$1"
FEATURE_SLUG="$2"
RAW_IDEA="$3"

fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# --- Delegate the structured work to Python -----------------------------------
#
# Python handles: config lookup, slug validation, run_id generation, metadata
# writing. Bash handles: shell args, copying templates, and writing the raw idea.

# Look up the product repo entry. Use Python so error messages stay consistent.
REPO_INFO_RAW="$(
  PYTHONPATH="${WORKBENCH_ROOT}" python3 - "${REPO_KEY}" <<'PY'
import sys
from lib.repo_config import get_repo, ConfigError
try:
    entry = get_repo(sys.argv[1])
except ConfigError as exc:
    print(f"ERR:{exc}", file=sys.stderr)
    sys.exit(1)
# Pipe-delimited so bash can split it without YAML re-parsing.
# project_subpath may be empty; the trailing field handles that cleanly.
print(f"{entry.path}|{entry.github}|{entry.default_branch}|{entry.project_subpath}")
PY
)" || fail "repo lookup failed (see message above)"

IFS='|' read -r REPO_PATH GITHUB_REPO DEFAULT_BRANCH PROJECT_SUBPATH <<<"${REPO_INFO_RAW}"

[[ -n "${REPO_PATH}" ]]      || fail "empty repo_path returned for ${REPO_KEY}"
[[ -n "${GITHUB_REPO}" ]]    || fail "empty github_repo returned for ${REPO_KEY}"
[[ -n "${DEFAULT_BRANCH}" ]] || fail "empty default_branch returned for ${REPO_KEY}"

# Generate a unique run_id and create the run dir.
RUN_ID="$(
  PYTHONPATH="${WORKBENCH_ROOT}" python3 - "${FEATURE_SLUG}" <<'PY'
import sys
from lib.metadata import generate_run_id, MetadataError
try:
    print(generate_run_id(sys.argv[1]))
except MetadataError as exc:
    print(f"ERR:{exc}", file=sys.stderr)
    sys.exit(1)
PY
)" || fail "could not generate run_id"

RUN_DIR="${WORKBENCH_ROOT}/runs/${RUN_ID}"

if [[ -e "${RUN_DIR}" ]]; then
  # Should never happen — generate_run_id picks a fresh suffix — but be paranoid.
  fail "run directory already exists: ${RUN_DIR} (refusing to overwrite)"
fi

mkdir -p "${RUN_DIR}"

# Copy markdown templates verbatim. metadata.yaml is rendered, not copied.
TEMPLATES=(
  "raw-idea.md"
  "normalized-feature-input.md"
  "spec.md"
  "run-log.md"
  "decisions.md"
  "qa-log.md"
  "pr-summary.md"
)
for tpl in "${TEMPLATES[@]}"; do
  src="${WORKBENCH_ROOT}/templates/${tpl}"
  [[ -f "${src}" ]] || fail "missing template: ${src}"
  cp "${src}" "${RUN_DIR}/${tpl}"
done

# Append the raw idea to raw-idea.md so the user's words are preserved exactly.
{
  printf '\n---\n\n## Captured at run-creation time\n\n'
  printf '%s\n' "${RAW_IDEA}"
} >> "${RUN_DIR}/raw-idea.md"

# Render metadata.yaml.
PYTHONPATH="${WORKBENCH_ROOT}" python3 - <<PY
from pathlib import Path
from lib.metadata import new_metadata, save

run_dir = Path("${RUN_DIR}")
md = new_metadata(
    run_id="${RUN_ID}",
    feature_slug="${FEATURE_SLUG}",
    repo_key="${REPO_KEY}",
    repo_path="${REPO_PATH}",
    project_subpath="${PROJECT_SUBPATH}",
    github_repo="${GITHUB_REPO}",
    default_branch="${DEFAULT_BRANCH}",
)
save(run_dir, md, touch_updated_at=False)
PY

# Event-log emit. Best-effort: a failure here must not block run creation.
PYTHONPATH="${WORKBENCH_ROOT}" python3 - "${RUN_DIR}" "${REPO_KEY}" "${FEATURE_SLUG}" "${RUN_ID}" <<'PY' \
  || echo "warn: event-log append failed for ${RUN_DIR}" >&2
import sys
from pathlib import Path
from lib.events import Event, append

run_dir = Path(sys.argv[1])
append(run_dir, Event(
    event_type="TaskCreated",
    actor="script:new-feature.sh",
    to_state="draft",
    payload={
        "repo_key": sys.argv[2],
        "feature_slug": sys.argv[3],
        "run_id": sys.argv[4],
    },
))
PY

if [[ -n "${PROJECT_SUBPATH}" ]]; then
  PROJECT_LINE="  project_dir: ${REPO_PATH}/${PROJECT_SUBPATH} (subdir of git root)"
else
  PROJECT_LINE="  project_dir: ${REPO_PATH} (== git root)"
fi

cat <<EOF
created run: ${RUN_ID}
  path:        ${RUN_DIR}
  repo_key:    ${REPO_KEY}
  repo_path:   ${REPO_PATH}
${PROJECT_LINE}
  branch (planned): ai/${RUN_ID}
  status:      draft

Next steps:
  1. Edit ${RUN_DIR}/normalized-feature-input.md and ${RUN_DIR}/spec.md.
  2. Flip status to "planned" in metadata.yaml when the spec is approved.
  3. ./scripts/create-worktree.sh runs/${RUN_ID}
EOF

# Best-effort Beads mirror. Never block run creation on Beads.
# Skip when invoked from spawn-children.sh — that script handles sync after
# patching parent_run_id, so the bead is created with the correct parent link
# in a single step.
if [[ "${WORKBENCH_SKIP_BEADS_SYNC:-0}" != "1" ]]; then
  "${SCRIPT_DIR}/sync-to-beads.sh" "${RUN_DIR}" || true
fi
