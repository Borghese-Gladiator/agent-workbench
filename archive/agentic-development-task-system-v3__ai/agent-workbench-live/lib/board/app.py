"""Textual app rendering the live Agent Workbench board.

Imports Textual + watchdog (the only third-party deps in the workbench).
Module-level imports are intentional — `cmd_board` imports this module
lazily so the rest of the CLI stays stdlib-only.

Refresh model:
  - A watchdog Observer fires on every filesystem change under runs/.
    Each event posts a Textual message that triggers a snapshot rebuild.
  - A 1Hz fallback timer rebuilds the snapshot regardless. This keeps the
    age tickers moving even when nothing changed and rescues us if a
    filesystem doesn't deliver inotify-equivalent events.

The app does not maintain a stateful in-memory model of runs; every refresh
re-reads disk via lib/board/snapshot.build. Cheap and correct trumps subtle.

Card layout (non-compact):
  title    — slug (bright) + dim date prefix + state badge + scope + live
  meta     — age-in-stage · total age · repo · branch (dim)
  body     — status-specific progress (build bar, tests/rev/qa, follow-ups, …)
  events   — last 3 events, column-aligned timestamps
  files    — labelled, abbreviated run / wt paths (off by default; --verbose)

Bands are separated by ─ horizontal rules. Each band answers one question;
the eye stops looking once it has the answer.
"""
from __future__ import annotations

import dataclasses
import datetime as dt
import time
from typing import Iterable

from rich.text import Text
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, ScrollableContainer, Vertical
from textual.message import Message
from textual.widgets import Footer, Header, Static
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from lib import runs as runs_mod
from lib.board import snapshot as snapshot_mod
from lib.board.snapshot import format_age
from lib.board.source import (
    COLUMN_ORDER,
    COLUMN_SUBTITLES,
    SEVERITY_BLOCKING,
    SEVERITY_WARNING,
    RunSnapshot,
    abbreviate_path,
    is_loud,
    severity,
    severity_reason,
)
from lib.config import Config


_WATCH_RESCAN_DEFAULT_SECONDS: float = 5.0
# Lower bound: `set_interval(0, ...)` would either error or fire constantly;
# anything sub-second risks pegging the UI thread on filesystem walks. Values
# below this clamp upward.
_WATCH_RESCAN_MIN_SECONDS: float = 1.0


def _resolve_watch_rescan_seconds(cfg: Config) -> float:
    board = (cfg.raw.get("board") or {}) if isinstance(cfg.raw, dict) else {}
    try:
        value = float(board.get("watch_rescan_seconds",
                                _WATCH_RESCAN_DEFAULT_SECONDS))
    except (TypeError, ValueError):
        return _WATCH_RESCAN_DEFAULT_SECONDS
    if value < _WATCH_RESCAN_MIN_SECONDS:
        return _WATCH_RESCAN_MIN_SECONDS
    return value


# Card width / column width. Picked to fit a typical run_id (40 chars) +
# small padding without horizontal wrap inside the card.
_CARD_WIDTH = 42

# Timestamp column width inside the events band: `[12:34 ago]` is 11 chars.
_EVENT_TS_WIDTH = 11


# ---------- Card-rendering primitives ----------

def _band_rule(width: int = _CARD_WIDTH - 2) -> Text:
    """Horizontal rule used to separate bands inside a card."""
    return Text("─" * width, style="dim")


def _trim_title_date(run_id: str) -> tuple[str, str]:
    """Split ``YYYY-MM-DD-<slug>`` into (date, slug).

    Six date chars + dashes lead every run_id; rendering them dim while
    the slug stays bright lets the eye latch onto the unique part. If the
    id doesn't match that shape we return ("", run_id) and let the caller
    render the whole thing bright.
    """
    if len(run_id) >= 11 and run_id[4] == "-" and run_id[7] == "-" and run_id[10] == "-":
        date = run_id[:10]
        if date.replace("-", "").isdigit():
            return date, run_id[11:]
    return "", run_id


