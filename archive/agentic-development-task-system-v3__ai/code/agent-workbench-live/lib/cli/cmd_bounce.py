"""bounce subcommand. human_review -> building."""
from __future__ import annotations

from pathlib import Path

from lib import metadata, transitions, locks, lifecycle
from lib.cli._common import actor_from_env, fail, load_config


HELP = "Bounce a run from human_review back to building."


def register(p) -> None:
    p.add_argument("run_id")
    p.add_argument("--reason", required=True)
    p.add_argument("--requested-by", required=True)
    p.add_argument(
        "--change-request-path",
        default=None,
        help="Path to change-request.md artifact written by /bounce slash command.",
    )


def run(args) -> int:
    cfg = load_config(args)
    actor = actor_from_env("human")
    actor["name"] = args.requested_by
    run_id = args.run_id

    try:
        meta = metadata.load(cfg, run_id)
    except metadata.MetadataError as e:
        return fail(str(e), 2)

    if meta["status"] != "human_review":
        return fail(f"bounce requires status=human_review, got {meta['status']!r}", 2)

    rd = metadata.run_dir(cfg, run_id)
    staged = lifecycle.is_staged_run(cfg, run_id)
    handoff_path = rd / ("HUMAN_REVIEW.md" if staged else "handoff.md")

    evidence = {
        "bounce_reason": args.reason,
        "requested_by": args.requested_by,
        "handoff_path": str(handoff_path),
    }

    if args.change_request_path:
        cr_path = Path(args.change_request_path)
        if not cr_path.is_absolute():
            cr_path = (Path.cwd() / cr_path).resolve()
        if not cr_path.exists():
            return fail(f"change-request file not found: {cr_path}", 2)
        if cr_path.stat().st_size == 0:
            return fail(f"change-request file is empty: {cr_path}", 2)
        evidence["change_request_path"] = str(cr_path)

    try:
        with locks.acquire(cfg, run_id):
            # On staged runs, supersede prior building/validating outputs
            # into archive/ before letting the rebuild start.
            if staged:
                lifecycle.archive_for_bounce(cfg, run_id)
            transitions.transition(
                cfg, run_id, "building",
                evidence=evidence,
                actor=actor,
            )
    except transitions.TransitionError as e:
        return fail(str(e), 4)

    print(f"{run_id}: human_review -> building")
    print(f"reason: {args.reason}")
    if args.change_request_path:
        print(f"change-request: {evidence['change_request_path']}")
    return 0
