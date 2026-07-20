"""board subcommand. Live Textual TUI over runs/.

The default behaviour is the live board (`lib.board.app.AgentBoardApp`),
which auto-refreshes via watchdog + a 1Hz fallback. This requires the
optional `textual` + `watchdog` dependencies. Install with:

    pip install -r requirements-board.txt

Run `agent-workbench board --static` for the stdlib-only one-shot text
render. CI and headless callers should use that path.
"""
from __future__ import annotations

from lib.cli._common import fail, load_config


HELP = "Live task board: Kanban over runs/, refreshes on every file change."


def register(p) -> None:
    p.add_argument(
        "--all",
        action="store_true",
        help="Include terminal states (done, abandoned).",
    )
    p.add_argument(
        "--status",
        help="Show only this status column.",
    )
    p.add_argument(
        "--compact",
        action="store_true",
        help="One-line cards. Useful in narrow terminals.",
    )
    p.add_argument(
        "--verbose",
        action="store_true",
        help="Show the run/wt paths band on each card (off by default).",
    )
    p.add_argument(
        "--static",
        action="store_true",
        help="Print a one-shot stdlib-only text render and exit (no TUI).",
    )


def _static_render(
    cfg, *, show_all: bool, only_status: str | None, compact: bool, show_paths: bool,
) -> int:
    """Stdlib-only one-shot text render. No textual import."""
    from lib.board import snapshot as snapshot_mod
    from lib.board.snapshot import format_age
    from lib.board.source import COLUMN_SUBTITLES, severity, SEVERITY_BLOCKING, SEVERITY_WARNING

    snap = snapshot_mod.build(cfg, show_all=show_all, only_status=only_status)
    visible = snap.visible_columns()
    if not visible:
        print("(no runs)")
        return 0

    column_width = 42
    gutter = "  "

    def pad(s: str, w: int) -> str:
        s = s if len(s) <= w else (s[: w - 1] + "…")
        return s + " " * (w - len(s))

    # Header band: status name + (count) + optional severity marker.
    def _col_marker(col) -> str:
        worst = ""
        for r in col.runs:
            sv = severity(r)
            if sv == SEVERITY_BLOCKING:
                worst = SEVERITY_BLOCKING
                break
            if sv == SEVERITY_WARNING:
                worst = SEVERITY_WARNING
        return " ✕" if worst == SEVERITY_BLOCKING else (" ⚠" if worst == SEVERITY_WARNING else "")

    header = gutter.join(pad(c.status, column_width) for c in visible)
    counts = gutter.join(
        pad(f"({c.count}){_col_marker(c)}", column_width) for c in visible
    )
    subtitle = gutter.join(
        pad(COLUMN_SUBTITLES.get(c.status, ""), column_width) for c in visible
    )
    rule = gutter.join("-" * column_width for _ in visible)
    print(header.rstrip())
    print(counts.rstrip())
    print(subtitle.rstrip())
    print(rule)

    workbench_root = str(cfg.root)

    if compact:
        column_lines: list[list[list[str]]] = [
            [[_static_card_line(r, 0, compact=True)] for r in c.runs]
            for c in visible
        ]
    else:
        column_lines = [
            [_static_card_stack(r, workbench_root=workbench_root, show_paths=show_paths)
             for r in c.runs]
            for c in visible
        ]

    max_cards = max(c.count for c in visible) if visible else 0
    for i in range(max_cards):
        per_column_card_lines: list[list[str]] = []
        for col_idx in range(len(visible)):
            cards = column_lines[col_idx]
            per_column_card_lines.append(cards[i] if i < len(cards) else [])
        stack_height = max((len(lines) for lines in per_column_card_lines), default=0)
        for line_idx in range(stack_height):
            row_pieces = []
            for lines in per_column_card_lines:
                line = lines[line_idx] if line_idx < len(lines) else ""
                row_pieces.append(pad(line, column_width))
            print(gutter.join(row_pieces).rstrip())
        if i + 1 < max_cards:
            print(gutter.join(pad("", column_width) for _ in visible).rstrip())

    # Stale human_review footer preserved from the v0 contract.
    stale = [
        r for c in visible
        for r in c.runs
        if r.is_stale_human_review
    ]
    if stale:
        print()
        print("Stale human_review:")
        for r in stale:
            print(f"  ✕ {r.run_id}  ({format_age(r.age_seconds)})")
    return 0


