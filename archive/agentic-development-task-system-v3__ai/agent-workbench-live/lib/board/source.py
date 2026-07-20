"""Pure-function readers that produce one RunSnapshot per run on disk.

No Textual import here — this module is the on-disk reader, callable from
tests without a TTY. The snapshot is the input to both the live TUI and the
fallback `--static` text render.

Source of truth = the filesystem. Each call re-reads metadata.yaml + a
configurable tail of events.jsonl. No caching between calls; staleness is
the failure mode we refuse to ship.
"""
from __future__ import annotations

import dataclasses
import datetime as dt
import json
import pathlib
import re
import subprocess
from typing import Any

from lib import lifecycle, metadata, runs as runs_mod
from lib.config import Config

# Re-export so the cmd_board renderers don't have to import from lib.runs.
SOURCE_MASTER = runs_mod.SOURCE_MASTER
SOURCE_WORKTREE = runs_mod.SOURCE_WORKTREE


# Cached git-diff shortstats. Key = (run_id, updated_at). Module-level on
# purpose: lifetime = the board session, which is short. The dataset is
# tiny (tens of runs), so unbounded growth is a non-issue.
_DIFF_CACHE: dict[tuple[str, str], tuple[int | None, int | None, int | None]] = {}

# Mtime-keyed caches for repeated on-disk parses. Each entry stores
# (st_mtime_ns, parsed_value); a stat() mismatch evicts and re-parses. These
# exist because snapshot.build runs every 60s + on every watchdog event, and
# the dominant cost left after PR1/step-2 is re-parsing files whose contents
# haven't changed.
_EVENTS_CACHE: dict[str, tuple[int, list[dict]]] = {}
_AC_CACHE: dict[str, tuple[int, tuple[int | None, int | None, bool]]] = {}
_METRICS_CACHE: dict[str, tuple[int, tuple[int, int, int, float, int | None]]] = {}


def _reset_board_caches() -> None:
    """Clear every board-side cache. Called by tests between scenarios."""
    _DIFF_CACHE.clear()
    _EVENTS_CACHE.clear()
    _AC_CACHE.clear()
    _METRICS_CACHE.clear()

# How recently an event must have fired for the card to read "live".
_LIVE_THRESHOLD_SECONDS = 60.0


# Lifecycle states in canonical left-to-right column order.
COLUMN_ORDER: tuple[str, ...] = (
    "draft",
    "shaping",
    "planning",
    "ready",
    "building",
    "validating",
    "followups",
    "human_review",
    "done",
    "abandoned",
)

TERMINAL_STATES: tuple[str, ...] = ("done", "abandoned")


# One-line subtitle per lifecycle column. Lets a new reader figure out
# what a column means without a glossary.
COLUMN_SUBTITLES: dict[str, str] = {
    "draft": "raw ideas, ready to shape",
    "shaping": "brief in flight",
    "planning": "writing plan + assumptions",
    "ready": "awaiting human green light",
    "building": "agent inside the worktree",
    "validating": "self-review + QA",
    "followups": "brainstorm next bites",
    "human_review": "review + QA in flight",
    "done": "accepted, closed",
    "abandoned": "stopped intentionally",
}


# Two loudness tiers.
SEVERITY_NONE = ""
SEVERITY_WARNING = "warning"
SEVERITY_BLOCKING = "blocking"


@dataclasses.dataclass(frozen=True)
class EventSummary:
    """One line of recent activity rendered on a card."""
    at: str             # ISO timestamp string from the event
    age_seconds: float  # seconds between event.at and snapshot.now
    type: str           # event_type (e.g. "ArtifactWritten")
    detail: str         # short human-readable detail (e.g. "review.md")


