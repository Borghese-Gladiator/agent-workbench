"""Backfill `target.repo.base_ref_sha` on runs that predate commit 303bd40.

`303bd40` taught `cmd_start` (and `cmd_new_run` for self-modifying runs) to
resolve the symbolic `base_ref` to a 40-char SHA and store it as
`target.repo.base_ref_sha`. Older runs only carry the symbolic ref (typically
`HEAD`), which leaves the lazy in-worktree resolver unable to recover the
fork point once the worktree's HEAD has advanced. Downstream this surfaces
as `agent-workbench metrics --rebuild` reporting `generated_lines: 0`.

This script walks every `runs/*/metadata.yaml`, finds entries with a symbolic
`target.repo.base_ref` and a missing or empty `target.repo.base_ref_sha`,
computes the fork point against the source repo's current `HEAD` via
`git merge-base`, and writes the SHA back via `yaml_io.dumps`. Falls back to
the worktree branch's root commit (`git rev-list --max-parents=0`) when
merge-base fails. Idempotent — runs already carrying a SHA are skipped.

Forward-only audit-log policy: this script does NOT synthesize a
`BaseRefResolved` event for backfilled runs. The audit trail for those runs
remains a snapshot of what was recorded at the time.

Usage:
    python tools/backfill_base_ref_sha.py [--root agent-workbench-live] [--dry-run]
"""
from __future__ import annotations

import argparse
import pathlib
import subprocess
import sys


def _git(repo_path: str, *args: str) -> tuple[int, str]:
    """Run git in `repo_path`. Return (exit_code, stdout). Stderr is captured
    but not returned — callers only need the exit code to branch."""
    try:
        proc = subprocess.run(
            ["git", "-C", repo_path, *args],
            capture_output=True, text=True, check=False,
        )
    except FileNotFoundError:
        return 127, ""
    return proc.returncode, proc.stdout.strip()


def _compute_fork_point(repo_path: str, branch_name: str) -> tuple[str | None, str]:
    """Compute the SHA to record as base_ref_sha. Return (sha, source).

    Strategy (in order):
      1. `git merge-base <branch> HEAD` against the source repo's current HEAD.
         This is the closest stable surrogate for "the source repo's HEAD when
         /start ran" — works as long as the branch was created off HEAD and
         the base hasn't been rebased.
      2. `git rev-list --max-parents=0 <branch>` to find the branch's root
         commit. Degenerate but stable; at worst over-counts generated lines
         relative to the original fork point, never under-counts.

    Returns (None, reason) if both fail.
    """
    rc, sha = _git(repo_path, "merge-base", branch_name, "HEAD")
    if rc == 0 and sha:
        return sha, "merge-base"
    rc, root = _git(repo_path, "rev-list", "--max-parents=0", branch_name)
    if rc == 0 and root:
        # rev-list can return multiple lines for repos with multiple roots;
        # take the first.
        first = root.splitlines()[0].strip()
        if first:
            return first, "root-commit"
    return None, "unresolvable"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--root",
        type=pathlib.Path,
        default=pathlib.Path(__file__).resolve().parent.parent,
        help="Workbench root (default: the dir containing tools/).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would change without writing.",
    )
    args = parser.parse_args(argv)

    # Lazy import — depends on PYTHONPATH being set up to find `lib/`.
    sys.path.insert(0, str(args.root))
    from lib import yaml_io

    runs_dir = args.root / "runs"
    if not runs_dir.is_dir():
        print(f"runs dir not found: {runs_dir}", file=sys.stderr)
        return 2

    changed = 0
    already = 0
    skipped = 0
    failed = 0

    for meta_path in sorted(runs_dir.glob("*/metadata.yaml")):
        run_id = meta_path.parent.name

        text = meta_path.read_text()
        # `lib/yaml_io` has a known UTF-8 round-trip hazard in its
        # double-quoted-string parser (`unicode_escape` corrupts non-ASCII).
        # Detect non-ASCII in the file and refuse to round-trip those runs;
        # rewriting would amplify any existing corruption. Track as a
        # follow-up in TODO.md.
        try:
            text.encode("ascii")
        except UnicodeEncodeError:
            print(
                f"{run_id}: metadata.yaml contains non-ASCII; skipping to "
                "avoid yaml_io round-trip corruption (see TODO)",
                file=sys.stderr,
            )
            skipped += 1
            continue

        data = yaml_io.loads(text)
        if not isinstance(data, dict):
            print(f"{run_id}: metadata is not a mapping, skipping", file=sys.stderr)
            skipped += 1
            continue

        target = data.get("target") or {}
        repo = target.get("repo") or {}
        worktree = target.get("worktree") or {}

        existing = repo.get("base_ref_sha")
        if existing:
            already += 1
            continue

        base_ref = repo.get("base_ref")
        repo_path = repo.get("path")
        branch_name = worktree.get("branch_name")

        if not base_ref or not repo_path or not branch_name:
            print(
                f"{run_id}: missing base_ref / repo.path / worktree.branch_name; "
                "skipping",
                file=sys.stderr,
            )
            skipped += 1
            continue

        if not pathlib.Path(repo_path).is_dir():
            print(f"{run_id}: source repo not found at {repo_path}; skipping",
                  file=sys.stderr)
            skipped += 1
            continue

        sha, source = _compute_fork_point(repo_path, branch_name)
        if sha is None:
            print(f"{run_id}: could not resolve fork point ({source}); skipping",
                  file=sys.stderr)
            failed += 1
            continue

        print(f"{run_id}: {base_ref!r} -> {sha} (via {source})")
        if args.dry_run:
            continue

        # Mutate and write. yaml_io.dumps round-trips comments/order on the
        # documents we care about (matches backfill_completion_refs.py).
        repo["base_ref_sha"] = sha
        # In case repo wasn't a real dict reference (defensive), reassign.
        data.setdefault("target", {})["repo"] = repo
        meta_path.write_text(yaml_io.dumps(data))
        changed += 1

    suffix = " (dry-run)" if args.dry_run else ""
    print(
        f"changed: {changed}{suffix}, already-backfilled: {already}, "
        f"skipped: {skipped}, failed: {failed}"
    )
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
