"""show subcommand. Pretty-print metadata + artifact paths."""
from __future__ import annotations

from lib import metadata
from lib.cli._common import fail, load_config


HELP = "Show metadata and artifact paths for one run."


def register(p) -> None:
    p.add_argument("run_id")


def run(args) -> int:
    cfg = load_config(args)
    try:
        meta = metadata.load(cfg, args.run_id)
    except metadata.MetadataError as e:
        return fail(str(e), 2)
    rd = metadata.run_dir(cfg, args.run_id)
    print(f"run_id:     {meta['run_id']}")
    print(f"status:     {meta['status']}")
    print(f"created:    {meta['created_at']}")
    print(f"updated:    {meta['updated_at']}")
    print()
    print("target:")
    print(f"  repo.mode:      {meta['target']['repo']['mode']}")
    print(f"  repo.path:      {meta['target']['repo']['path']}")
    print(f"  repo.name:      {meta['target']['repo']['name']}")
    print(f"  repo.base_ref:  {meta['target']['repo']['base_ref']}")
    print(f"  worktree.name:  {meta['target']['worktree']['name']}")
    print(f"  worktree.path:  {meta['target']['worktree']['path']}")
    print(f"  branch_name:    {meta['target']['worktree']['branch_name']}")
    print()
    print("artifacts:")
    for k, v in (meta.get("artifacts") or {}).items():
        if v is None:
            print(f"  {k:<24} (not produced)")
        else:
            full = rd / v
            exists = "OK" if full.exists() else "MISSING"
            print(f"  {k:<24} {v} [{exists}]")
    print()
    build = meta.get("build")
    if build:
        print("build:")
        for k, v in build.items():
            print(f"  {k:<24} {v}")
        print()
    print("validation:")
    for k, v in (meta.get("validation") or {}).items():
        print(f"  {k:<24} {v}")
    print()
    print("completion:")
    for k, v in (meta.get("completion") or {}).items():
        print(f"  {k:<24} {v}")
    return 0
