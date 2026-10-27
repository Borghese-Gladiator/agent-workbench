"""start subcommand. Transitions ready -> building. Creates the worktree."""
from __future__ import annotations

import pathlib

from lib import build_context, events, metadata, transitions, locks, repos, run_ids, lifecycle
from lib.cli._common import actor_from_env, fail, load_config


HELP = "Approve the plan and create the worktree."


def register(p) -> None:
    p.add_argument("run_id")
    p.add_argument("--approved-by", required=True)


def run(args) -> int:
    cfg = load_config(args)
    actor = actor_from_env("human")
    actor["name"] = args.approved_by
    run_id = args.run_id

    try:
        meta = metadata.load(cfg, run_id)
    except metadata.MetadataError as e:
        return fail(str(e), 2)

    if meta["status"] != "ready":
        return fail(f"start requires status=ready, got {meta['status']!r}", 2)

    rd = metadata.run_dir(cfg, run_id)
    staged = lifecycle.is_staged_run(cfg, run_id)
    # Re-verify pre-impl artifacts. Staged runs fold preflight/assumptions/
    # decisions into plan.md, so only brief.md + plan.md are checked here.
    if staged:
        brief_p = lifecycle.stage_dir(cfg, run_id, "shaping") / "brief.md"
        plan_p = lifecycle.stage_dir(cfg, run_id, "planning") / "plan.md"
        pre_impl = (
            (str(brief_p.relative_to(rd)), brief_p),
            (str(plan_p.relative_to(rd)), plan_p),
        )
    else:
        pre_impl = tuple(
            (n, rd / n)
            for n in ("brief.md", "plan.md", "preflight.md", "assumptions.md", "decisions.md")
        )
    for _label, p in pre_impl:
        if not p.exists() or not p.read_text().strip():
            return fail(f"required pre-impl artifact missing or empty: {p}", 2)

    repo_path = pathlib.Path(meta["target"]["repo"]["path"])
    repo_name = meta["target"]["repo"]["name"]
    base_ref = meta["target"]["repo"]["base_ref"]
    branch_name = meta["target"]["worktree"]["branch_name"]
    worktree_name = meta["target"]["worktree"]["name"]
    already_created = bool(meta["target"]["worktree"].get("created"))

    if already_created:
        # TODO §1A: self-modifying runs created the worktree at new-run time.
        # /start is a state-only transition here. The SHA was resolved at
        # new-run time and lives in metadata already.
        worktree_path = pathlib.Path(meta["target"]["worktree"]["path"])
        base_ref_sha = meta["target"]["repo"].get("base_ref_sha")
    else:
        worktree_path = run_ids.make_worktree_path(
            cfg, repo_name, worktree_name, run_id,
        )

        # Resolve symbolic `base_ref` to a 40-char SHA against the source repo
        # *before* the worktree exists. The captured SHA is what the metrics
        # layer (lib/metrics/lines.py) uses for `<base_ref>..HEAD` ranges; the
        # original symbolic name stays in metadata for human readability.
        try:
            base_ref_sha = repos.resolve_ref_to_sha(repo_path, base_ref)
        except repos.RepoError as e:
            return fail(f"failed to resolve base_ref {base_ref!r}: {e}", 2)

        # Create the worktree.
        try:
            repos.create_worktree(repo_path, branch_name, worktree_path, base_ref)
        except repos.RepoError as e:
            return fail(f"failed to create worktree: {e}", 2)

        # Reflect in metadata.
        def _m(d):
            d["target"]["worktree"]["path"] = str(worktree_path)
            d["target"]["worktree"]["created"] = True
            d["target"]["repo"]["base_ref_sha"] = base_ref_sha
        metadata.update(cfg, run_id, _m)

    # Record the resolution in the audit log so line counts can be
    # re-derived from events.jsonl alone and drift between metadata and the
    # originally-resolved SHA is detectable. Emitted from /start regardless
    # of where the SHA was first computed (new-run for self-modifying, or
    # here for the standard path), so the audit narrative consistently
    # places the event at the ready->building boundary (AC 6).
    if base_ref_sha:
        events.append(
            cfg, run_id, "BaseRefResolved",
            payload={
                "symbolic_ref": base_ref,
                "base_ref_sha": base_ref_sha,
                "source_repo_path": str(repo_path),
            },
            actor=actor,
        )

    # Write build-context.md (TODO §1: curated stage-entry context for the
    # building stage; mirrors validate-context.md). Convenience artifact —
    # failures must not block the transition.
    _write_build_context_artifacts(cfg, run_id, staged)

    # Transition.
    if staged:
        preflight_evidence = str(rd / "stages" / "planning" / "plan.md") + "#preflight"
    else:
        preflight_evidence = str(rd / "preflight.md")
    try:
        with locks.acquire(cfg, run_id):
            transitions.transition(
                cfg, run_id, "building",
                evidence={
                    "approved_by": args.approved_by,
                    "repo_path": str(repo_path),
                    "repo_name": repo_name,
                    "base_ref": base_ref,
                    "branch_name": branch_name,
                    "worktree_name": worktree_name,
                    "worktree_path": str(worktree_path),
                    "preflight_path": preflight_evidence,
                    "repo_mode": meta["target"]["repo"]["mode"],
                },
                actor=actor,
            )
    except transitions.TransitionError as e:
        return fail(str(e), 4)

    print(f"{run_id}: ready -> building")
    print(f"worktree: {worktree_path}")
    return 0


def _write_build_context_artifacts(cfg, run_id: str, staged: bool) -> None:
    """Render `build-context.md` for the building stage. Idempotent. Errors
    are swallowed — this is a convenience artifact; its absence shouldn't
    break the `ready -> building` transition. Mirrors
    `cmd_validate._write_validate_context_artifacts`.
    """
    try:
        # `metadata.update` (above) writes to disk but does not mutate the
        # caller's `meta` dict — it loads its own copy, calls the mutator on
        # that copy, then saves. So the caller's `meta` is stale here; reload
        # to pick up `base_ref_sha`. Re-resolve `rd` for the same reason (self-
        # modifying runs route through `runs.resolve_run_dir_for_meta`).
        meta = metadata.load(cfg, run_id)
        rd = metadata.run_dir(cfg, run_id)
        if staged:
            brief_path = lifecycle.stage_dir(cfg, run_id, "shaping") / "brief.md"
            plan_path = lifecycle.stage_dir(cfg, run_id, "planning") / "plan.md"
            target_dir = lifecycle.stage_dir(cfg, run_id, "building")
        else:
            brief_path = rd / "brief.md"
            plan_path = rd / "plan.md"
            target_dir = rd

        build_template_path = cfg.root / "templates" / "build.md"

        body = build_context.build(
            brief_path=brief_path,
            plan_path=plan_path,
            meta=meta,
            build_template_path=build_template_path,
        )
        build_context.write(target_dir / "build-context.md", body)
    except Exception:
        # Best-effort: never fail the transition over a curation artifact.
        pass
