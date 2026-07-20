"""events subcommand. Tail events.jsonl for a run."""
from __future__ import annotations

import json

from lib import events as events_mod
from lib.cli._common import fail, load_config


HELP = "List events for one run."


def register(p) -> None:
    p.add_argument("run_id")
    p.add_argument("--type", help="Filter to a single event type.")
    p.add_argument("--raw", action="store_true", help="Print each event as JSON.")


def run(args) -> int:
    cfg = load_config(args)
    try:
        events = list(events_mod.iter_events(cfg, args.run_id))
    except Exception as e:
        return fail(str(e), 2)
    if args.type:
        events = [e for e in events if e.get("type") == args.type]
    if not events:
        print("(no events)")
        return 0
    if args.raw:
        for e in events:
            print(json.dumps(e))
        return 0
    for e in events:
        actor = e.get("actor") or {}
        actor_label = f"{actor.get('type','?')}:{actor.get('name','?')}"
        flow = ""
        if e.get("type") == "TransitionApplied":
            flow = f"  {e.get('from')} -> {e.get('to')}"
        elif e.get("type") == "TransitionRejected":
            flow = f"  {e.get('from')} -X-> {e.get('to')}  ({(e.get('payload') or {}).get('reason')})"
        print(f"seq={e['seq']:<4} {e['at']}  {e['type']:<28}  status={e['status']:<14} actor={actor_label}{flow}")
    return 0
