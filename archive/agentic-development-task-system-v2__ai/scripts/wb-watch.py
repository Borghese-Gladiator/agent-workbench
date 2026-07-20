#!/usr/bin/env python3
"""wb-watch.py — read-only watch-mode TUI dashboard for ai-workbench.

Polls `runs/*/metadata.yaml + events.jsonl` on a timer (default 2s) and
renders a single-screen layout:

  ┌─ runs ──────────────────────────────────────────────────────────────┐
  │ run_id                          status        age   last event   PR │
  │ 2026-05-14-foo-001              in_progress   2h    create-wt    -  │
  │ ...                                                                  │
  └──────────────────────────────────────────────────────────────────────┘

  [drill-down for the selected run]
    feature_slug, repo, branch, worktree, evidence pending (if any)
    events (last 5):
      ...

Keybindings:
  ↑ / k       move selection up
  ↓ / j       move selection down
  r           force a refresh now (otherwise auto-refresh on the timer)
  q / Esc     quit

Stdlib only — no rich, no PyYAML. Uses curses; same dependency surface as
the other workbench scripts.

Usage:
  ./scripts/wb-watch.py            # 2s refresh
  ./scripts/wb-watch.py --interval 5
"""

from __future__ import annotations

import argparse
import curses
import json
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
WORKBENCH_ROOT = SCRIPT_DIR.parent
sys.path.insert(0, str(WORKBENCH_ROOT))

# Import lazily after sys.path is set so the script is portable.
from lib import _yaml  # noqa: E402
from lib.metadata import Metadata, load as load_metadata  # noqa: E402
from lib.events import Event, read_all as read_events  # noqa: E402
from lib.transitions import EVIDENCE, ANY_NON_TERMINAL  # noqa: E402


@dataclass
class RunRow:
    run_id: str
    metadata: Metadata
    events: list[Event]
    last_event: Event | None
    age_seconds: float


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _parse_iso(ts: str) -> datetime | None:
    if not ts:
        return None
    try:
        # Strip trailing Z and parse as UTC.
        return datetime.strptime(ts.rstrip("Z"), "%Y-%m-%dT%H:%M:%S").replace(
            tzinfo=timezone.utc
        )
    except ValueError:
        return None


def _format_age(seconds: float) -> str:
    if seconds < 60:
        return f"{int(seconds)}s"
    if seconds < 3600:
        return f"{int(seconds / 60)}m"
    if seconds < 86400:
        return f"{int(seconds / 3600)}h"
    return f"{int(seconds / 86400)}d"


def _short_actor(actor: str) -> str:
    """Compress actors like 'script:create-worktree.sh' or 'slash:normalize'
    into a short label for table use."""
    if not actor:
        return ""
    if ":" in actor:
        kind, name = actor.split(":", 1)
        name = name.removesuffix(".sh").removesuffix(".py")
        return name
    return actor


def _evidence_pending(md: Metadata) -> str:
    """What evidence keys would be required to advance from the run's current
    state? Returns a one-line summary like 'in_progress → in_review: pr_url'
    or '' if the run is terminal or has no canonical next edge.
    """
    if md.status in ("merged", "abandoned"):
        return ""
    # Pick the canonical forward edge for each state.
    canonical: dict[str, str] = {
        "draft": "normalize",
        "normalize": "brainstorm",
        "brainstorm": "ready",
        "ready": "in_progress",
        "planned": "in_progress",
        "in_progress": "in_review",
        "in_review": "qa",
        "qa": "merged",
        "investigating": "investigated",
        "investigated": "merged",
    }
    nxt = canonical.get(md.status)
    if not nxt:
        return ""
    req = EVIDENCE.get((md.status, nxt))
    if req is None:
        return ""
    keys = ", ".join(req.keys) if req.keys else "(none)"
    return f"{md.status} → {nxt}: {keys}"


def collect_rows(runs_dir: Path) -> list[RunRow]:
    rows: list[RunRow] = []
    now = _now_utc()
    if not runs_dir.is_dir():
        return rows
    for entry in sorted(runs_dir.iterdir()):
        if not entry.is_dir():
            continue
        meta_path = entry / "metadata.yaml"
        if not meta_path.exists():
            continue
        try:
            md = load_metadata(entry)
        except Exception:
            continue
        try:
            events = read_events(entry)
        except Exception:
            events = []
        last = events[-1] if events else None
        # Age from last event's created_at; fall back to metadata.updated_at.
        ts_str = (last.created_at if last else "") or md.updated_at or md.created_at
        ts = _parse_iso(ts_str)
        age_seconds = (now - ts).total_seconds() if ts else 0.0
        rows.append(RunRow(
            run_id=md.run_id or entry.name,
            metadata=md,
            events=events,
            last_event=last,
            age_seconds=age_seconds,
        ))
    return rows


def _safe_addstr(stdscr, y: int, x: int, text: str, attr=0):
    """addstr that swallows overflow at screen edges."""
    h, w = stdscr.getmaxyx()
    if y < 0 or y >= h or x >= w:
        return
    # Truncate to fit the line.
    space = max(0, w - x - 1)
    if space <= 0:
        return
    try:
        stdscr.addnstr(y, x, text, space, attr)
    except curses.error:
        pass


def _draw_header(stdscr, refreshed_at: datetime, interval: float, run_count: int):
    h, w = stdscr.getmaxyx()
    title = f"ai-workbench — {refreshed_at.strftime('%Y-%m-%d %H:%M:%S')} UTC"
    hint = f"runs:{run_count}  refresh:{interval:g}s  [↑/↓ select] [r refresh] [q quit]"
    _safe_addstr(stdscr, 0, 0, title, curses.A_BOLD)
    if w - len(hint) - 1 > len(title):
        _safe_addstr(stdscr, 0, w - len(hint) - 1, hint)