def _format_metrics_line(run: RunSnapshot) -> str:
    """One-line `tokens · build · $` band content. Read-only telemetry."""
    tok = run.metrics_total_tokens or 0
    if tok >= 1_000_000:
        tok_str = f"{tok/1_000_000:.1f}M"
    elif tok >= 1_000:
        tok_str = f"{tok/1_000:.1f}k"
    else:
        tok_str = str(tok)
    appr = run.metrics_approves
    val = run.metrics_validate_attempts
    build_str = "—"
    if val is not None and val > 0:
        build_str = f"{appr or 0}/{val}"
    cost = run.metrics_cost_usd or 0.0
    cost_str = f"${cost:.2f}" if cost >= 0.01 else f"${cost:.4f}"
    line = f"tokens {tok_str} · build {build_str} · {cost_str}"
    # Pass-2 A9: dim session-staleness nudge when one session grew large.
    lst = run.metrics_largest_session_turns
    if lst is not None and lst > 100:
        line = f"{line} · turns {lst}"
    return line


def _format_event_ts(seconds: float) -> str:
    """Compact ``[mm:ss ago]`` for the events column.

    Falls back to the larger format_age (m/h/d) once the event is older
    than 99 minutes so we keep a fixed-width column.
    """
    s = max(0, int(seconds))
    if s < 60 * 100:
        mins, secs = divmod(s, 60)
        return f"[{mins:02d}:{secs:02d} ago]"
    # Older: format_age returns "Nh" or "Nd"; pad to 11.
    return f"[{format_age(seconds):>5} ago]"


def _card_text(
    run: RunSnapshot,
    *,
    compact: bool,
    workbench_root: str | None,
    show_paths: bool,
) -> Text:
    """Render one card as a Rich Text object."""
    sev = severity(run)
    text = Text()

    if compact:
        marker = ""
        if sev == SEVERITY_BLOCKING:
            marker = "✕ "
        elif sev == SEVERITY_WARNING:
            marker = "⚠ "
        title_style = "bold"
        if sev == SEVERITY_BLOCKING:
            title_style = "bold red"
        elif sev == SEVERITY_WARNING:
            title_style = "bold yellow"
        text.append(f"{marker}{run.run_id}", style=title_style)

        bits = [format_age(run.age_seconds)]
        if run.repo_name:
            bits.append(run.repo_name)
        if run.is_live:
            bits.append("live")
        reason = severity_reason(run)
        if reason:
            bits.append(reason)
        text.append("  " + " · ".join(bits), style="dim")
        return text

    # --- Title band ---
    _append_title_band(text, run, sev)

    text.append("\n")
    text.append_text(_band_rule())
    text.append("\n")

    # --- Meta band (dim) ---
    _append_meta_band(text, run)

    # --- Body band (default brightness) ---
    body_lines = list(_status_body(run))
    reason = severity_reason(run)
    if reason and sev == SEVERITY_BLOCKING:
        body_lines.insert(0, f"✕ {reason}")
    elif reason and sev == SEVERITY_WARNING:
        body_lines.insert(0, f"⚠ {reason}")
    if body_lines:
        text.append("\n")
        text.append_text(_band_rule())
        text.append("\n")
        for ln in body_lines:
            style = ""
            if ln.startswith("✕"):
                style = "red"
            elif ln.startswith("⚠"):
                style = "yellow"
            text.append(ln, style=style)
            text.append("\n")
        # Strip the trailing newline so the next band can lead with its rule.
        text.rstrip()

    # --- Events band ---
    if run.recent_events:
        text.append("\n")
        text.append_text(_band_rule())
        text.append("\n")
        for ev in run.recent_events:
            ts = _format_event_ts(ev.age_seconds)
            detail = f" {ev.detail}" if ev.detail else ""
            text.append(f"{ts:<{_EVENT_TS_WIDTH}} {ev.type}{detail}\n")
        text.rstrip()

    # --- Metrics band (read-only telemetry, no severity styling) ---
    if run.metrics_total_tokens is not None:
        text.append("\n")
        text.append_text(_band_rule())
        text.append("\n")
        text.append(_format_metrics_line(run), style="dim")
        text.append("\n")
        text.rstrip()

    # --- Files band (gated) ---
    if show_paths and (run.run_dir or run.worktree_path):
        text.append("\n")
        text.append_text(_band_rule())
        text.append("\n")
        if run.run_dir:
            text.append(
                f"  run  {abbreviate_path(run.run_dir, workbench_root=workbench_root)}\n",
                style="dim",
            )
        if run.worktree_path:
            text.append(
                f"  wt   {abbreviate_path(run.worktree_path, workbench_root=workbench_root)}\n",
                style="dim",
            )
        text.rstrip()

    return text


