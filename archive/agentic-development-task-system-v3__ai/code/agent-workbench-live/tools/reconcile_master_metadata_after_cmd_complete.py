"""One-shot reconciliation: rewrite stale master-side metadata.yaml to `done`.

Closes TODO §1 (Y scope, 2026-05-27): four self-modifying runs reached `done`
in their worktree but the master-side `runs/<id>/metadata.yaml` was left at
`status: human_review` because `cmd_complete` wrote `done` to the worktree
copy AFTER the merge already happened. The merge SHA captured a pre-`done`
tree; the worktree's `done` write never reached master.

The companion read-layer fix in `lib/runs.py:_walk_worktrees` makes `list`
and `board` agree at the read layer even when master is stale — but this
script cleans up the on-disk state so future readers of those files (e.g.
`git show master:agent-workbench-live/runs/<id>/metadata.yaml`) see the
right answer.

Scope: the four hardcoded run IDs in KNOWN_STALE_RUNS. The script can also
be invoked with `--run-id <id>` to process a single run, with optional
`--branch-name` / `--merge-sha` overrides for cases where discovery fails.

Idempotent: re-running on already-reconciled metadata is a no-op (status is
already `done`).

Run from anywhere; pass the workbench root via --root, default is the dir
containing tools/.

Usage:
    python tools/reconcile_master_metadata_after_cmd_complete.py [--write]
    python tools/reconcile_master_metadata_after_cmd_complete.py --run-id <id> --write
    python tools/reconcile_master_metadata_after_cmd_complete.py \
        --run-id <id> --merge-sha <sha> --write   # bypass discovery
"""
from __future__ import annotations

import argparse
import pathlib
import subprocess
import sys


KNOWN_STALE_RUNS = (
    "2026-05-25-generalize-stage-context-md",
    "2026-05-26-board-freshness-across-worktrees",
    "2026-05-25-each-worktree-owns-its-own-run-dir",
    "2026-05-25-lifecycle-papercuts-lock-ready-banner",
)


def _git_toplevel(start: pathlib.Path) -> pathlib.Path:
    proc = subprocess.run(
        ["git", "-C", str(start), "rev-parse", "--show-toplevel"],
        capture_output=True, text=True, check=True,
    )
    return pathlib.Path(proc.stdout.strip())


def _resolve_parent_branch(workbench_root: pathlib.Path, base_ref: str) -> str:
    """Resolve `base_ref` to a concrete branch name on the workbench root.

    Mirrors `lib.repos.resolve_parent_branch` but inlined to keep this script
    standalone (no PYTHONPATH dance for one helper).
    """
    if base_ref == "HEAD":
        proc = subprocess.run(
            ["git", "-C", str(workbench_root), "symbolic-ref", "--short", "HEAD"],
            capture_output=True, text=True, check=True,
        )
        return proc.stdout.strip()
    return base_ref


def _find_merge_sha(
    git_toplevel: pathlib.Path,
    parent_branch: str,
    workbench_subpath: pathlib.Path,
    run_id: str,
    branch_name: str | None,
) -> tuple[str | None, str]:
    """Return (sha, source) or (None, reason).

    Primary: file-path topology. Fallback: anchored message-grep. Returns
    `source` so the caller can WARN on fallbacks.
    """
    rel_path = str(workbench_subpath / "runs" / run_id / "metadata.yaml")
    proc = subprocess.run(
        ["git", "-C", str(git_toplevel), "log", "--merges", "--first-parent",
         "--format=%H", parent_branch, "--", rel_path],
        capture_output=True, text=True, check=True,
    )
    shas = [line.strip() for line in proc.stdout.splitlines() if line.strip()]
    if len(shas) == 1:
        return shas[0], "file-path"
    if len(shas) > 1:
        # Most recent first (git log default); WARN.
        return shas[0], f"file-path (multiple-merges: {len(shas)}, using newest)"

    # Fallback: anchored message-grep on branch_name.
    if branch_name:
        proc = subprocess.run(
            ["git", "-C", str(git_toplevel), "log", "--merges",
             f"--grep=^Merge branch '{branch_name}'$", "-E",
             "--format=%H", parent_branch],
            capture_output=True, text=True, check=True,
        )
        shas = [line.strip() for line in proc.stdout.splitlines() if line.strip()]
        if len(shas) == 1:
            return shas[0], "message-grep"
        if len(shas) > 1:
            return shas[0], f"message-grep (multiple-merges: {len(shas)}, using newest)"

    return None, "no-merge-found"


def _committer_date(git_toplevel: pathlib.Path, sha: str) -> str:
    proc = subprocess.run(
        ["git", "-C", str(git_toplevel), "log", "-1", "--format=%cI", sha],
        capture_output=True, text=True, check=True,
    )
    return proc.stdout.strip()


def _branch_name_from_meta(meta: dict, run_id: str) -> str | None:
    wt = (meta.get("target") or {}).get("worktree", {})
    name = wt.get("branch_name")
    if isinstance(name, str) and name:
        return name
    # Compose from `<branch_prefix>/<worktree_name>` if missing.
    worktree_name = wt.get("worktree_name")
    if isinstance(worktree_name, str) and worktree_name:
        return f"agent/{worktree_name}"
    return None