def _static_card_line(run, line_idx: int, *, compact: bool) -> str:
    """Compact one-liner (used in --compact mode only)."""
    from lib.board.snapshot import format_age
    from lib.board.source import (
        severity, SEVERITY_BLOCKING, SEVERITY_WARNING, severity_reason,
        SOURCE_MASTER,
    )

    sv = severity(run)
    marker = ""
    if sv == SEVERITY_BLOCKING:
        marker = "✕ "
    elif sv == SEVERITY_WARNING:
        marker = "⚠ "
    title = run.run_id
    if run.source == SOURCE_MASTER and run.status in ("done", "abandoned"):
        title += " (archived)"
    bits = [marker + title, format_age(run.age_seconds)]
    if run.repo_name:
        bits.append(run.repo_name)
    if run.is_live:
        bits.append("live")
    reason = severity_reason(run)
    if reason:
        bits.append(reason)
    return " · ".join(bits)


def _format_event_ts_static(seconds: float) -> str:
    """Stdlib mirror of app._format_event_ts."""
    from lib.board.snapshot import format_age

    s = max(0, int(seconds))
    if s < 60 * 100:
        mins, secs = divmod(s, 60)
        return f"[{mins:02d}:{secs:02d} ago]"
    return f"[{format_age(seconds):>5} ago]"