def _append_title_band(text: Text, run: RunSnapshot, sev: str) -> None:
    date, slug = _trim_title_date(run.run_id)
    marker = ""
    title_style = "bold"
    if sev == SEVERITY_BLOCKING:
        marker = "✕ "
        title_style = "bold red"
    elif sev == SEVERITY_WARNING:
        marker = "⚠ "
        title_style = "bold yellow"
    if marker:
        text.append(marker, style=title_style)
    if date:
        text.append(f"{date}-", style="dim")
    text.append(slug, style=title_style)
    text.append(f"  [{run.status}]", style="dim")
    if run.scope_kind:
        text.append(f"  {run.scope_kind}", style="dim")
    if run.is_live:
        text.append("  ● live", style="green")


def _append_meta_band(text: Text, run: RunSnapshot) -> None:
    """Age-in-stage · total age · repo · branch — one line, dim."""
    pieces: list[str] = []
    if run.time_in_stage_seconds is not None:
        pieces.append(f"{format_age(run.time_in_stage_seconds)} in stage")
    pieces.append(f"{format_age(run.age_seconds)} since update")
    if run.total_age_seconds > run.age_seconds + 1:
        pieces.append(f"{format_age(run.total_age_seconds)} total")
    if run.repo_name:
        pieces.append(run.repo_name)
    if run.branch_name:
        pieces.append(run.branch_name)
    text.append(" · ".join(pieces), style="dim")


def _status_body(run: RunSnapshot) -> Iterable[str]:
    """Yield status-specific body lines (not including title/meta)."""
    if run.status == "draft":
        return
    if run.status == "building":
        cur = run.build_iterations
        mx = run.build_max_iterations
        if cur is not None and mx:
            bar = _progress_bar(cur, mx, width=10)
            yield f"build {cur}/{mx} {bar}"
        if run.avg_iteration_seconds is not None:
            yield f"avg {format_age(run.avg_iteration_seconds)}/iter"
        if run.build_md_exists:
            yield "build.md present"
        if run.bounced_from:
            age = (
                format_age(run.bounced_at_age_seconds)
                if run.bounced_at_age_seconds is not None else "?"
            )
            yield f"↩ bounced from {run.bounced_from} · {age} ago"
        if run.recent_bounce_reason and not run.bounced_from:
            yield f"bounced: {run.recent_bounce_reason}"
        for line in _diff_lines(run):
            yield line
        return
    if run.status == "validating":
        ck = "tests"
        tp = run.tests_passed
        mark = "?" if tp is None else ("✓" if tp else "✗")
        head = f"{ck} {mark}"
        if run.tests_recorded_age_seconds is not None:
            head += f" · {format_age(run.tests_recorded_age_seconds)} ago"
        yield (
            f"{head}  rev {'✓' if run.review_completed else '·'}"
            f"  qa {'✓' if run.qa_completed else '·'}"
        )
        if run.ac_total is not None:
            mark = ""
            if run.ac_covered is not None and run.ac_total > 0 and run.ac_covered < run.ac_total:
                mark = " !"
            yield f"{run.ac_covered}/{run.ac_total} ACs covered{mark}"
        elif run.ac_table_missing:
            yield "AC table missing"
        if run.has_known_issues:
            yield f"known_issues: {run.known_issues_count}"
        for line in _diff_lines(run):
            yield line
        return
    if run.status == "followups":
        if run.followups_entry_count is not None:
            yield f"{run.followups_entry_count} follow-ups"
        for line in _followups_breakdown(run):
            yield line
        return
    if run.status == "human_review":
        if run.bounce_count:
            yield f"bounces: {run.bounce_count}"
        if run.followups_entry_count is not None:
            yield f"{run.followups_entry_count} follow-ups"
        for line in _followups_breakdown(run):
            yield line
        return
    if run.status == "done":
        if run.accepted_by or run.completed_at:
            who = run.accepted_by or "?"
            when = _hhmm(run.completed_at) if run.completed_at else "?"
            yield f"accepted_by {who} · {when}"
        # `local-branch:` completion_refs predate auto-merge; the run reached
        # `done` without ever being integrated into the parent branch. Flag it
        # until the human merges by hand (or backfills the ref).
        if run.completion_ref and run.completion_ref.startswith("local-branch:"):
            yield "⚠ unmerged (completion_ref is a label, not a merge SHA)"
        return
    if run.status == "abandoned":
        if run.abandoned_reason:
            yield f"abandoned: {run.abandoned_reason}"
        return
    return