@dataclasses.dataclass(frozen=True)
class RunSnapshot:
    """Everything the board needs to render one card. Frozen, value-typed."""
    run_id: str
    status: str
    scope_kind: str
    repo_name: str
    repo_path: str
    repo_path_tail: str          # last 2 path segments of repo.path
    branch_name: str
    worktree_name: str
    run_dir: str
    worktree_path: str
    created_at: str
    updated_at: str

    # Derived ages (seconds).
    age_seconds: float                    # since updated_at
    total_age_seconds: float              # since created_at
    time_in_stage_seconds: float | None   # since last TransitionApplied; None if unknown
    is_live: bool                         # any event within _LIVE_THRESHOLD_SECONDS

    # Stage-aware progress.
    build_iterations: int | None
    build_max_iterations: int | None
    build_exit_reason: str | None
    build_md_exists: bool
    avg_iteration_seconds: float | None   # avg gap between TransitionApplied → building

    # Acceptance criteria coverage (parsed from build.md).
    ac_total: int | None
    ac_covered: int | None
    ac_table_missing: bool                # build.md present but no AC section

    # Diff shortstat against base_ref (lazy, cached on (run_id, updated_at)).
    diff_added: int | None
    diff_removed: int | None
    diff_files: int | None

    # Validation flags.
    review_completed: bool
    qa_completed: bool
    tests_passed: bool | None
    known_issues_count: int
    tests_recorded_age_seconds: float | None  # age of last QACompleted event

    # Followups stage signal.
    followups_entry_count: int | None
    followups_categories: tuple[tuple[str, int], ...]   # (category, count)

    # Health flags.
    is_stale_human_review: bool
    builder_gave_up: bool        # build.exit_reason == "max_iterations"
    failing_tests: bool          # validation.tests_passed == False
    has_known_issues: bool       # validation.known_issues_count > 0
    has_recent_error: bool       # ErrorRecorded since last TransitionApplied
    bounce_count: int            # number of BounceRequested events
    recent_bounce_reason: str | None
    bounced_from: str | None              # most recent TransitionApplied.from when current = "building"
    bounced_at_age_seconds: float | None
    worktree_missing: bool                # target.worktree.created == False (and past `ready`)

    # Completion (only meaningful in terminal states).
    completed_at: str | None
    accepted_by: str | None
    abandoned_reason: str | None
    completion_ref: str | None            # `merge:<sha>` after Option A; legacy `local-branch:<branch>` flags as unmerged

    # Live-tail recent events (newest first).
    recent_events: tuple[EventSummary, ...]

    # Token-efficiency telemetry (None when metrics.jsonl is absent).
    metrics_total_tokens: int | None
    metrics_approves: int | None
    metrics_validate_attempts: int | None
    metrics_cost_usd: float | None
    # Pass-2 A9: session-staleness indicator. Largest single-session turn
    # count across the run; > 100 surfaces a dim "turns N" hint on the card.
    metrics_largest_session_turns: int | None

    # TODO §1B1: where this run lives on disk right now — "worktree" for live
    # runs, "master" for archived runs. Drives the "(archived)" suffix on the
    # card.
    source: str = runs_mod.SOURCE_MASTER


def _parse_iso(ts: str) -> dt.datetime | None:
    try:
        return dt.datetime.fromisoformat(ts)
    except Exception:
        return None


def _seconds_between(ts: str, now: dt.datetime) -> float:
    parsed = _parse_iso(ts)
    if parsed is None:
        return 0.0
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=now.tzinfo)
    return max(0.0, (now - parsed).total_seconds())


def _short_actor(actor: dict | None) -> str:
    if not isinstance(actor, dict):
        return ""
    return str(actor.get("name") or "")


