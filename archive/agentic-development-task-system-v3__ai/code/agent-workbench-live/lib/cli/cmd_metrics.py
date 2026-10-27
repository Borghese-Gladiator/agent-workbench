"""metrics subcommand.

Three forms:
  agent-workbench metrics <run-id>          one-run report (plain text)
  agent-workbench metrics <run-id> --json   one-run report (JSON)
  agent-workbench metrics --all             workbench rollup
  agent-workbench metrics --rebuild         regenerate rollup
"""
from __future__ import annotations

import json
import sys

from lib import metadata
from lib.cli._common import fail, load_config, print_json
from lib.metrics import rollup as rollup_mod
from lib.metrics import summary as summary_mod
from lib.metrics import writer as writer_mod


HELP = "Show per-run token + cost metrics, or a workbench-wide rollup."


def register(p) -> None:
    p.add_argument("run_id", nargs="?", default=None)
    p.add_argument("--all", dest="all_runs", action="store_true",
                   help="Print the workbench-wide rollup.")
    p.add_argument("--rebuild", action="store_true",
                   help="Force the workbench rollup to regenerate.")
    p.add_argument("--record", action="store_true",
                   help="(Re)compute metrics.jsonl for the given run from the transcript.")
    p.add_argument("--json", action="store_true",
                   help="Emit JSON instead of plain text.")


def _fmt_int(n: int) -> str:
    if n >= 1_000_000:
        return f"{n/1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n/1_000:.1f}k"
    return str(n)


def _fmt_cost(d: float) -> str:
    return f"${d:.2f}" if d >= 0.01 else f"${d:.4f}"


def _render_summary_plain(s) -> str:
    lines = []
    lines.append(f"run_id:            {s.run_id}")
    lines.append(f"status:            {s.status}")
    lines.append(f"scope_kind:        {s.scope_kind or '(none)'}")
    lines.append("")
    if s.status != "done":
        lines.append(
            "NOTE: acceptance pending — `accepted_*` and `repair_tokens` only "
            "become load-bearing once the run reaches `done` and the branch merges."
        )
        lines.append("")
    lines.append("Token spend:")
    lines.append(f"  total                       {_fmt_int(s.total_tokens):>10} tokens")
    lines.append(f"  input (fresh this turn)     {_fmt_int(s.total_input):>10} tokens")
    lines.append(f"  output (model-generated)    {_fmt_int(s.total_output):>10} tokens")
    lines.append(f"  cache_read (re-read prefix) {_fmt_int(s.total_cache_read):>10} tokens")
    lines.append(f"  cache_creation (first-write){_fmt_int(s.total_cache_creation):>10} tokens")
    lines.append("")
    lines.append("Build progress (agent-side, not human acceptance):")
    if s.tokens_per_passing_build is not None:
        lines.append(
            f"  agent-approved validates    {s.approves}/{s.validate_attempts} "
            f"(tokens / agent-approved validate: {_fmt_int(int(s.tokens_per_passing_build))})"
        )
    else:
        lines.append(f"  agent-approved validates    0/{s.validate_attempts}")
    lines.append(f"  build->validate cycles      {s.attempts_per_success}")
    lines.append(f"  repair tokens               {_fmt_int(s.repair_tokens)} tokens")
    # A7: billable net excludes cache_read so the per-build metric tracks
    # agent efficiency rather than session length.
    if s.billable_net_per_passing_build is not None:
        lines.append(
            f"  billable_net_per_passing_build {_fmt_int(int(s.billable_net_per_passing_build))} tokens"
            f"  (excludes cache_read)"
        )
    # A6: cache misses are turns whose cache_creation crossed 1k.
    lines.append(f"  cache misses                {s.cache_misses}")
    # A8: session-staleness indicator.
    if s.largest_session_turns:
        sid_short = s.largest_session_id[:8] if s.largest_session_id else "?"
        lines.append(
            f"  largest session             {sid_short} ({s.largest_session_turns} turns)"
        )
    lines.append("")
    lines.append("Acceptance (gated on human + merge):")
    if s.merge_commit:
        lines.append(f"  accepted lines              {s.accepted_lines}  (merged at {s.merge_commit[:8]})")
        lines.append(f"  accepted cost               {_fmt_cost(s.cost_accepted_usd)}")
    else:
        lines.append(f"  accepted lines              0  (pending merge)")
        lines.append(f"  accepted cost               $0.0000  (pending merge)")
    lines.append(f"  generated lines (all drafts){s.generated_lines:>4}")
    lines.append(f"  generated cost              {_fmt_cost(s.cost_generated_usd)}")
    lines.append("")
    # A4: three independent bucket sub-sections. v1-run dicts pass through
    # cleanly with empty cache_read / cache_creation maps.
    def _emit_bucket_section(header: str, d: dict) -> None:
        lines.append(f"{header}:")
        items = sorted(d.items(), key=lambda kv: -int(kv[1] or 0))
        if not items or all(int(v or 0) == 0 for _, v in items):
            lines.append("  (no attribution)")
        else:
            for k, v in items:
                lines.append(f"  - {k}: {_fmt_int(int(v or 0))} tokens")
        lines.append("")

    _emit_bucket_section("input buckets", s.bucket_totals)
    _emit_bucket_section("cache_read buckets", s.cache_read_by_bucket)
    _emit_bucket_section("cache_creation buckets", s.cache_creation_by_bucket)
    if s.tokens_by_stage:
        lines.append("by stage:")
        for st, n in sorted(s.tokens_by_stage.items(), key=lambda kv: -kv[1]):
            lines.append(f"  {st:<14}  {_fmt_int(n)}")
        lines.append("")
    if s.tokens_by_command:
        lines.append("by command:")
        for c, n in sorted(s.tokens_by_command.items(), key=lambda kv: -kv[1]):
            lines.append(f"  {c or '(none)':<14}  {_fmt_int(n)}")
    return "\n".join(lines)


