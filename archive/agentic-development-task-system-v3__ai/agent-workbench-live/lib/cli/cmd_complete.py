"""complete subcommand. human_review -> done.

Auto-merges the run's worktree branch into the parent branch before recording
the transition. See TODO §1 / `docs/lifecycle.md` § `done`.
"""
from __future__ import annotations

import pathlib
import sys

from lib import metadata, transitions, locks, repos, events as events_mod, runs as runs_mod
from lib.cli._common import actor_from_env, fail, load_config
from lib.cli._stop_banner import print_stop_banner
from lib.metrics import writer as metrics_writer


HELP = "Accept a run in human_review; merge the worktree branch and transition to done."


MERGE_STRATEGY = "no-ff"


def register(p) -> None:
    p.add_argument("run_id")
    p.add_argument("--accepted-by", required=True)
    p.add_argument(
        "--completion-ref",
        help=(
            "Override the recorded completion_ref. By default cmd_complete merges "
            "the worktree branch and stores `merge:<sha>`; this flag is only "
            "useful for runs that completed outside the lifecycle."
        ),
    )
    p.add_argument(
        "--no-merge",
        action="store_true",
        help=(
            "Skip the auto-merge step. Records `completion_ref: local-branch:<branch>` "
            "as a label, mirroring the legacy behavior. The board will surface this "
            "run with a warning badge until it's merged by hand."
        ),
    )


def run(args) -> int:
    cfg = load_config(args)
    actor = actor_from_env("human")
    actor["name"] = args.accepted_by
    run_id = args.run_id

    try:
        meta = metadata.load(cfg, run_id)
    except metadata.MetadataError as e:
        return fail(str(e), 2)

    if meta["status"] != "human_review":
        return fail(f"complete requires status=human_review, got {meta['status']!r}", 2)

    rd = metadata.run_dir(cfg, run_id)
    audit_path = rd / "audit.md"
    if not audit_path.exists():
        return fail(f"audit.md missing at {audit_path}; re-run validate", 2)

    target = meta["target"]
    branch_name = target["worktree"]["branch_name"]
    repo_path = target["repo"].get("path")
    worktree_path = target["worktree"].get("path")
    base_ref = target["repo"].get("base_ref") or "HEAD"

    # No-merge escape hatch keeps the old `local-branch:` label flow for callers
    # that explicitly opt out — or pass their own `--completion-ref`.
    auto_merge = not args.no_merge and not args.completion_ref

    merge_sha: str | None = None
    parent_branch: str | None = None

    try:
        with locks.acquire(cfg, run_id):
            if auto_merge:
                merge_sha, parent_branch = _do_merge(
                    cfg=cfg,
                    run_id=run_id,
                    actor=actor,
                    repo_path=repo_path,
                    worktree_path=worktree_path,
                    base_ref=base_ref,
                    branch_name=branch_name,
                    accepted_by=args.accepted_by,
                )

            if args.completion_ref:
                completion_ref = args.completion_ref
            elif merge_sha:
                completion_ref = f"merge:{merge_sha}"
            else:
                completion_ref = f"local-branch:{branch_name}"

            transitions.transition(
                cfg, run_id, "done",
                evidence={
                    "accepted_by": args.accepted_by,
                    "completion_ref": completion_ref,
                    "audit_path": str(audit_path),
                },
                actor=actor,
            )

            if merge_sha and parent_branch:
                events_mod.append(
                    cfg, run_id, "WorktreeMerged",
                    payload={
                        "worktree_branch": branch_name,
                        "parent_branch": parent_branch,
                        "merge_sha": merge_sha,
                        "merge_strategy": MERGE_STRATEGY,
                        "repo_path": repo_path,
                    },
                    actor=actor,
                )
    except _CompleteError as e:
        return fail(str(e), e.exit_code)
    except transitions.TransitionError as e:
        return fail(str(e), 4)

    # Record completion in metadata.
    def _m(d):
        d["completion"]["accepted_by"] = args.accepted_by
        d["completion"]["completion_ref"] = completion_ref
        d["completion"]["completed_at"] = metadata.now_iso()
    metadata.update(cfg, run_id, _m)

    # Clean up the worktree + branch after a successful merge. Skipped on
    # --no-merge / explicit --completion-ref so the caller can still cd into
    # the unmerged work. Failure is non-fatal: the run is already in `done`
    # and the merge has already landed, so a removal warning is enough.
    removed_worktree = False
    if merge_sha and repo_path and worktree_path and branch_name:
        try:
            repos.remove_worktree(
                pathlib.Path(repo_path),
                pathlib.Path(worktree_path),
                force=True,
            )
            removed_worktree = True
            try:
                repos.delete_branch(repo_path, branch_name)
            except repos.RepoError:
                # Non-fatal: branch may already be gone or held elsewhere.
                pass
            runs_mod.reset_caches()
        except repos.RepoError as e:
            print(
                f"WARN: worktree removal failed; clean up by hand: {e}",
                file=sys.stderr,
            )

    # Token-efficiency tracking: refresh metrics.jsonl at terminal boundary.
    # Best-effort — never raises into the caller.
    try:
        metrics_writer.record_run_metrics(cfg, run_id)
    except Exception:
        pass

    print(f"{run_id}: human_review -> done")
    print(f"completion_ref: {completion_ref}")
    if merge_sha and parent_branch:
        print(f"merged {branch_name} into {parent_branch} ({merge_sha[:12]})")
    if removed_worktree:
        print(f"removed worktree {worktree_path} and branch {branch_name}")
    try:
        banner_path = metadata.run_dir(cfg, run_id) / "stop-banner.txt"
    except Exception:
        banner_path = None
    print_stop_banner("done", run_id, write_to=banner_path)
    return 0