def _static_card_stack(
    run, *, workbench_root: str | None = None, show_paths: bool = False,
) -> list[str]:
    """Status-aware stack of lines for the non-compact static renderer.

    Bands: title / meta / body / events / files. Each band is separated by
    a single ``---`` line (the static renderer can't draw ─ guaranteed-
    width inside a padded grid, so plain dashes). The Textual path uses
    proper Unicode rules.
    """
    from lib.board.snapshot import format_age
    from lib.board.source import (
        SEVERITY_BLOCKING,
        SEVERITY_WARNING,
        abbreviate_path,
        severity,
        severity_reason,
    )

    sv = severity(run)
    marker = ""
    if sv == SEVERITY_BLOCKING:
        marker = "✕ "
    elif sv == SEVERITY_WARNING:
        marker = "⚠ "
    lines: list[str] = []

    # --- Title band
    from lib.board.source import SOURCE_MASTER
    head = f"{marker}{run.run_id}  [{run.status}]"
    if run.source == SOURCE_MASTER and run.status in ("done", "abandoned"):
        head += "  (archived)"
    if run.scope_kind:
        head += f"  {run.scope_kind}"
    if run.is_live:
        head += "  live"
    lines.append(head)

    rule = "-" * 38

    # --- Meta band
    meta_pieces: list[str] = []
    if run.time_in_stage_seconds is not None:
        meta_pieces.append(f"{format_age(run.time_in_stage_seconds)} in stage")
    meta_pieces.append(f"{format_age(run.age_seconds)} since update")
    if run.total_age_seconds > run.age_seconds + 1:
        meta_pieces.append(f"{format_age(run.total_age_seconds)} total")
    if run.repo_name:
        meta_pieces.append(run.repo_name)
    if run.branch_name:
        meta_pieces.append(run.branch_name)
    lines.append(rule)
    lines.append(" · ".join(meta_pieces))

    # --- Body band
    body: list[str] = []
    reason = severity_reason(run)
    if reason and sv == SEVERITY_BLOCKING:
        body.append(f"✕ {reason}")
    elif reason and sv == SEVERITY_WARNING:
        body.append(f"⚠ {reason}")

    if run.status == "building":
        if run.build_iterations is not None and run.build_max_iterations:
            body.append(f"build {run.build_iterations}/{run.build_max_iterations}")
        if run.avg_iteration_seconds is not None:
            body.append(f"avg {format_age(run.avg_iteration_seconds)}/iter")
        if run.bounced_from:
            age = (
                format_age(run.bounced_at_age_seconds)
                if run.bounced_at_age_seconds is not None else "?"
            )
            body.append(f"bounced from {run.bounced_from} · {age} ago")
        if run.diff_files:
            body.append(
                f"+{run.diff_added or 0}/-{run.diff_removed or 0} "
                f"across {run.diff_files} files"
            )
    elif run.status == "validating":
        tp = run.tests_passed
        mark = "?" if tp is None else ("✓" if tp else "✗")
        ts_line = f"tests {mark}"
        if run.tests_recorded_age_seconds is not None:
            ts_line += f" · {format_age(run.tests_recorded_age_seconds)} ago"
        body.append(
            f"{ts_line}  rev {'✓' if run.review_completed else '·'}"
            f"  qa {'✓' if run.qa_completed else '·'}"
        )
        if run.ac_total is not None:
            tag = " !" if (
                run.ac_covered is not None
                and run.ac_total > 0
                and run.ac_covered < run.ac_total
            ) else ""
            body.append(f"{run.ac_covered}/{run.ac_total} ACs covered{tag}")
        elif run.ac_table_missing:
            body.append("AC table missing")
        if run.has_known_issues:
            body.append(f"known_issues: {run.known_issues_count}")
        if run.diff_files:
            body.append(
                f"+{run.diff_added or 0}/-{run.diff_removed or 0} "
                f"across {run.diff_files} files"
            )
    elif run.status == "followups":
        if run.followups_entry_count is not None:
            body.append(f"{run.followups_entry_count} follow-ups")
        for cat, count in run.followups_categories:
            body.append(f"  {count} {cat}")
    elif run.status == "human_review":
        if run.bounce_count:
            body.append(f"bounces: {run.bounce_count}")
        if run.followups_entry_count is not None:
            body.append(f"{run.followups_entry_count} follow-ups")
        for cat, count in run.followups_categories:
            body.append(f"  {count} {cat}")
    elif run.status == "done":
        if run.accepted_by or run.completed_at:
            who = run.accepted_by or "?"
            when = (run.completed_at or "")[11:16]
            body.append(f"accepted_by {who} · {when}")
    elif run.status == "abandoned":
        if run.abandoned_reason:
            body.append(f"abandoned: {run.abandoned_reason}")

    if body:
        lines.append(rule)
        lines.extend(body)

    # --- Events band
    if run.recent_events:
        lines.append(rule)
        for ev in run.recent_events:
            ts = _format_event_ts_static(ev.age_seconds)
            detail = f" {ev.detail}" if ev.detail else ""
            lines.append(f"{ts:<11} {ev.type}{detail}")

    # --- Files band (gated)
    if show_paths and (run.run_dir or run.worktree_path):
        lines.append(rule)
        if run.run_dir:
            lines.append(f"  run  {abbreviate_path(run.run_dir, workbench_root=workbench_root)}")
        if run.worktree_path:
            lines.append(f"  wt   {abbreviate_path(run.worktree_path, workbench_root=workbench_root)}")
    return lines


def run(args) -> int:
    cfg = load_config(args)

    if args.static:
        return _static_render(
            cfg,
            show_all=bool(args.all),
            only_status=args.status,
            compact=bool(args.compact),
            show_paths=bool(args.verbose),
        )

    # Live TUI. Lazy-import: keep the rest of the CLI stdlib-only.
    try:
        from lib.board.app import AgentBoardApp, BoardOptions
    except ImportError as e:
        return fail(
            "live board needs `textual` and `watchdog`. install with:\n"
            "    pip install -r requirements-board.txt\n"
            f"(import failed: {e})\n"
            "Use `agent-workbench board --static` for the stdlib-only fallback."
        )

    opts = BoardOptions(
        show_all=bool(args.all),
        only_status=args.status,
        compact=bool(args.compact),
        show_paths=bool(args.verbose),
    )
    AgentBoardApp(cfg, opts).run()
    return 0
