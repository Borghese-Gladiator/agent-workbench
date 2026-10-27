"""Thin Python wrapper around the Beads (`bd`) CLI.

Beads is the workbench's task-graph index. We deliberately treat the CLI as
the contract — no library imports — to keep the integration loosely coupled
and version-tolerant.

Posture:
- Beads is **optional**. Every entry point first checks `is_available()` and
  callers can short-circuit when `bd` is missing.
- Workbench is canonical, Beads is derived. We never read state OUT of Beads
  to mutate workbench state. (See docs/beads-integration.md.)
- Failures raise `BeadsError`; callers (notably sync-to-beads.sh) decide
  whether to swallow or escalate.
- Every `bd` invocation passes `--non-interactive`-equivalent flags and is
  timeout-bounded so a stuck `bd` cannot block the workbench.

The mapping between workbench statuses and Beads operations is documented
in `update_issue_status()`.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Optional


class BeadsError(RuntimeError):
    """Raised when a `bd` invocation fails or returns unexpected output."""


# Hard cap on every bd invocation. Beads is local-only, so 10s is generous.
_BD_TIMEOUT_SECONDS = 10


# Mapping table: workbench status -> Beads operation.
# Keys not listed here are no-ops (draft / planned / investigating /
# investigated / in_review fall through with no Beads write — Beads doesn't
# need a 1:1 mirror of every state).
_STATUS_OPERATIONS: dict[str, str] = {
    "in_progress": "claim",       # bd update --claim <id>
    "qa":          "set-state",   # bd set-state <id> review=qa
    "merged":      "close",       # bd close <id>
    "abandoned":   "close",       # bd close <id>
}


def is_available() -> bool:
    """True iff `bd` is on PATH."""
    return shutil.which("bd") is not None


def is_initialized(workbench_root: Path) -> bool:
    """True iff Beads can find an initialized database from `workbench_root`.

    `bd` walks up the filesystem looking for `.beads/`. When ai-workbench is
    itself a git worktree (a common setup), the `.beads/` may live at the
    parent repo root rather than directly under `workbench_root`. We delegate
    discovery to `bd info` which mirrors `bd`'s own logic, instead of
    second-guessing it with a strict path check.
    """
    if not is_available():
        return False
    try:
        proc = subprocess.run(
            ["bd", "info"],
            cwd=str(workbench_root),
            capture_output=True,
            text=True,
            timeout=_BD_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return False
    return proc.returncode == 0


def _run_bd(args: list[str], *, cwd: Optional[Path] = None) -> subprocess.CompletedProcess:
    """Run `bd` with timeout + capture; raise BeadsError on non-zero exit."""
    if not is_available():
        raise BeadsError("bd is not on PATH")
    cmd = ["bd", *args]
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(cwd) if cwd else None,
            capture_output=True,
            text=True,
            timeout=_BD_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise BeadsError(f"bd timed out after {_BD_TIMEOUT_SECONDS}s: {' '.join(cmd)}") from exc
    if proc.returncode != 0:
        raise BeadsError(
            f"bd {' '.join(args)} failed (exit {proc.returncode}):\n"
            f"stdout: {proc.stdout.strip()}\nstderr: {proc.stderr.strip()}"
        )
    return proc


def init(workbench_root: Path, *, prefix: str = "wb") -> None:
    """Initialize Beads in the workbench root if not already done.

    Idempotent — no-op if `.beads/` already exists.
    """
    if is_initialized(workbench_root):
        return
    _run_bd(
        ["init", "--non-interactive", "--prefix", prefix],
        cwd=workbench_root,
    )


def create_issue(
    workbench_root: Path,
    *,
    title: str,
    description: str,
    run_id: str,
    run_type: str,
    parent_bead_id: str = "",
    linear_ticket: str = "",
) -> str:
    """Create a Beads issue mirroring a workbench run; return the new bead ID.

    `run_id` is stored as `external_ref="ai-workbench:<run_id>"` so that
    `bd query` / `bd search` can find runs by their workbench ID.

    `parent_bead_id`, when set, must already exist (callers should sync the
    parent first if needed).
    """
    args: list[str] = [
        "create",
        title,
        "--silent",
        "--description", description,
        "--external-ref", f"ai-workbench:{run_id}",
        "--labels", f"run-type:{run_type},workbench",
    ]
    if parent_bead_id:
        # --no-inherit-labels: avoids the child picking up the parent's
        # run-type:investigation label and ending up with two run-type:* labels.
        args.extend(["--parent", parent_bead_id, "--no-inherit-labels"])
    proc = _run_bd(args, cwd=workbench_root)
    bead_id = proc.stdout.strip()
    if not bead_id:
        raise BeadsError("bd create --silent returned empty stdout")
    # Light sanity check: ID should look like <prefix>-<hash>.
    if "-" not in bead_id or " " in bead_id or "\n" in bead_id:
        raise BeadsError(f"unexpected bd create output: {bead_id!r}")
    return bead_id


def issue_exists(workbench_root: Path, bead_id: str) -> bool:
    """True iff `bd show <bead_id>` finds the issue."""
    try:
        proc = _run_bd(["show", bead_id, "--json"], cwd=workbench_root)
    except BeadsError:
        return False
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return False
    # `bd show --json` returns either a list (when found) or {"<id>": null}
    # (when missing in some shapes — observed in probing).
    if isinstance(data, list):
        return any(item.get("id") == bead_id for item in data)
    if isinstance(data, dict):
        return data.get(bead_id) is not None
    return False


def issue_status(workbench_root: Path, bead_id: str) -> str:
    """Return the issue's current Beads status (e.g. 'open', 'in_progress', 'closed')."""
    proc = _run_bd(["show", bead_id, "--json"], cwd=workbench_root)
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise BeadsError(f"bd show returned non-JSON: {proc.stdout!r}") from exc
    if isinstance(data, list) and data:
        status = data[0].get("status")
        if isinstance(status, str):
            return status
    raise BeadsError(f"could not extract status for {bead_id}")


