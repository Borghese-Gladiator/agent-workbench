"""list subcommand. Table of all runs."""
from __future__ import annotations

from lib import metadata
from lib.cli._common import load_config


HELP = "List all runs."


def register(p) -> None:
    p.add_argument("--status", help="Filter to a single status.")


def run(args) -> int:
    cfg = load_config(args)
    rows = []
    for rid in metadata.list_runs(cfg):
        try:
            m = metadata.load(cfg, rid)
        except metadata.MetadataError:
            continue
        if args.status and m["status"] != args.status:
            continue
        rows.append((
            rid,
            m["status"],
            m["target"]["repo"]["name"],
            m["target"]["worktree"]["branch_name"],
            m["updated_at"],
        ))
    if not rows:
        print("(no runs)")
        return 0
    widths = [max(len(str(r[i])) for r in rows + [("run_id","status","repo","branch","updated_at")]) for i in range(5)]
    header = ("run_id","status","repo","branch","updated_at")
    fmt = "  ".join("{:<" + str(w) + "}" for w in widths)
    print(fmt.format(*header))
    print(fmt.format(*["-" * w for w in widths]))
    for r in rows:
        print(fmt.format(*[str(x) for x in r]))
    return 0