def _diff_lines(run: RunSnapshot) -> Iterable[str]:
    if run.diff_files is None:
        return
    if not run.diff_files and not run.diff_added and not run.diff_removed:
        return
    yield (
        f"+{run.diff_added or 0}/-{run.diff_removed or 0} "
        f"across {run.diff_files} file{'s' if run.diff_files != 1 else ''}"
    )


def _followups_breakdown(run: RunSnapshot) -> Iterable[str]:
    if not run.followups_categories:
        return
    bits = [f"{count} {cat}" for cat, count in run.followups_categories]
    yield "  · " + " · ".join(bits)


def _hhmm(ts: str) -> str:
    """Format an ISO timestamp as HH:MM (local). Best-effort."""
    try:
        return dt.datetime.fromisoformat(ts).strftime("%H:%M")
    except Exception:
        return ts[11:16] if len(ts) >= 16 else ts


def _progress_bar(cur: int, mx: int, *, width: int = 10) -> str:
    if mx <= 0:
        return ""
    filled = max(0, min(width, int(round(width * cur / mx))))
    return "[" + "#" * filled + "-" * (width - filled) + "]"


# ---------- Textual widgets ----------

class RunCard(Static):
    """One card. Wraps a RunSnapshot in a fixed-width Static.

    Mutable in place: `apply` updates the Text and severity classes so the
    StatusColumn can reuse the same widget across refreshes (which preserves
    scroll position + focus, the whole point of PR2).
    """

    DEFAULT_CSS = """
    RunCard {
        width: 42;
        padding: 0 1;
        margin: 0 0 1 0;
        border: tall $surface;
    }
    RunCard.-warning {
        border: tall yellow;
    }
    RunCard.-blocking {
        border: tall red;
    }
    """

    def __init__(
        self,
        run: RunSnapshot,
        *,
        compact: bool,
        workbench_root: str | None,
        show_paths: bool,
    ):
        super().__init__()
        self.apply(
            run, compact=compact, workbench_root=workbench_root, show_paths=show_paths,
        )

    def apply(
        self,
        run: RunSnapshot,
        *,
        compact: bool,
        workbench_root: str | None,
        show_paths: bool,
    ) -> None:
        """Update text + severity classes in place."""
        self.update(_card_text(
            run, compact=compact, workbench_root=workbench_root, show_paths=show_paths,
        ))
        sev = severity(run)
        self.set_class(sev == SEVERITY_BLOCKING, "-blocking")
        self.set_class(sev == SEVERITY_WARNING, "-warning")