def update_issue_status(workbench_root: Path, bead_id: str, workbench_status: str) -> None:
    """Map a workbench status to a Beads operation and apply it.

    Mapping (statuses not listed are no-ops):
      in_progress -> bd update --claim <id>
      in_review   -> bd set-state <id> review=in-progress
      qa          -> bd set-state <id> review=qa
      merged      -> bd close <id> -r "run merged"
      abandoned   -> bd close <id> -r "run abandoned"
    """
    op = _STATUS_OPERATIONS.get(workbench_status)
    if op is None and workbench_status != "in_review":
        return  # no-op for draft/planned/investigating/investigated
    try:
        if workbench_status == "in_progress":
            _run_bd(["update", "--claim", bead_id], cwd=workbench_root)
        elif workbench_status == "in_review":
            _run_bd(
                ["set-state", bead_id, "review=in-progress", "--reason", "PR opened"],
                cwd=workbench_root,
            )
        elif workbench_status == "qa":
            _run_bd(
                ["set-state", bead_id, "review=qa", "--reason", "QA pass recorded"],
                cwd=workbench_root,
            )
        elif workbench_status == "merged":
            _run_bd(["close", bead_id, "-r", "run merged"], cwd=workbench_root)
        elif workbench_status == "abandoned":
            _run_bd(["close", bead_id, "-r", "run abandoned"], cwd=workbench_root)
    except BeadsError:
        # If the issue is already in the target state, bd may exit non-zero
        # depending on operation. Re-raise so callers see drift; callers in
        # sync-to-beads.sh decide whether to swallow.
        raise


def query_children(workbench_root: Path, parent_bead_id: str) -> list[str]:
    """Return the bead IDs of `parent_bead_id`'s direct children."""
    proc = _run_bd(["children", parent_bead_id, "--json"], cwd=workbench_root)
    if not proc.stdout.strip():
        return []
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise BeadsError(f"bd children returned non-JSON: {proc.stdout!r}") from exc
    if not isinstance(data, list):
        raise BeadsError(f"bd children expected list, got {type(data).__name__}")
    out: list[str] = []
    for item in data:
        bid = item.get("id") if isinstance(item, dict) else None
        if isinstance(bid, str):
            out.append(bid)
    return out