def _event_detail(ev: dict) -> str:
    """One-line summary of an event. Detail varies by type."""
    et = ev.get("type", "")
    payload = ev.get("payload") or {}

    if et == "ArtifactWritten":
        key = payload.get("artifact_key") or ""
        # Trim the path to its basename for the card.
        raw = payload.get("path") or ""
        base = pathlib.Path(raw).name if raw else ""
        return f"{key}={base}" if key and base else (key or base or "")
    if et == "TransitionApplied":
        return f"{ev.get('from','?')} -> {ev.get('to','?')}"
    if et == "CommandRun":
        cmd = payload.get("command") or ""
        # Keep cards narrow: clamp to the binary name + first arg.
        return cmd.split("\n", 1)[0][:48]
    if et == "BounceRequested":
        return str(payload.get("bounce_reason") or "")[:48]
    if et == "ErrorRecorded":
        return f"{payload.get('error_kind','')}: {payload.get('message','')}"[:48]
    if et == "ReviewCompleted":
        return str(payload.get("review_decision") or "")
    if et == "QACompleted":
        passed = payload.get("tests_passed")
        return "tests passed" if passed else "tests failed"
    if et == "FollowupsRecorded":
        n = payload.get("entry_count")
        return f"{n} entries" if n is not None else ""
    if et == "DocClaimsVerified":
        unverified = payload.get("unverified") or []
        return f"{len(unverified)} unverified" if unverified else "ok"
    if et == "ScopeCreepChecked":
        creep = payload.get("creep") or []
        return f"{len(creep)} creep" if creep else "clean"
    return ""


def _iter_events(events_path: pathlib.Path):
    """Yield each event as a dict. Skips empty / malformed lines silently.

    Cached on (path, mtime_ns) — `snapshot.build` calls this for every run on
    every tick, and events.jsonl only changes when a CLI command writes an
    event. A single stat() per call to validate the cache entry is cheap.
    """
    try:
        st = events_path.stat()
    except OSError:
        return
    key = str(events_path)
    cached = _EVENTS_CACHE.get(key)
    if cached is not None and cached[0] == st.st_mtime_ns:
        for ev in cached[1]:
            yield ev
        return
    try:
        text = events_path.read_text()
    except OSError:
        return
    parsed: list[dict] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            parsed.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    _EVENTS_CACHE[key] = (st.st_mtime_ns, parsed)
    for ev in parsed:
        yield ev


_AC_HEADING_RE = re.compile(r"^\s*##\s+Acceptance criteria coverage\s*$", re.IGNORECASE)
_AC_ROW_RE = re.compile(r"^\s*\|")
_NEXT_HEADING_RE = re.compile(r"^\s*##\s+\S")


def _parse_ac_coverage(build_md_path: pathlib.Path) -> tuple[int | None, int | None, bool]:
    """Parse the ``## Acceptance criteria coverage`` table.

    Returns ``(ac_total, ac_covered, table_missing)``. ``table_missing``
    is True when build.md exists but contains no AC section. Coverage =
    rows whose second cell does NOT contain "missing", "n/a", or "tbd".

    Cached on (path, mtime_ns).
    """
    try:
        st = build_md_path.stat()
    except OSError:
        return None, None, False
    key = str(build_md_path)
    cached = _AC_CACHE.get(key)
    if cached is not None and cached[0] == st.st_mtime_ns:
        return cached[1]
    result = _parse_ac_coverage_uncached(build_md_path)
    _AC_CACHE[key] = (st.st_mtime_ns, result)
    return result


def _parse_ac_coverage_uncached(
    build_md_path: pathlib.Path,
) -> tuple[int | None, int | None, bool]:
    try:
        text = build_md_path.read_text()
    except OSError:
        return None, None, False

    lines = text.splitlines()
    section_start: int | None = None
    for i, ln in enumerate(lines):
        if _AC_HEADING_RE.match(ln):
            section_start = i + 1
            break
    if section_start is None:
        return None, None, True

    rows: list[str] = []
    for ln in lines[section_start:]:
        if _NEXT_HEADING_RE.match(ln):
            break
        if _AC_ROW_RE.match(ln):
            rows.append(ln.strip())

    if not rows:
        return 0, 0, False

    data_rows = []
    for r in rows:
        if set(r.replace("|", "").strip()) <= {"-", ":", " "}:
            continue
        cells = [c.strip() for c in r.strip("|").split("|")]
        if cells and cells[0].lower() in {"ac", "criterion", "id"}:
            continue
        data_rows.append(cells)

    total = len(data_rows)
    covered = 0
    soft_misses = {"missing", "n/a", "tbd", "todo", "not covered"}
    for cells in data_rows:
        second = (cells[1] if len(cells) > 1 else "").lower()
        if any(s in second for s in soft_misses):
            continue
        covered += 1
    return total, covered, False


