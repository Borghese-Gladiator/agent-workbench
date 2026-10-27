#!/usr/bin/env bash
#
# spawn-children.sh <parent_run_dir>
#
# Read the WBS block from <parent>/decisions.md and create one child run per
# entry. Each child:
#   - is created via new-feature.sh (reuses its run_id generation + validation)
#   - inherits linear_ticket from the parent
#   - has parent_run_id set
#   - has run_type=feature
#
# After all children spawn, transitions the parent: investigating -> investigated.
#
# Idempotency: refuses if the parent is already investigated. To re-spawn, the
# user must manually flip status back to "investigating" and clean up the
# previously spawned children.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKBENCH_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${WORKBENCH_ROOT}"

usage() {
  cat <<'EOF' >&2
usage: spawn-children.sh <parent_run_dir>

  parent_run_dir   path to the investigation run directory whose decisions.md
                   contains the '## WBS — children to spawn' block.
EOF
  exit 2
}

if [[ $# -ne 1 ]]; then
  usage
fi

PARENT_RUN_DIR_INPUT="$1"

fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Resolve to absolute path; allow callers to pass either an absolute path or
# a path relative to the workbench root.
if [[ "${PARENT_RUN_DIR_INPUT}" = /* ]]; then
  PARENT_RUN_DIR="${PARENT_RUN_DIR_INPUT}"
else
  PARENT_RUN_DIR="${WORKBENCH_ROOT}/${PARENT_RUN_DIR_INPUT}"
fi

[[ -d "${PARENT_RUN_DIR}" ]] || fail "parent run dir not found: ${PARENT_RUN_DIR}"
[[ -f "${PARENT_RUN_DIR}/metadata.yaml" ]] \
  || fail "parent has no metadata.yaml: ${PARENT_RUN_DIR}"
[[ -f "${PARENT_RUN_DIR}/decisions.md" ]] \
  || fail "parent has no decisions.md: ${PARENT_RUN_DIR}"

# --- Load + validate the parent ----------------------------------------------
PARENT_INFO_RAW="$(
  PYTHONPATH="${WORKBENCH_ROOT}" python3 - "${PARENT_RUN_DIR}" <<'PY'
import sys
from pathlib import Path
from lib.metadata import load, MetadataError

run_dir = Path(sys.argv[1])
try:
    md = load(run_dir)
except MetadataError as exc:
    print(f"ERR:{exc}", file=sys.stderr)
    sys.exit(1)

if md.run_type != "investigation":
    print(f"ERR:parent run_type must be 'investigation', got {md.run_type!r}", file=sys.stderr)
    sys.exit(1)

if md.status == "investigated":
    print(
        "ERR:parent is already 'investigated' — refusing to re-spawn. "
        "To re-spawn, manually revert status to 'investigating' and remove or "
        "rename the existing children.",
        file=sys.stderr,
    )
    sys.exit(1)

if md.status != "investigating":
    print(
        f"ERR:parent status must be 'investigating' to spawn children, got {md.status!r}",
        file=sys.stderr,
    )
    sys.exit(1)

print(f"{md.run_id}|{md.linear_ticket}")
PY
)" || fail "parent metadata invalid (see message above)"

IFS='|' read -r PARENT_RUN_ID PARENT_LINEAR <<<"${PARENT_INFO_RAW}"

[[ -n "${PARENT_RUN_ID}" ]] || fail "parent run_id missing"

# --- Parse the WBS block ------------------------------------------------------
# Output format: one child per line, "<slug>|<repo_key>|<summary>"
WBS_RAW="$(
  PYTHONPATH="${WORKBENCH_ROOT}" python3 - "${PARENT_RUN_DIR}/decisions.md" <<'PY'
import sys
from pathlib import Path
from lib.wbs import parse, WbsError

try:
    items = parse(Path(sys.argv[1]))
except WbsError as exc:
    print(f"ERR:{exc}", file=sys.stderr)
    sys.exit(1)
for it in items:
    # `|` is forbidden in slug (regex) and unlikely in repo_key (config-validated);
    # summaries are user-authored. Reject summaries containing `|` to keep the
    # shell pipeline trivial.
    if "|" in it.summary:
        print(f"ERR:summary for slug={it.slug!r} contains '|' (not allowed)", file=sys.stderr)
        sys.exit(1)
    print(f"{it.slug}|{it.repo_key}|{it.summary}")
PY
)" || fail "WBS block invalid (see message above)"

[[ -n "${WBS_RAW}" ]] || fail "no children parsed from WBS block"

# --- Spawn each child ---------------------------------------------------------
declare -a SPAWNED_RUN_IDS=()

while IFS= read -r line; do
  [[ -z "${line}" ]] && continue
  IFS='|' read -r CHILD_SLUG CHILD_REPO_KEY CHILD_SUMMARY <<<"${line}"
  [[ -n "${CHILD_SLUG}" ]] || fail "malformed WBS line (empty slug): ${line}"
  [[ -n "${CHILD_REPO_KEY}" ]] || fail "malformed WBS line (empty repo_key): ${line}"

  # Reuse new-feature.sh for run_id generation, dir creation, and template
  # copying. Pass the WBS summary as the raw-idea seed; if empty, use a
  # placeholder pointing at the parent.
  RAW_IDEA="${CHILD_SUMMARY}"
  if [[ -z "${RAW_IDEA}" ]]; then
    RAW_IDEA="(spawned from investigation ${PARENT_RUN_ID}; see parent's decisions.md)"
  fi

  printf '\n--- spawning child slug=%s repo_key=%s ---\n' \
    "${CHILD_SLUG}" "${CHILD_REPO_KEY}"

  # Capture the child's run_id from new-feature.sh's stdout. We suppress the
  # initial Beads sync — we'll do it ourselves after patching parent_run_id
  # so the bead is created with the correct parent in a single step.
  NEW_FEATURE_OUT="$(
    WORKBENCH_SKIP_BEADS_SYNC=1 "${SCRIPT_DIR}/new-feature.sh" "${CHILD_REPO_KEY}" "${CHILD_SLUG}" "${RAW_IDEA}"
  )" || fail "new-feature.sh failed for slug=${CHILD_SLUG}"

  printf '%s\n' "${NEW_FEATURE_OUT}"

  CHILD_RUN_ID="$(printf '%s\n' "${NEW_FEATURE_OUT}" | sed -n 's/^created run: //p')"
  [[ -n "${CHILD_RUN_ID}" ]] \
    || fail "could not parse child run_id from new-feature.sh output"

  CHILD_RUN_DIR="${WORKBENCH_ROOT}/runs/${CHILD_RUN_ID}"
  [[ -d "${CHILD_RUN_DIR}" ]] || fail "child run dir not found: ${CHILD_RUN_DIR}"

  # Patch the child's metadata: set parent_run_id, inherit linear_ticket.
  PYTHONPATH="${WORKBENCH_ROOT}" python3 - \
    "${CHILD_RUN_DIR}" "${PARENT_RUN_ID}" "${PARENT_LINEAR}" <<'PY'
import sys
from pathlib import Path
from dataclasses import replace
from lib.metadata import load, save

run_dir, parent_run_id, linear_ticket = sys.argv[1], sys.argv[2], sys.argv[3]
md = load(Path(run_dir))
md = replace(md, parent_run_id=parent_run_id, linear_ticket=linear_ticket)
save(Path(run_dir), md, touch_updated_at=True)
PY

  SPAWNED_RUN_IDS+=("${CHILD_RUN_ID}")
done <<<"${WBS_RAW}"

# --- Transition parent: investigating -> investigated -------------------------
PYTHONPATH="${WORKBENCH_ROOT}" python3 - "${PARENT_RUN_DIR}" <<'PY'
import sys
from pathlib import Path
from lib.metadata import load, save, transition

run_dir = Path(sys.argv[1])
md = load(run_dir)
md = transition(md, "investigated")
save(run_dir, md, touch_updated_at=False)  # transition() already refreshed updated_at
PY

# Best-effort Beads mirror — sync the parent (now investigated) and re-sync
# children so the parent_run_id linkage in metadata is reflected as a bd-parent
# relationship. (new-feature.sh already synced each child once, but at that
# time parent_run_id wasn't set yet.)
"${SCRIPT_DIR}/sync-to-beads.sh" "${PARENT_RUN_DIR}" || true
for child in "${SPAWNED_RUN_IDS[@]}"; do
  "${SCRIPT_DIR}/sync-to-beads.sh" "${WORKBENCH_ROOT}/runs/${child}" || true
done

# --- Summary ------------------------------------------------------------------
printf '\n=== spawn-children done ===\n'
printf 'parent: %s (status: investigated)\n' "${PARENT_RUN_ID}"
printf 'children spawned: %d\n' "${#SPAWNED_RUN_IDS[@]}"
for child in "${SPAWNED_RUN_IDS[@]}"; do
  printf '  - %s\n' "${child}"
done
