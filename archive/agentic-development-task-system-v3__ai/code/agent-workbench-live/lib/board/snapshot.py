"""BoardSnapshot: a frozen view of every run grouped by lifecycle column.

Rebuilt from disk on every tick of the Textual app. The on-disk dataset is
small (tens of runs); re-reading everything is the bargain we make to
guarantee the visible state matches what's on disk.
"""
from __future__ import annotations

import dataclasses
import datetime as dt

from lib import runs as runs_mod
from lib.board import source
from lib.board.source import (
    COLUMN_ORDER,
    TERMINAL_STATES,
    RunSnapshot,
    is_loud,
    stale_threshold_seconds,
)
from lib.config import Config


@dataclasses.dataclass(frozen=True)
class KanbanColumn:
    status: str
    runs: tuple[RunSnapshot, ...]

    @property
    def count(self) -> int:
        return len(self.runs)

    @property
    def has_loud_card(self) -> bool:
        return any(is_loud(r) for r in self.runs)


@dataclasses.dataclass(frozen=True)
class BoardSnapshot:
    now: dt.datetime
    columns: tuple[KanbanColumn, ...]

    @property
    def total_runs(self) -> int:
        return sum(c.count for c in self.columns)

    def visible_columns(self) -> tuple[KanbanColumn, ...]:
        """Columns that should be drawn — drops empty ones with no runs."""
        return tuple(c for c in self.columns if c.runs)


def build(
    cfg: Config,
    *,
    show_all: bool = False,
    only_status: str | None = None,
    now: dt.datetime | None = None,
) -> BoardSnapshot:
    """Walk runs/, group by status, return a frozen snapshot.

    Filtering:
      - if `only_status` is set, every other column is empty (column kept
        in the output so the canonical order is stable).
      - otherwise terminal states (done, abandoned) are dropped unless
        `show_all` is True.
    """
    now = now or dt.datetime.now().astimezone()
    stale_seconds = stale_threshold_seconds(cfg)

    grouped: dict[str, list[RunSnapshot]] = {s: [] for s in COLUMN_ORDER}
    # Iterate `Run` objects directly so we can hand each pre-resolved
    # (run_dir + parsed metadata) to load_run_snapshot. Calling
    # metadata.list_runs + metadata.load would walk every worktree twice per
    # run; the profile that motivated this change attributed ~10s of every
    # 14s snapshot to that re-walk.
    for run in runs_mod.iter_all_runs(cfg):
        snap = source.load_run_snapshot(
            cfg,
            run.run_id,
            now=now,
            stale_human_review_seconds=stale_seconds,
            pre_resolved=run,
        )
        if snap is None:
            continue
        if snap.status not in grouped:
            continue
        if only_status and snap.status != only_status:
            continue
        if not only_status and not show_all and snap.status in TERMINAL_STATES:
            continue
        grouped[snap.status].append(snap)

    # Stable within-column ordering: oldest-update-first floats to the top,
    # so the runs that have sat the longest demand attention.
    for runs in grouped.values():
        runs.sort(key=lambda r: -r.age_seconds)

    columns = tuple(
        KanbanColumn(status=s, runs=tuple(grouped[s])) for s in COLUMN_ORDER
    )
    return BoardSnapshot(now=now, columns=columns)


def format_age(seconds: float) -> str:
    """Largest unit >= 1 (m/h/d), integer. <1m shown as 0m.

    Kept on the snapshot module so the static fallback (cmd_board --static)
    and the Textual renderer share the same formatter.
    """
    s = max(0, int(seconds))
    minutes = s // 60
    if minutes < 60:
        return f"{minutes}m"
    hours = minutes // 60
    if hours < 24:
        return f"{hours}h"
    return f"{hours // 24}d"