def _git_shortstat(
    worktree_path: str,
    base_ref: str,
    *,
    cache_key: tuple[str, str],
    base_ref_sha: str | None = None,
) -> tuple[int | None, int | None, int | None]:
    """Return ``(added, removed, files)`` from ``git diff --shortstat``.

    Prefers ``base_ref_sha`` over the symbolic ``base_ref`` when present;
    falls back to ``base_ref`` literal otherwise (no in-worktree
    lazy-resolve — see DR-002).

    Cached on ``(*cache_key, effective_ref)`` so a SHA that arrives without
    bumping ``updated_at`` (e.g. an in-process backfill) still invalidates
    the previous result. Failures cache None tuples so we don't retry on
    every tick.
    """
    effective_ref = base_ref_sha or base_ref
    full_key = (*cache_key, effective_ref or "")
    cached = _DIFF_CACHE.get(full_key)
    if cached is not None:
        return cached

    result: tuple[int | None, int | None, int | None] = (None, None, None)
    wt = pathlib.Path(worktree_path)
    if worktree_path and effective_ref and wt.exists():
        try:
            proc = subprocess.run(
                ["git", "diff", "--shortstat", f"{effective_ref}...HEAD"],
                cwd=worktree_path,
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            proc = None
        if proc is not None and proc.returncode == 0:
            result = _parse_shortstat(proc.stdout)
    _DIFF_CACHE[full_key] = result
    return result


def _parse_shortstat(raw: str) -> tuple[int | None, int | None, int | None]:
    """Parse ``" 11 files changed, 940 insertions(+), 3 deletions(-)"``."""
    raw = (raw or "").strip()
    if not raw:
        return 0, 0, 0
    files = added = removed = None
    m_files = re.search(r"(\d+)\s+files?\s+changed", raw)
    m_added = re.search(r"(\d+)\s+insertions?\(\+\)", raw)
    m_removed = re.search(r"(\d+)\s+deletions?\(-\)", raw)
    if m_files:
        files = int(m_files.group(1))
    if m_added:
        added = int(m_added.group(1))
    if m_removed:
        removed = int(m_removed.group(1))
    if added is None and m_files:
        added = 0
    if removed is None and m_files:
        removed = 0
    return added, removed, files


def _avg_iteration_seconds(events: list[dict]) -> float | None:
    """Average gap (seconds) between successive TransitionApplied → building."""
    starts: list[dt.datetime] = []
    for ev in events:
        if ev.get("type") == "TransitionApplied" and ev.get("to") == "building":
            ts = _parse_iso(ev.get("at", ""))
            if ts is not None:
                starts.append(ts)
    if len(starts) < 2:
        return None
    gaps = [
        (b - a).total_seconds()
        for a, b in zip(starts, starts[1:])
        if (b - a).total_seconds() > 0
    ]
    if not gaps:
        return None
    return sum(gaps) / len(gaps)


def _followups_categories(events: list[dict]) -> tuple[tuple[str, int], ...]:
    """Per-category counts from the most recent FollowupsRecorded payload."""
    for ev in reversed(events):
        if ev.get("type") != "FollowupsRecorded":
            continue
        cats = (ev.get("payload") or {}).get("categories") or []
        if not isinstance(cats, list):
            return ()
        counts: dict[str, int] = {}
        for c in cats:
            if not isinstance(c, str):
                continue
            counts[c] = counts.get(c, 0) + 1
        # Stable order: highest count first, then alphabetical.
        return tuple(sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])))
    return ()