class StatusColumn(Vertical):
    """One Kanban column: header strip + scrollable card stack."""

    DEFAULT_CSS = """
    StatusColumn {
        width: 44;
        height: 100%;
        padding: 0 1;
    }
    StatusColumn > .column-header {
        height: 3;
        content-align: left middle;
    }
    StatusColumn > ScrollableContainer {
        height: 1fr;
    }
    """

    def __init__(self, status: str):
        super().__init__()
        self.status = status
        self._header = Static("", classes="column-header")
        self._body = ScrollableContainer()
        # Mounted RunCards keyed on run_id, so we can update in place across
        # refreshes instead of unmounting + remounting. Preserving widget
        # identity is what preserves the user's scroll position + focus.
        self._cards: dict[str, RunCard] = {}

    def compose(self) -> ComposeResult:
        yield self._header
        yield self._body

    def update_column(
        self,
        runs: tuple[RunSnapshot, ...],
        *,
        compact: bool,
        workbench_root: str | None,
        show_paths: bool,
    ) -> None:
        worst = SEVERITY_WARNING if any(severity(r) == SEVERITY_WARNING for r in runs) else ""
        if any(severity(r) == SEVERITY_BLOCKING for r in runs):
            worst = SEVERITY_BLOCKING
        marker = ""
        marker_style = "dim"
        if worst == SEVERITY_BLOCKING:
            marker = " ✕"
            marker_style = "red"
        elif worst == SEVERITY_WARNING:
            marker = " ⚠"
            marker_style = "yellow"
        header = Text()
        header.append(self.status, style="bold")
        header.append(f"  ({len(runs)})", style="dim")
        if marker:
            header.append(marker, style=marker_style)
        sub = COLUMN_SUBTITLES.get(self.status)
        if sub:
            header.append(f"\n{sub}", style="dim italic")
        self._header.update(header)

        # Diff against the previous mount. Order in `runs` is authoritative.
        incoming_ids = [r.run_id for r in runs]
        incoming_set = set(incoming_ids)

        # 1. Remove cards whose run vanished.
        for run_id in list(self._cards.keys()):
            if run_id not in incoming_set:
                self._cards.pop(run_id).remove()

        # 2. Update existing / mount new cards. Mount in order so newcomers
        #    land at the correct DOM position (avoids most move_child churn).
        for idx, r in enumerate(runs):
            existing = self._cards.get(r.run_id)
            if existing is not None:
                existing.apply(
                    r,
                    compact=compact,
                    workbench_root=workbench_root,
                    show_paths=show_paths,
                )
            else:
                card = RunCard(
                    r,
                    compact=compact,
                    workbench_root=workbench_root,
                    show_paths=show_paths,
                )
                self._cards[r.run_id] = card
                # Mount at the correct index. before= takes the sibling that
                # should follow the new card; we find it by looking at the
                # next incoming id that already has a mounted card.
                anchor = self._find_anchor(incoming_ids, idx)
                if anchor is None:
                    self._body.mount(card)
                else:
                    self._body.mount(card, before=anchor)

        # 3. Fix any out-of-order existing cards.
        body_children = list(self._body.children)
        for desired_idx, run_id in enumerate(incoming_ids):
            card = self._cards.get(run_id)
            if card is None:
                continue
            try:
                actual_idx = body_children.index(card)
            except ValueError:
                continue
            if actual_idx != desired_idx:
                self._body.move_child(card, before=desired_idx)
                body_children = list(self._body.children)

    def _find_anchor(
        self, incoming_ids: list[str], from_idx: int,
    ) -> "RunCard | None":
        """First already-mounted card at index > from_idx, or None.

        Used as the `before=` anchor when mounting a new card so it lands at
        the right slot without needing a follow-up move_child.
        """
        for j in range(from_idx + 1, len(incoming_ids)):
            sibling = self._cards.get(incoming_ids[j])
            if sibling is not None and sibling.is_mounted:
                return sibling
        return None


# ---------- Watchdog -> Textual bridge ----------

class RunsChanged(Message):
    """Posted by the watchdog thread when something under runs/ changed."""


# Quiet window (seconds) — every event resets the clock; a single refresh
# fires once activity has stopped for this long. A single metadata.save
# fires 2+ events (tmp create + rename), and metrics.jsonl appends fire one
# event per line, so coalescing is mandatory to keep the UI usable.
_FS_DEBOUNCE_SECONDS = 0.15