def _render_rollup_plain(idx: dict) -> str:
    totals = idx.get("totals") or {}
    lines = []
    lines.append("workbench rollup")
    lines.append("================")
    lines.append(f"generated_at:        {idx.get('generated_at', '?')}")
    lines.append(f"runs:                {totals.get('runs', 0)}")
    lines.append(f"validated_runs:      {totals.get('validated_runs', 0)}")
    rate = totals.get("first_pass_build_rate")
    if rate is None:
        lines.append(f"first_pass_rate:     n/a (no validated runs)")
    else:
        lines.append(f"first_pass_rate:     {rate*100:.1f}% ({totals.get('first_pass_count', 0)}/{totals.get('validated_runs', 0)})")
    lines.append(f"total_tokens:        {_fmt_int(totals.get('total_tokens', 0))}")
    lines.append(f"cost_generated:      {_fmt_cost(totals.get('cost_generated_usd', 0))}")
    lines.append(f"cost_accepted:       {_fmt_cost(totals.get('cost_accepted_usd', 0))}")
    lines.append("")
    by_scope = idx.get("by_scope") or {}
    if by_scope:
        lines.append("by scope:")
        for k, v in sorted(by_scope.items()):
            r = v.get("first_pass_rate")
            rate_str = f"{r*100:.1f}%" if r is not None else "n/a"
            lines.append(
                f"  {k:<16} runs={v.get('runs',0)}  validated={v.get('validated',0)}  "
                f"first_pass={rate_str}  cost_gen={_fmt_cost(v.get('cost_generated_usd',0))}"
            )
        lines.append("")
    lb = idx.get("leaderboard") or []
    if lb:
        lines.append("leaderboard (worst tokens/passing build first):")
        for r in lb[:10]:
            tpb = r.get("tokens_per_passing_build")
            tpb_str = _fmt_int(int(tpb)) if tpb is not None else "n/a"
            lines.append(
                f"  {r['run_id']:<48} tpb={tpb_str}  cost={_fmt_cost(r.get('cost_generated_usd',0))}  "
                f"attempts={r.get('attempts_per_success',0)}"
            )
    monthly = idx.get("monthly_cost_generated_usd") or {}
    if monthly:
        lines.append("")
        lines.append("monthly cost (generated):")
        for k, v in monthly.items():
            lines.append(f"  {k}  {_fmt_cost(v)}")
    return "\n".join(lines)


def run(args) -> int:
    cfg = load_config(args)

    if args.rebuild and not args.all_runs and not args.run_id:
        idx = rollup_mod.rebuild(cfg)
        print(f"rebuilt: {idx}")
        return 0

    if args.all_runs:
        if args.rebuild:
            rollup_mod.rebuild(cfg)
        idx = rollup_mod.load(cfg)
        if idx is None:
            idx = json.loads(rollup_mod.rebuild(cfg).read_text())
        if args.json:
            print_json(idx)
        else:
            print(_render_rollup_plain(idx))
        return 0

    if not args.run_id:
        return fail("usage: agent-workbench metrics <run-id> | --all | --rebuild", 2)

    # Single-run report.
    try:
        metadata.load(cfg, args.run_id)
    except metadata.MetadataError as e:
        return fail(str(e), 2)

    if args.record:
        writer_mod.record_run_metrics(cfg, args.run_id)

    try:
        s = summary_mod.summarize(cfg, args.run_id)
    except FileNotFoundError as e:
        return fail(str(e), 2)
    if args.json:
        print_json(s.to_dict())
    else:
        print(_render_summary_plain(s))
    return 0