def _repo_path_tail(path: str) -> str:
    """Last 2 segments of a path, joined with ``/``. Empty string on falsy."""
    if not path:
        return ""
    parts = [p for p in pathlib.PurePath(path).parts if p not in ("", "/")]
    if not parts:
        return ""
    if len(parts) == 1:
        return parts[-1]
    return "/".join(parts[-2:])


def _last_qa_completed_age(events: list[dict], now: dt.datetime) -> float | None:
    for ev in reversed(events):
        if ev.get("type") == "QACompleted":
            return _seconds_between(ev.get("at", ""), now)
    return None


def _post_building_states() -> set[str]:
    """States where a missing worktree is suspicious."""
    return {"building", "validating", "followups", "human_review"}


def load_run_snapshot(
    cfg: Config,
    run_id: str,
    *,
    now: dt.datetime,
    stale_human_review_seconds: int,
    recent_event_count: int = 3,
    pre_resolved: "runs_mod.Run | None" = None,
) -> RunSnapshot | None:
    """Read one run off disk and return a frozen RunSnapshot.

    Returns None if metadata is missing or malformed — the board renders
    everything else; one bad run never breaks the view.

    ``pre_resolved`` lets the caller skip the metadata-driven re-resolution
    of where the run lives on disk. The board's hot path holds a resolved
    ``Run`` already and passes it through; that avoids the per-run
    ``find_run`` walk that was the dominant cost before this change.
    """
    if pre_resolved is not None:
        meta = pre_resolved.metadata
    else:
        try:
            meta = metadata.load(cfg, run_id)
        except Exception:
            return None

    status = meta.get("status", "")
    target = meta.get("target") or {}
    repo = target.get("repo") or {}
    worktree = target.get("worktree") or {}
    validation = meta.get("validation") or {}
    build = meta.get("build") or {}
    scope = meta.get("scope") or {}
    completion = meta.get("completion") or {}

    created_at = meta.get("created_at", "")
    updated_at = meta.get("updated_at", "")

    if pre_resolved is not None:
        rd = pre_resolved.run_dir
        source = pre_resolved.source
    else:
        rd = metadata.run_dir(cfg, run_id)
        # TODO §1B1: derive source ("master" vs "worktree") from the resolved
        # path so the card can show (archived) on master-side runs.
        try:
            rd.relative_to(cfg.runs_path)
            source = runs_mod.SOURCE_MASTER
        except ValueError:
            source = runs_mod.SOURCE_WORKTREE
    events_path = rd / "events.jsonl"

    # Walk events to compute time-in-stage, recent activity, bounce count, error flag.
    events = list(_iter_events(events_path))
    time_in_stage_s: float | None = None
    for ev in reversed(events):
        if ev.get("type") == "TransitionApplied" and ev.get("to") == status:
            time_in_stage_s = _seconds_between(ev.get("at", ""), now)
            break

    bounce_count = sum(1 for ev in events if ev.get("type") == "BounceRequested")
    recent_bounce_reason: str | None = None
    for ev in reversed(events):
        if ev.get("type") == "BounceRequested":
            recent_bounce_reason = str((ev.get("payload") or {}).get("bounce_reason") or "") or None
            break

    # has_recent_error = any ErrorRecorded after the last TransitionApplied.
    has_recent_error = False
    for ev in reversed(events):
        et = ev.get("type")
        if et == "TransitionApplied":
            break
        if et == "ErrorRecorded":
            has_recent_error = True
            break

    # Build the last-N event list (newest first).
    recent: list[EventSummary] = []
    for ev in reversed(events):
        if len(recent) >= recent_event_count:
            break
        et = ev.get("type", "")
        if not et:
            continue
        at = ev.get("at", "")
        recent.append(EventSummary(
            at=at,
            age_seconds=_seconds_between(at, now),
            type=et,
            detail=_event_detail(ev),
        ))

    # Stage-aware: is the build.md present in stages/4_building/?
    build_md_path: pathlib.Path | None = None
    try:
        build_md_path = lifecycle.stage_dir(
            cfg, run_id, "building", run_root=rd,
        ) / "build.md"
    except Exception:
        build_md_path = None
    if build_md_path is None or not build_md_path.exists():
        flat = rd / "build.md"
        if flat.exists():
            build_md_path = flat
    build_md_exists = bool(build_md_path and build_md_path.exists())

    # Acceptance-criteria coverage parsed off the build report when present.
    if build_md_path is not None and build_md_exists:
        ac_total, ac_covered, ac_table_missing = _parse_ac_coverage(build_md_path)
    else:
        ac_total, ac_covered, ac_table_missing = None, None, False

    avg_iter_seconds = _avg_iteration_seconds(events)

    # Bounce origin: most recent TransitionApplied entering `building`
    # whose `from` is `human_review`.
    bounced_from: str | None = None
    bounced_at_age_s: float | None = None
    if status == "building":
        for ev in reversed(events):
            if ev.get("type") != "TransitionApplied":
                continue
            if ev.get("to") != "building":
                continue
            src = ev.get("from")
            if src and src != "ready":
                bounced_from = str(src)
                bounced_at_age_s = _seconds_between(ev.get("at", ""), now)
            break

    # Followups entry count: prefer the latest FollowupsRecorded payload over
    # parsing the file (the event is the source of truth post-validate).
    followups_entry_count: int | None = None
    for ev in reversed(events):
        if ev.get("type") == "FollowupsRecorded":
            payload = ev.get("payload") or {}
            try:
                followups_entry_count = int(payload.get("entry_count"))
            except (TypeError, ValueError):
                followups_entry_count = None
            break

    # Derived flags.
    age_s = _seconds_between(updated_at, now)
    total_age_s = _seconds_between(created_at, now)
    is_stale = (status == "human_review" and age_s >= stale_human_review_seconds)
    builder_gave_up = (build.get("exit_reason") == "max_iterations")
    tests_passed = validation.get("tests_passed")  # may be None
    failing_tests = (tests_passed is False)
    known_issues_count = int(validation.get("known_issues_count") or 0)
    has_known_issues = known_issues_count > 0

    repo_path = str(repo.get("path") or "")
    repo_name = str(repo.get("name") or "")
    repo_tail = _repo_path_tail(repo_path)
    worktree_path = str(worktree.get("path") or "")
    base_ref = str(repo.get("base_ref") or "")
    base_ref_sha = repo.get("base_ref_sha") or None
    worktree_created = worktree.get("created")
    worktree_missing = (
        worktree_created is False
        and status in _post_building_states()
    )

    is_live = bool(recent and recent[0].age_seconds <= _LIVE_THRESHOLD_SECONDS)

    # git diff --shortstat is only useful once we have a worktree + base_ref.
    diff_added = diff_removed = diff_files = None
    if worktree_path and base_ref and worktree_created:
        diff_added, diff_removed, diff_files = _git_shortstat(
            worktree_path, base_ref,
            cache_key=(run_id, updated_at),
            base_ref_sha=base_ref_sha,
        )

    tests_age = _last_qa_completed_age(events, now)
    fu_categories = _followups_categories(events)

    # Token-efficiency telemetry. Read the cached summary if present and
    # fresh; otherwise quickly inspect metrics.jsonl row-counts for a
    # cheap approximate signal. Never recompute the full summary here —
    # the board loop must stay fast.
    m_total = m_appr = m_val = None
    m_cost: float | None = None
    m_largest_turns: int | None = None
    metrics_path = rd / "metrics.jsonl"
    summary_path = rd / "metrics-summary.json"
    if metrics_path.exists():
        try:
            if (
                summary_path.exists()
                and summary_path.stat().st_mtime >= metrics_path.stat().st_mtime
            ):
                import json as _json
                d = _json.loads(summary_path.read_text())
                m_total = int(d.get("total_tokens") or 0)
                m_appr = int(d.get("approves") or 0)
                m_val = int(d.get("validate_attempts") or 0)
                m_cost = float(d.get("cost_generated_usd") or 0.0)
                m_largest_turns = int(d.get("largest_session_turns") or 0) or None
            else:
                m_total, m_appr, m_val, m_cost, m_largest_turns = _quick_metrics_from_jsonl(metrics_path)
        except Exception:
            m_total = m_appr = m_val = None
            m_cost = None
            m_largest_turns = None

    return RunSnapshot(
        run_id=run_id,
        status=status,
        scope_kind=str(scope.get("kind") or ""),
        repo_name=repo_name,
        repo_path=repo_path,
        repo_path_tail=repo_tail,
        branch_name=str(worktree.get("branch_name") or ""),
        worktree_name=str(worktree.get("name") or ""),
        run_dir=str(rd),
        worktree_path=worktree_path,
        created_at=created_at,
        updated_at=updated_at,
        age_seconds=age_s,
        total_age_seconds=total_age_s,
        time_in_stage_seconds=time_in_stage_s,
        is_live=is_live,
        build_iterations=_maybe_int(build.get("iterations")),
        build_max_iterations=_maybe_int(build.get("max_iterations")),
        build_exit_reason=_maybe_str(build.get("exit_reason")),
        build_md_exists=build_md_exists,
        avg_iteration_seconds=avg_iter_seconds,
        ac_total=ac_total,
        ac_covered=ac_covered,
        ac_table_missing=ac_table_missing,
        diff_added=diff_added,
        diff_removed=diff_removed,
        diff_files=diff_files,
        review_completed=bool(validation.get("review_completed")),
        qa_completed=bool(validation.get("qa_completed")),
        tests_passed=tests_passed if isinstance(tests_passed, bool) else None,
        known_issues_count=known_issues_count,
        tests_recorded_age_seconds=tests_age,
        followups_entry_count=followups_entry_count,
        followups_categories=fu_categories,
        is_stale_human_review=is_stale,
        builder_gave_up=builder_gave_up,
        failing_tests=failing_tests,
        has_known_issues=has_known_issues,
        has_recent_error=has_recent_error,
        bounce_count=bounce_count,
        recent_bounce_reason=recent_bounce_reason,
        bounced_from=bounced_from,
        bounced_at_age_seconds=bounced_at_age_s,
        worktree_missing=worktree_missing,
        completed_at=_maybe_str(completion.get("completed_at")),
        accepted_by=_maybe_str(completion.get("accepted_by")),
        abandoned_reason=_maybe_str(completion.get("abandoned_reason")),
        completion_ref=_maybe_str(completion.get("completion_ref")),
        recent_events=tuple(recent),
        metrics_total_tokens=m_total,
        metrics_approves=m_appr,
        metrics_validate_attempts=m_val,
        metrics_cost_usd=m_cost,
        metrics_largest_session_turns=m_largest_turns,
        source=source,
    )


