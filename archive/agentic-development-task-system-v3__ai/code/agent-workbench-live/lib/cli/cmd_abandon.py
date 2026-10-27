"""abandon subcommand. Wildcard: any non-terminal -> abandoned.

TODO §1A5: abandon archives the run dir onto master at
``runs/abandoned/<run_id>/`` so postmortem material survives, then removes
the worktree + branch. The code changes on the agent branch are NOT merged
into master — abandon means the work is discarded.
"""
from __future__ import annotations

import pathlib
import shutil  # used for self-modifying archive cleanup

from lib import metadata, transitions, locks, repos, runs as runs_mod
from lib.cli._common import actor_from_env, fail, load_config
from lib.cli._stop_banner import print_stop_banner
from lib.metrics import writer as metrics_writer


HELP = "Abandon a run. Wildcard from any non-terminal state."


def register(p) -> None:
    p.add_argument("run_id")
    p.add_argument("--reason", required=True)
    p.add_argument("--abandoned-by", required=True)


def run(args) -> int:
    cfg = load_config(args)
    actor = actor_from_env("human")
    actor["name"] = args.abandoned_by
    run_id = args.run_id

    try:
        meta = metadata.load(cfg, run_id)
    except metadata.MetadataError as e:
        return fail(str(e), 2)

    if transitions.is_terminal(cfg, meta["status"]):
        return fail(f"cannot abandon from terminal state {meta['status']!r}", 2)

    # Capture worktree + branch info before the transition (which may rewrite
    # paths via on_transition for staged runs).
    repo_path = pathlib.Path(meta["target"]["repo"]["path"])
    worktree_path_raw = meta["target"]["worktree"].get("path")
    worktree_path = pathlib.Path(worktree_path_raw) if worktree_path_raw else None
    branch_name = meta["target"]["worktree"].get("branch_name")
    self_modifying = runs_mod.is_self_modifying(cfg, meta)
    sub = runs_mod.workbench_subpath(cfg) if self_modifying else None

    try:
        with locks.acquire(cfg, run_id):
            transitions.transition(
                cfg, run_id, "abandoned",
                evidence={
                    "abandoned_reason": args.reason,
                    "abandoned_by": args.abandoned_by,
                },
                actor=actor,
            )
    except transitions.TransitionError as e:
        return fail(str(e), 4)

    def _m(d):
        d["completion"]["abandoned_reason"] = args.reason
    metadata.update(cfg, run_id, _m)

    # Token-efficiency tracking: refresh metrics.jsonl at terminal boundary.
    try:
        metrics_writer.record_run_metrics(cfg, run_id)
    except Exception:
        pass

    print(f"{run_id}: -> abandoned")
    print(f"reason: {args.reason}")

    # TODO §1A5: archive the run dir onto master + clean up the worktree.
    if self_modifying and worktree_path and worktree_path.exists() and sub is not None:
        archive_path = cfg.runs_path / "abandoned" / run_id
        run_dir_rel = sub / "runs" / run_id
        try:
            # Commit any pending metadata writes on the agent branch.
            repos.stage_and_commit_run_dir(
                worktree_path, run_dir_rel,
                message=f"runs: {run_id} (abandon)",
            )
            # Deliver the run dir tree onto master without merging the agent
            # branch's code changes.
            if archive_path.exists():
                shutil.rmtree(archive_path)
            repos.archive_tree_to_path(
                repo_path,
                ref=branch_name,
                source_relpath=run_dir_rel,
                dest_abs_path=archive_path,
            )
            # Commit on the workbench's main checkout so master picks up the
            # archive directory.
            wb_repo = _find_workbench_repo_root(cfg)
            if wb_repo is not None:
                archive_rel = archive_path.relative_to(wb_repo)
                repos.stage_and_commit_run_dir(
                    wb_repo, archive_rel,
                    message=f"abandon: {run_id} (run dir archived)",
                )
            # Remove the worktree + branch.
            repos.remove_worktree(repo_path, worktree_path, force=True)
            if branch_name:
                try:
                    repos.delete_branch(repo_path, branch_name)
                except repos.RepoError:
                    # Non-fatal: branch may already be gone or held elsewhere.
                    pass
            runs_mod.reset_caches()
            print(f"archived run dir to {archive_path}")
        except repos.RepoError as e:
            print(f"WARN: archive step failed; manual cleanup may be required: {e}")
    # Non-self-modifying runs keep their dir at cfg.runs_path/<id> with
    # status=abandoned. The archive-to-master step is only meaningful when
    # the workbench is inside the target repo (i.e. self-modifying).

    # No write_to for abandoned: the run dir has typically just been
    # archived/moved by the block above, so a write here would either fail
    # or land in a stale location. Banner is stdout-only.
    print_stop_banner("abandoned", run_id)
    return 0


def _find_workbench_repo_root(cfg) -> pathlib.Path | None:
    wb = cfg.root.resolve()
    for parent in [wb, *wb.parents]:
        if (parent / ".git").exists():
            return parent.resolve()
    return None