class _CompleteError(Exception):
    """Internal sentinel so we can bail out of the lock cleanly with an exit code."""

    def __init__(self, message: str, exit_code: int = 5) -> None:
        super().__init__(message)
        self.exit_code = exit_code


def _do_merge(
    *,
    cfg,
    run_id: str,
    actor: dict,
    repo_path: str | None,
    worktree_path: str | None,
    base_ref: str,
    branch_name: str,
    accepted_by: str,
) -> tuple[str, str]:
    """Run the worktree pre-flight and the merge. Returns `(merge_sha, parent_branch)`.

    On any failure, emits a `MergeConflict` event if conflicts were detected and
    raises `_CompleteError` with a non-zero exit code. The run is left in
    `human_review`; no transition is recorded.
    """
    if not repo_path:
        raise _CompleteError("metadata.target.repo.path is empty", exit_code=2)
    if not worktree_path:
        raise _CompleteError("metadata.target.worktree.path is empty", exit_code=2)

    repo = pathlib.Path(repo_path)
    worktree = pathlib.Path(worktree_path)

    if not repo.exists():
        raise _CompleteError(f"target repo path does not exist: {repo}", exit_code=2)
    if not worktree.exists():
        raise _CompleteError(
            f"worktree path does not exist: {worktree}; cannot merge",
            exit_code=2,
        )

    # TODO §1A4: stage + commit the run dir on the agent branch BEFORE the
    # dirty-tree refusal. The run dir is workbench-managed; its contents are
    # always safe to auto-commit. The dirty-tree check below then refuses
    # the merge only if other (human-authored) changes remain.
    meta = metadata.load(cfg, run_id)
    if runs_mod.is_self_modifying(cfg, meta):
        sub = runs_mod.workbench_subpath(cfg)
        if sub is not None:
            run_dir_rel = sub / "runs" / run_id
            try:
                pre_sha = repos.stage_and_commit_run_dir(
                    worktree, run_dir_rel,
                    message=f"runs: {run_id} (complete)",
                )
            except repos.RepoError as e:
                raise _CompleteError(str(e), exit_code=3)
            if pre_sha:
                print(f"runs: {run_id} (complete): committed pre-merge as {pre_sha[:12]}")

    # Refuse if the worktree has uncommitted changes — the merge would skip
    # whatever the human has not committed yet, which is almost certainly not
    # what they want.
    try:
        dirty = repos.worktree_dirty_files(worktree)
    except repos.RepoError as e:
        raise _CompleteError(str(e), exit_code=3)
    if dirty:
        raise _CompleteError(
            "worktree has uncommitted changes; commit or stash before complete:\n  "
            + "\n  ".join(dirty),
            exit_code=3,
        )

    try:
        parent_branch = repos.resolve_parent_branch(repo, base_ref)
    except repos.RepoError as e:
        raise _CompleteError(str(e), exit_code=3)

    if not repos.branch_exists(repo, branch_name):
        raise _CompleteError(
            f"worktree branch {branch_name!r} not found in {repo}",
            exit_code=3,
        )

    try:
        merge_sha = repos.merge_no_ff(
            repo,
            parent_branch=parent_branch,
            worktree_branch=branch_name,
            message=(
                f"Merge branch {branch_name!r} into {parent_branch} "
                f"(agent-workbench run {run_id}, accepted_by={accepted_by})"
            ),
        )
    except repos.MergeConflictError as e:
        # Surface the conflict as a structured event before we re-raise.
        try:
            events_mod.append(
                cfg, run_id, "MergeConflict",
                payload={
                    "worktree_branch": branch_name,
                    "parent_branch": parent_branch,
                    "conflicted_files": e.conflicted_files,
                    "repo_path": str(repo),
                    "stderr": (e.stderr or "").strip()[:2000],
                },
                actor=actor,
            )
        except Exception:
            # Never mask the merge failure with a logging failure.
            pass
        files = ", ".join(e.conflicted_files) or "<unknown>"
        raise _CompleteError(
            f"merge conflict; aborted. Resolve manually and re-run complete.\n"
            f"  parent: {parent_branch}\n"
            f"  branch: {branch_name}\n"
            f"  files:  {files}",
            exit_code=6,
        )
    except repos.RepoError as e:
        raise _CompleteError(f"merge failed: {e}", exit_code=6)

    return merge_sha, parent_branch