def _quick_metrics_from_jsonl(path: pathlib.Path) -> tuple[int, int, int, float, int | None]:
    """Cheap pass over metrics.jsonl for the board card.

    Returns ``(total_tokens, approves, validate_attempts, cost_usd,
    largest_session_turns)``. Avoids the full summary recomputation so the
    board stays snappy.

    Cached on (path, mtime_ns). metrics.jsonl is the largest hot-path file we
    re-read on every snapshot (thousands of lines per active run); skipping
    the parse when nothing's changed is a meaningful win.
    """
    try:
        st = path.stat()
    except OSError:
        return 0, 0, 0, 0.0, None
    key = str(path)
    cached = _METRICS_CACHE.get(key)
    if cached is not None and cached[0] == st.st_mtime_ns:
        return cached[1]
    result = _quick_metrics_from_jsonl_uncached(path)
    _METRICS_CACHE[key] = (st.st_mtime_ns, result)
    return result


def _quick_metrics_from_jsonl_uncached(path: pathlib.Path) -> tuple[int, int, int, float, int | None]:
    import json as _json
    total = 0
    appr = 0
    val = 0
    cost = 0.0
    session_counts: dict[str, int] = {}
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                row = _json.loads(line)
            except _json.JSONDecodeError:
                continue
            if row.get("kind") == "turn":
                u = row.get("usage") or {}
                total += int(
                    (u.get("input") or 0)
                    + (u.get("output") or 0)
                    + (u.get("cache_read") or 0)
                    + (u.get("cache_creation") or 0)
                )
                cost += float(row.get("cost_usd") or 0)
                sid = (row.get("transcript_ref") or {}).get("session_id") or ""
                if sid:
                    session_counts[sid] = session_counts.get(sid, 0) + 1
            elif row.get("kind") == "build_outcome":
                val += 1
                if row.get("validate_result") == "approve":
                    appr += 1
    largest = max(session_counts.values()) if session_counts else None
    return total, appr, val, cost, largest


