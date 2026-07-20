#!/usr/bin/env bash
#
# sync-to-beads.sh <run_dir>
#
# Idempotently mirror a workbench run into Beads. Safe to call any number of
# times.
#
# Behavior:
#   1. If `bd` not on PATH: print warning, exit 0. (Beads is optional.)
#   2. If `.beads/` not initialized in workbench root: `bd init`.
#   3. Load the run's metadata.yaml.
#   4. If beads_task_id is empty:
#        - if parent_run_id is set, recurse: sync the parent first,
#          read back its (now-populated) beads_task_id.
#        - `bd create` (with --parent if applicable); write the new bead ID
#          back into metadata.yaml.
#      Else: confirm the issue still exists; loud failure if it doesn't.
#   5. Map current workbench status to Beads via lib.beads.update_issue_status.
#
# Errors from `bd` after step 1 are NOT swallowed — they surface to the caller.
# Lifecycle scripts that call sync-to-beads.sh use `|| true` to avoid blocking
# on Beads hiccups.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKBENCH_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${WORKBENCH_ROOT}"

usage() {
  cat <<'EOF' >&2
usage: sync-to-beads.sh <run_dir>

  run_dir   path to the run directory (relative to workbench or absolute).
EOF
  exit 2
}

if [[ $# -ne 1 ]]; then
  usage
fi

RUN_DIR_INPUT="$1"

fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

if [[ "${RUN_DIR_INPUT}" = /* ]]; then
  RUN_DIR="${RUN_DIR_INPUT}"
else
  RUN_DIR="${WORKBENCH_ROOT}/${RUN_DIR_INPUT}"
fi

[[ -d "${RUN_DIR}" ]] || fail "run dir not found: ${RUN_DIR}"
[[ -f "${RUN_DIR}/metadata.yaml" ]] || fail "missing metadata.yaml: ${RUN_DIR}"

# All real work lives in Python — easier to recurse on the parent + manage
# error handling than to do it in bash.
PYTHONPATH="${WORKBENCH_ROOT}" python3 - "${WORKBENCH_ROOT}" "${RUN_DIR}" <<'PY'
import sys
from dataclasses import replace
from pathlib import Path

from lib import beads
from lib.beads import BeadsError
from lib.metadata import load, save, MetadataError

workbench_root = Path(sys.argv[1])
run_dir = Path(sys.argv[2])


def sync_run(run_dir: Path, *, depth: int = 0) -> str:
    """Sync one run; return its beads_task_id. Recurse on parents as needed."""
    if depth > 10:
        raise RuntimeError(f"parent chain too deep at {run_dir}; aborting")
    md = load(run_dir)

    # Parent must be synced first so its beads_task_id is available.
    parent_bead_id = ""
    if md.parent_run_id:
        parent_run_dir = workbench_root / "runs" / md.parent_run_id
        if not parent_run_dir.is_dir():
            raise RuntimeError(
                f"parent run dir not found: {parent_run_dir} (referenced by {md.run_id})"
            )
        parent_bead_id = sync_run(parent_run_dir, depth=depth + 1)

    if md.beads_task_id:
        # Confirm the issue exists; loud failure on drift.
        if not beads.issue_exists(workbench_root, md.beads_task_id):
            raise RuntimeError(
                f"metadata.yaml says beads_task_id={md.beads_task_id!r} but "
                f"`bd show` cannot find it. Workbench/Beads have drifted; "
                "investigate before re-running."
            )
        bead_id = md.beads_task_id
    else:
        title = f"{md.run_type}: {md.feature_slug}"
        # Compose a description that includes the workbench-canonical pointers
        # so a reader of the bead can find the run without round-tripping.
        desc_lines = [
            f"ai-workbench run: {md.run_id}",
            f"repo_key: {md.repo_key}",
            f"run_type: {md.run_type}",
        ]
        if md.linear_ticket:
            desc_lines.append(f"linear: {md.linear_ticket}")
        if md.parent_run_id:
            desc_lines.append(f"parent_run_id: {md.parent_run_id}")
        if md.worktree_path:
            desc_lines.append(f"worktree: {md.worktree_path}")
        if md.pr_url:
            desc_lines.append(f"pr: {md.pr_url}")
        description = "\n".join(desc_lines)

        bead_id = beads.create_issue(
            workbench_root,
            title=title,
            description=description,
            run_id=md.run_id,
            run_type=md.run_type,
            parent_bead_id=parent_bead_id,
            linear_ticket=md.linear_ticket,
        )
        md = replace(md, beads_task_id=bead_id)
        save(run_dir, md, touch_updated_at=True)
        print(f"  created bead {bead_id} for run {md.run_id}")

    # Map status -> Beads operation. `update_issue_status` is forgiving for
    # statuses that don't need a Beads write (draft, planned, etc.).
    if md.status:
        try:
            beads.update_issue_status(workbench_root, bead_id, md.status)
        except BeadsError as exc:
            # State transitions can be already-applied (e.g. closing an already-
            # closed issue). Print a warning but don't fail — sync is supposed
            # to converge.
            print(f"  warning: could not apply status {md.status!r} to {bead_id}: {exc}",
                  file=sys.stderr)

    return bead_id


# Step 1: bd availability gate.
if not beads.is_available():
    print("warning: bd is not on PATH; Beads sync skipped", file=sys.stderr)
    sys.exit(0)

# Step 2: ensure .beads/ initialized.
if not beads.is_initialized(workbench_root):
    print(f"initializing .beads/ in {workbench_root} ...")
    beads.init(workbench_root, prefix="wb")

# Steps 3-5.
try:
    final_bead = sync_run(run_dir)
except (MetadataError, BeadsError, RuntimeError) as exc:
    print(f"sync failed: {exc}", file=sys.stderr)
    sys.exit(1)

print(f"synced: run={run_dir.name} bead={final_bead}")
PY
