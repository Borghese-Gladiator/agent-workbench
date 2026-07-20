"""new-run subcommand."""
from __future__ import annotations

import pathlib
import sys

from lib import metadata, events, run_ids, repos, lifecycle, runs as runs_mod
from lib.cli._common import actor_from_env, fail, load_config


HELP = "Create a new run from a raw idea."


def _canonical_repo_basename(repo_path: pathlib.Path, repo_mode: str) -> str:
    """Basename used as input to derive_repo_name.

    For an existing git repo we resolve to `git rev-parse --show-toplevel` so
    that any subpath of the same repo derives the same `repo_name` (and lands
    worktrees under the same second-level dir). For the new-repo bootstrap
    flow (no git repo yet) or any path not inside a git repo, fall back to
    `repo_path.name` — the legacy behavior.
    """
    if repo_mode != "existing":
        return repo_path.name
    toplevel = repos.show_toplevel(repo_path)
    if toplevel is None:
        return repo_path.name
    return toplevel.name


def register(p) -> None:
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--repo-path", type=pathlib.Path, help="Path to an existing git repo.")
    g.add_argument("--new-repo-path", type=pathlib.Path, help="Path where a new repo will be created.")
    p.add_argument("--worktree-name", required=True, help="Slug for the worktree (and default for branch).")
    p.add_argument("--idea-file", type=pathlib.Path, help="File containing the raw idea (else read stdin).")
    p.add_argument("--scope-kind", default="implementation",
                   choices=("implementation", "bootstrap", "roadmap", "research", "repair"))
    p.add_argument("--scope-summary", default="", help="Short one-line summary of the scope.")
    p.add_argument("--repo-name", help="Override repo name (defaults to basename of repo path).")
    p.add_argument("--base-ref", help="Base ref for the worktree (defaults to config).")


def run(args) -> int:
    cfg = load_config(args)

    if args.new_repo_path:
        repo_path = args.new_repo_path.resolve()
        repo_mode = "new"
    else:
        repo_path = args.repo_path.resolve()
        repo_mode = "existing"

    base_ref = args.base_ref or cfg.defaults.base_ref

    # Validate target.
    if repo_mode == "existing":
        try:
            repos.verify_existing(repo_path, base_ref)
        except repos.RepoError as e:
            return fail(str(e), 2)
    else:
        if repo_path.exists() and any(repo_path.iterdir()):
            return fail(f"new repo path is not empty: {repo_path}", 3)

    # Name resolution.
    try:
        worktree_name = run_ids.slugify(args.worktree_name)
    except run_ids.NamingError as e:
        return fail(f"invalid --worktree-name: {e}", 2)
    if args.repo_name:
        repo_name = args.repo_name
    else:
        repo_name = run_ids.derive_repo_name(
            _canonical_repo_basename(repo_path, repo_mode)
        )
    branch_name = run_ids.make_branch_name(cfg, worktree_name)

    # Run ID.
    run_id = run_ids.make_run_id(worktree_name)
    if metadata.run_dir(cfg, run_id).exists():
        return fail(f"run id collision: {run_id} already exists", 3)

    # Idea text.
    if args.idea_file:
        if not args.idea_file.exists():
            return fail(f"--idea-file not found: {args.idea_file}", 2)
        idea = args.idea_file.read_text()
    else:
        if sys.stdin.isatty():
            return fail("provide --idea-file or pipe the idea on stdin", 2)
        idea = sys.stdin.read()
    idea = idea.strip()
    if not idea:
        return fail("idea is empty", 2)

    # TODO §1A: for an existing self-modifying target (workbench is inside the
    # repo), create the worktree NOW so the run dir lives inside it from the
    # start. For new-repo mode the repo doesn't exist yet — the existing
    # behavior (run dir in cfg.runs_path, worktree created later at /start
    # against the now-existing repo) keeps working.
    worktree_path: pathlib.Path | None = None
    base_ref_sha: str | None = None
    run_dir_override: pathlib.Path | None = None
    if repo_mode == "existing":
        probe_meta = {"target": {"repo": {"path": str(repo_path)}}}
        if runs_mod.is_self_modifying(cfg, probe_meta):
            try:
                base_ref_sha = repos.resolve_ref_to_sha(repo_path, base_ref)
            except repos.RepoError as e:
                return fail(f"failed to resolve base_ref {base_ref!r}: {e}", 2)
            worktree_path = run_ids.make_worktree_path(
                cfg, repo_name, worktree_name, run_id,
            )
            try:
                repos.create_worktree(repo_path, branch_name, worktree_path, base_ref)
            except repos.RepoError as e:
                return fail(f"failed to create worktree: {e}", 2)
            # New worktree → invalidate the worktree-list cache so the next
            # lookup sees it (TODO §1A1).
            runs_mod.reset_caches()
            sub = runs_mod.workbench_subpath(cfg)
            if sub is None:
                # Self-modifying detected but the workbench is not inside the
                # cfg.root's owning repo — should not happen, but bail cleanly.
                repos.remove_worktree(repo_path, worktree_path, force=True)
                return fail(
                    "internal: workbench subpath could not be derived; "
                    "cannot place run dir inside worktree.",
                    4,
                )
            run_dir_override = worktree_path / sub / "runs" / run_id

    # Create the run.
    metadata.create(
        cfg, run_id,
        repo_mode=repo_mode,
        repo_path=str(repo_path),
        repo_name=repo_name,
        base_ref=base_ref,
        worktree_name=worktree_name,
        branch_name=branch_name,
        raw_idea_path="raw-idea.md",
        scope_kind=args.scope_kind,
        scope_summary=args.scope_summary,
        worktree_path=str(worktree_path) if worktree_path else None,
        base_ref_sha=base_ref_sha,
        run_dir_override=run_dir_override,
    )
    rd = metadata.run_dir(cfg, run_id)
    (rd / "raw-idea.md").write_text(idea + "\n")

    # New runs always use the staged layout (TODO §1a).
    lifecycle.init_staged_layout(cfg, run_id)

    # For new repos, create now so the path is real before planning.
    initial_sha = None
    if repo_mode == "new":
        try:
            initial_sha = repos.create_new(repo_path, monorepo_layout=True)
        except repos.RepoError as e:
            return fail(f"failed to init new repo: {e}", 2)
        # Update metadata with the SHA.
        def _mutator(d):
            d["target"]["repo"]["fingerprint"] = initial_sha
        metadata.update(cfg, run_id, _mutator)

    actor = actor_from_env("agent")
    events.append(
        cfg, run_id, "RunCreated",
        payload={
            "raw_idea_path": str(rd / "raw-idea.md"),
            "repo_path": str(repo_path),
            "repo_name": repo_name,
            "repo_mode": repo_mode,
            "worktree_name": worktree_name,
            "branch_name": branch_name,
            "base_ref": base_ref,
            "scope_kind": args.scope_kind,
        },
        actor=actor,
    )
    # Note: self-modifying runs resolve the symbolic base_ref to a concrete
    # SHA above (worktree created here at draft time) and persist it in
    # metadata. The audit-trail `BaseRefResolved` event is emitted later by
    # `cmd_start.py` regardless of where the resolve happened, so the audit
    # narrative consistently shows the SHA at the ready->building boundary
    # (per AC 6).
    if initial_sha:
        events.append(
            cfg, run_id, "ArtifactWritten",
            payload={"artifact_key": "new_repo", "path": str(repo_path), "summary": f"initial commit {initial_sha[:10]}"},
            actor=actor,
        )

    print(run_id)
    return 0