def _maybe_int(v: Any) -> int | None:
    try:
        return int(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _maybe_str(v: Any) -> str | None:
    if v is None:
        return None
    s = str(v)
    return s or None


def stale_threshold_seconds(cfg: Config) -> int:
    board = (cfg.raw.get("board") or {})
    hours = int(board.get("stale_human_review_hours", 24))
    return hours * 3600


def is_loud(run: RunSnapshot) -> bool:
    """Cards that should get a red bar / loud column marker."""
    return severity(run) != SEVERITY_NONE


def severity(run: RunSnapshot) -> str:
    """Return SEVERITY_BLOCKING, SEVERITY_WARNING, or SEVERITY_NONE.

    Blocking = a human must act before this run can move (failing tests,
    builder gave up, stale-stuck human_review). Warning = the run is
    moving but something deserves a look (known issues, recent error,
    worktree gone missing).
    """
    if run.failing_tests:
        return SEVERITY_BLOCKING
    if run.builder_gave_up:
        return SEVERITY_BLOCKING
    if run.is_stale_human_review:
        return SEVERITY_BLOCKING
    if run.has_known_issues:
        return SEVERITY_WARNING
    if run.has_recent_error:
        return SEVERITY_WARNING
    if run.worktree_missing:
        return SEVERITY_WARNING
    return SEVERITY_NONE


def severity_reason(run: RunSnapshot) -> str | None:
    """One-line human-readable reason for the current severity. None if quiet."""
    if run.failing_tests:
        return "tests failing"
    if run.builder_gave_up:
        mx = run.build_max_iterations or "?"
        cur = run.build_iterations if run.build_iterations is not None else mx
        return f"builder gave up {cur}/{mx}"
    if run.is_stale_human_review:
        return "stale human_review"
    if run.has_known_issues:
        n = run.known_issues_count
        return f"{n} known issue{'s' if n != 1 else ''}"
    if run.has_recent_error:
        return "recent error recorded"
    if run.worktree_missing:
        return "worktree missing"
    return None


def abbreviate_path(path: str, *, workbench_root: str | None = None, home: str | None = None) -> str:
    """Compress a path for card display.

    Replaces the workbench root with ``…`` and the user's home with ``~``.
    Workbench substitution wins when the workbench is nested inside home,
    because the user is more often inside the workbench than at $HOME.
    """
    if not path:
        return ""
    import os
    s = path
    home = home if home is not None else os.path.expanduser("~")
    if workbench_root and s.startswith(workbench_root.rstrip("/")):
        s = "…" + s[len(workbench_root.rstrip("/")):]
    elif home and s.startswith(home.rstrip("/")):
        s = "~" + s[len(home.rstrip("/")):]
    return s