class _Handler(FileSystemEventHandler):
    def __init__(self, app: "AgentBoardApp"):
        self._app = app

    def on_any_event(self, event):  # noqa: D401
        path = getattr(event, "src_path", "") or ""
        # Filter noise:
        #  - .tmp suffix from atomic-rename writes; the rename event covers it.
        #  - dot-prefixed basenames (vim swapfiles, macOS .DS_Store, fsevents
        #    droppings).
        #  - anything under archive/, which the board never renders.
        if path.endswith(".tmp"):
            return
        basename = path.rsplit("/", 1)[-1]
        if basename.startswith("."):
            return
        if "/archive/" in path:
            return
        # Mark the app dirty; the periodic drain posts a single RunsChanged
        # once events go quiet for _FS_DEBOUNCE_SECONDS. See AgentBoardApp.
        self._app._mark_fs_dirty()


# ---------- The app ----------

@dataclasses.dataclass(frozen=True)
class BoardOptions:
    show_all: bool = False
    only_status: str | None = None
    compact: bool = False
    show_paths: bool = False


class AgentBoardApp(App):
    """Full-screen TUI rendering the Agent Workbench board.

    The board is read-only beyond `q`. Re-render is driven by:
      - watchdog events on runs/, coalesced through a 150ms quiet-window
        debounce so a metadata-save burst (tmp create + rename + metrics
        append) fires one refresh, not three
      - a 60s safety-net timer for age-ticker accuracy. format_age rounds to
        minutes, so anything faster is pure waste.
    """

    CSS = """
    Screen {
        layout: vertical;
    }
    #columns {
        layout: horizontal;
        height: 1fr;
        overflow-x: auto;
    }
    """

    BINDINGS = [Binding("q", "quit", "Quit")]

    def __init__(self, cfg: Config, opts: BoardOptions):
        super().__init__()
        self._cfg = cfg
        self._opts = opts
        self._observer: Observer | None = None
        self._columns: dict[str, StatusColumn] = {}
        self._workbench_root = str(cfg.root)
        # Paths watchdog has been scheduled against. Populated in on_mount
        # (master's runs/ + every existing worktree-side runs dir) and
        # extended by the periodic re-scan when new worktrees appear.
        self._watched_paths: set[str] = set()
        # FS-event debounce state. _fs_dirty_at is the monotonic time of the
        # latest filesystem event we observed; the periodic drain compares
        # it against now() and fires one RunsChanged once the quiet window
        # elapses. 0 = clean.
        self._fs_dirty_at: float = 0.0

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        with Horizontal(id="columns"):
            for status in COLUMN_ORDER:
                col = StatusColumn(status)
                self._columns[status] = col
                yield col
        yield Footer()

    def on_mount(self) -> None:
        # Initial render.
        self._refresh()
        # Safety-net timer: format_age floors to minutes (see snapshot.format_age)
        # so a 60s tick is enough to keep age tickers honest. The debounced
        # watchdog handler covers everything that actually changes faster.
        self.set_interval(60.0, self._refresh)
        # Drain accumulated FS events every 100ms. Cheap: one comparison per
        # tick when idle, one post_message + state-clear when firing.
        self.set_interval(0.1, self._drain_fs_events)
        # Watchdog observer for low-latency response to file changes.
        # Master's runs/ + every existing worktree-side runs/ get a separate
        # schedule on a single Observer instance. The periodic re-scan below
        # picks up worktrees created after startup.
        runs_path = self._cfg.runs_path
        runs_path.mkdir(parents=True, exist_ok=True)
        obs = Observer()
        self._observer = obs
        # Resolve paths before keying so a master-side path can't be added
        # twice under symlinked vs canonical forms (matches the resolved form
        # we get from runs.iter_all_runs / _list_workbench_worktrees).
        self._schedule_path(str(runs_path.resolve()))
        self._schedule_worktree_runs_dirs()
        obs.daemon = True
        obs.start()
        # Periodically diff the worktree set against what we've scheduled and
        # add observers for any worktrees that have appeared since startup.
        rescan_seconds = _resolve_watch_rescan_seconds(self._cfg)
        self.set_interval(rescan_seconds, self._rescan_worktrees)

    def _schedule_path(self, path: str) -> None:
        """Schedule a watchdog observer at ``path`` if not already watched.

        Idempotent: re-scheduling the same path is a no-op (and silently
        absorbs the watchdog backend's missing-path edge cases — we accept a
        dead schedule rather than fight the platform).
        """
        if self._observer is None:
            return
        if path in self._watched_paths:
            return
        try:
            self._observer.schedule(_Handler(self), path, recursive=True)
        except Exception:
            # Path may have vanished between discovery and schedule; accept
            # the loss and continue. The 1Hz fallback timer keeps us correct.
            return
        self._watched_paths.add(path)

    def _schedule_worktree_runs_dirs(self) -> None:
        """Add a watchdog schedule for each worktree-side runs/ dir.

        Iterates the live worktree set directly (not the runs in them) so a
        brand-new worktree with zero runs still gets observed — important for
        AC2's "new worktree appears mid-session" path, where the worktree may
        exist before its first metadata.yaml is written.

        Idempotent — _schedule_path skips paths already in _watched_paths.
        """
        sub = runs_mod.workbench_subpath(self._cfg)
        if sub is None:
            return
        try:
            worktrees = runs_mod._list_workbench_worktrees(self._cfg)
        except Exception:
            return
        for wt in worktrees:
            runs_dir = wt / sub / "runs"
            if not runs_dir.exists():
                # watchdog refuses to schedule against nonexistent paths.
                # The 1Hz fallback + next re-scan covers this gap.
                continue
            self._schedule_path(str(runs_dir.resolve()))

    def _rescan_worktrees(self) -> None:
        """Periodic timer: pick up worktrees created since last tick.

        Reads the (TTL-cached) worktree set and schedules observers for any
        worktree-side runs/ dirs not already in self._watched_paths. Does not
        unschedule observers for vanished worktrees — the dead schedule is
        harmless and avoids platform-specific unschedule edge cases.
        """
        self._schedule_worktree_runs_dirs()

    def on_unmount(self) -> None:
        if self._observer is not None:
            try:
                self._observer.stop()
                self._observer.join(timeout=1.0)
            except Exception:
                pass

    def on_runs_changed(self, _: RunsChanged) -> None:
        self._refresh()

    def _mark_fs_dirty(self) -> None:
        """Called from the watchdog thread on every filtered FS event.

        Just records `now`; the drain timer on the UI thread is what actually
        triggers a refresh once activity stops for the quiet window.
        """
        self._fs_dirty_at = time.monotonic()

    def _drain_fs_events(self) -> None:
        """Fire one refresh once FS events have been quiet for the debounce window."""
        dirty_at = self._fs_dirty_at
        if dirty_at == 0.0:
            return
        if (time.monotonic() - dirty_at) < _FS_DEBOUNCE_SECONDS:
            return
        self._fs_dirty_at = 0.0
        self._refresh()

    def _refresh(self) -> None:
        snap = snapshot_mod.build(
            self._cfg,
            show_all=self._opts.show_all,
            only_status=self._opts.only_status,
        )

        visible_statuses = {c.status for c in snap.visible_columns()}
        if self._opts.only_status:
            visible_statuses = {self._opts.only_status}

        for status, col in self._columns.items():
            column = next((c for c in snap.columns if c.status == status), None)
            runs = column.runs if column else ()
            col.update_column(
                runs,
                compact=self._opts.compact,
                workbench_root=self._workbench_root,
                show_paths=self._opts.show_paths,
            )
            col.display = (status in visible_statuses) or bool(runs)

        # Update the header subtitle with timestamp + total runs.
        # Minute-resolution clock: format_age floors to minutes, so a finer
        # subtitle clock would tick faster than the data it summarizes.
        self.title = "Agent Workbench"
        self.sub_title = (
            f"{snap.total_runs} run(s) · "
            f"watch · {snap.now.strftime('%H:%M')}"
        )


def run(cfg: Config, opts: BoardOptions) -> int:
    AgentBoardApp(cfg, opts).run()
    return 0