def _base_ref_from_meta(meta: dict) -> str:
    repo = (meta.get("target") or {}).get("repo", {})
    base_ref = repo.get("base_ref")
    return base_ref if isinstance(base_ref, str) and base_ref else "HEAD"


def _process_run(
    *,
    workbench_root: pathlib.Path,
    git_toplevel: pathlib.Path,
    workbench_subpath: pathlib.Path,
    run_id: str,
    parent_branch: str,
    branch_override: str | None,
    sha_override: str | None,
    write: bool,
    yaml_io,
) -> str:
    """Process one run. Returns a status code: ok / skip / write / warn."""
    meta_path = workbench_root / "runs" / run_id / "metadata.yaml"
    if not meta_path.exists():
        print(f"{run_id}: SKIP missing master-side metadata.yaml")
        return "skip"

    data = yaml_io.loads(meta_path.read_text())
    if not isinstance(data, dict):
        print(f"{run_id}: SKIP metadata not a mapping", file=sys.stderr)
        return "skip"

    status = data.get("status")
    if status in ("done", "abandoned"):
        print(f"{run_id}: OK already-terminal (status={status})")
        return "ok"

    if sha_override:
        sha, source = sha_override, "override"
    else:
        branch_name = branch_override or _branch_name_from_meta(data, run_id)
        sha, source = _find_merge_sha(
            git_toplevel, parent_branch, workbench_subpath, run_id, branch_name,
        )

    if sha is None:
        print(f"{run_id}: WARN {source}; use --merge-sha to override", file=sys.stderr)
        return "warn"

    completed_at = _committer_date(git_toplevel, sha)

    completion = data.setdefault("completion", {})
    print(f"{run_id}: status: {status} -> done")
    print(f"{run_id}: completion.accepted_by: {completion.get('accepted_by')!r} -> 'reconciliation'")
    print(f"{run_id}: completion.completion_ref: {completion.get('completion_ref')!r} -> 'merge:{sha}'")
    print(f"{run_id}: completion.completed_at: {completion.get('completed_at')!r} -> {completed_at!r}")
    print(f"{run_id}: (merge SHA discovered via {source})")

    if not write:
        return "write"

    data["status"] = "done"
    completion["accepted_by"] = "reconciliation"
    completion["completion_ref"] = f"merge:{sha}"
    completion["completed_at"] = completed_at
    meta_path.write_text(yaml_io.dumps(data))
    return "write"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--root",
        type=pathlib.Path,
        default=pathlib.Path(__file__).resolve().parent.parent,
        help="Workbench root (default: the dir containing tools/).",
    )
    parser.add_argument(
        "--write",
        action="store_true",
        help="Apply changes; default is dry-run.",
    )
    parser.add_argument(
        "--run-id",
        help="Restrict to a single run id (default: process all KNOWN_STALE_RUNS).",
    )
    parser.add_argument(
        "--branch-name",
        help="Override the discovered branch name (used in message-grep fallback).",
    )
    parser.add_argument(
        "--merge-sha",
        help="Override the discovered merge SHA (skips discovery entirely).",
    )
    args = parser.parse_args(argv)

    workbench_root = args.root.resolve()
    if not workbench_root.is_dir():
        print(f"workbench root not found: {workbench_root}", file=sys.stderr)
        return 2

    sys.path.insert(0, str(workbench_root))
    from lib import yaml_io
    from lib.runs import workbench_subpath as _wb_subpath
    from lib.config import load as load_config

    cfg = load_config(workbench_root)
    sub = _wb_subpath(cfg)
    if sub is None:
        print(f"could not resolve workbench subpath under git toplevel", file=sys.stderr)
        return 2
    git_toplevel = _git_toplevel(workbench_root)

    base_ref = "HEAD"  # script always reconciles against the workbench's HEAD branch
    parent_branch = _resolve_parent_branch(workbench_root, base_ref)

    if args.run_id:
        targets = (args.run_id,)
    else:
        targets = KNOWN_STALE_RUNS

    counts = {"ok": 0, "skip": 0, "write": 0, "warn": 0}
    for run_id in targets:
        result = _process_run(
            workbench_root=workbench_root,
            git_toplevel=git_toplevel,
            workbench_subpath=sub,
            run_id=run_id,
            parent_branch=parent_branch,
            branch_override=args.branch_name,
            sha_override=args.merge_sha,
            write=args.write,
            yaml_io=yaml_io,
        )
        counts[result] += 1

    print()
    if args.write:
        print(f"applied: {counts['write']}, already-terminal: {counts['ok']}, "
              f"skipped: {counts['skip']}, warned: {counts['warn']}")
    else:
        print(f"would-apply: {counts['write']}, already-terminal: {counts['ok']}, "
              f"skipped: {counts['skip']}, warned: {counts['warn']}")
        if counts["write"] > 0:
            print("Re-run with --write to apply.")

    return 0 if counts["warn"] == 0 and counts["skip"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