def _draw_table(stdscr, rows: list[RunRow], selected_idx: int, top_row: int = 2):
    """Returns the row index where the table ends."""
    h, w = stdscr.getmaxyx()
    header = f"{'run_id':<38}  {'status':<14} {'type':<10} {'age':>5}  {'last event':<22} {'PR'}"
    _safe_addstr(stdscr, top_row, 0, header, curses.A_UNDERLINE)
    y = top_row + 1
    # Reserve bottom 10 lines for drill-down + footer.
    max_table_rows = max(1, h - top_row - 12)
    visible_rows = rows[:max_table_rows]
    for i, row in enumerate(visible_rows):
        md = row.metadata
        attr = curses.A_REVERSE if i == selected_idx else 0
        last_event_label = ""
        if row.last_event:
            last_event_label = (
                f"{row.last_event.event_type}/{_short_actor(row.last_event.actor)}"
            )
        pr = md.pr_number or "-"
        line = (
            f"{row.run_id:<38}  "
            f"{md.status:<14} "
            f"{md.run_type:<10} "
            f"{_format_age(row.age_seconds):>5}  "
            f"{last_event_label:<22} "
            f"{pr}"
        )
        _safe_addstr(stdscr, y, 0, line, attr)
        y += 1
    if len(rows) > len(visible_rows):
        _safe_addstr(
            stdscr, y, 0,
            f"  ... {len(rows) - len(visible_rows)} more (resize terminal to see all)",
            curses.A_DIM,
        )
        y += 1
    return y


def _draw_drilldown(stdscr, row: RunRow, start_y: int):
    h, w = stdscr.getmaxyx()
    md = row.metadata
    _safe_addstr(stdscr, start_y, 0, "─" * (w - 1), curses.A_DIM)
    y = start_y + 1
    _safe_addstr(stdscr, y, 0, f"selected: {row.run_id}", curses.A_BOLD)
    y += 1
    info_lines = [
        f"  feature_slug:    {md.feature_slug}",
        f"  repo:            {md.repo_key}  ({md.github_repo})",
        f"  branch:          {md.branch_name}",
        f"  worktree:        {md.worktree_path or '(not created)'}",
    ]
    if md.project_subpath:
        info_lines.append(
            f"  project_subpath: {md.project_subpath} → project_dir: {md.project_dir()}"
        )
    if md.parent_run_id:
        info_lines.append(f"  parent_run_id:   {md.parent_run_id}")
    if md.pr_url:
        info_lines.append(f"  pr:              {md.pr_url}")
    pending = _evidence_pending(md)
    if pending:
        info_lines.append(f"  evidence needed: {pending}")
    for line in info_lines:
        _safe_addstr(stdscr, y, 0, line)
        y += 1

    # Events tail.
    y += 1
    _safe_addstr(stdscr, y, 0, "  events (most recent first):", curses.A_BOLD)
    y += 1
    tail = list(reversed(row.events))[:5]
    for ev in tail:
        _safe_addstr(
            stdscr, y, 0,
            f"    {ev.created_at}  {ev.event_type:<22} {_short_actor(ev.actor)}"
        )
        y += 1


def render(stdscr, rows: list[RunRow], selected_idx: int, interval: float):
    stdscr.erase()
    _draw_header(stdscr, _now_utc(), interval, len(rows))
    if not rows:
        _safe_addstr(stdscr, 3, 0, "(no runs yet — try ./scripts/new-feature.sh)")
        stdscr.refresh()
        return
    selected_idx = max(0, min(selected_idx, len(rows) - 1))
    table_bottom = _draw_table(stdscr, rows, selected_idx)
    _draw_drilldown(stdscr, rows[selected_idx], table_bottom + 1)
    stdscr.refresh()


def loop(stdscr, runs_dir: Path, interval: float):
    curses.curs_set(0)
    stdscr.nodelay(True)  # getch returns -1 if no input
    selected = 0
    last_poll = 0.0
    rows: list[RunRow] = []
    while True:
        now = time.monotonic()
        if now - last_poll >= interval:
            rows = collect_rows(runs_dir)
            last_poll = now
            render(stdscr, rows, selected, interval)
        ch = stdscr.getch()
        if ch == -1:
            # No keypress; idle briefly to avoid a busy loop.
            time.sleep(0.05)
            continue
        if ch in (ord("q"), 27):  # q or Esc
            return
        if ch == ord("r"):
            rows = collect_rows(runs_dir)
            last_poll = time.monotonic()
            render(stdscr, rows, selected, interval)
        elif ch in (curses.KEY_UP, ord("k")):
            selected = max(0, selected - 1)
            render(stdscr, rows, selected, interval)
        elif ch in (curses.KEY_DOWN, ord("j")):
            selected = min(max(0, len(rows) - 1), selected + 1)
            render(stdscr, rows, selected, interval)
        elif ch == curses.KEY_RESIZE:
            render(stdscr, rows, selected, interval)


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument(
        "--interval", type=float, default=2.0,
        help="poll interval in seconds (default: 2.0)",
    )
    p.add_argument(
        "--runs-dir", type=Path, default=WORKBENCH_ROOT / "runs",
        help="path to the runs directory (default: <workbench>/runs)",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    if not args.runs_dir.exists():
        print(f"error: runs directory not found: {args.runs_dir}", file=sys.stderr)
        return 1
    try:
        curses.wrapper(loop, args.runs_dir, args.interval)
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
