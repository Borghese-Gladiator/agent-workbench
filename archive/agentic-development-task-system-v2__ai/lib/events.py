"""Append-only event log per run.

Every script and slash command that mutates run state should emit one event
to `runs/<run_id>/events.jsonl`. `metadata.yaml` remains canonical for the
*current* state of a run; the event log is the historical record of how it
got there.

Design points:
- One JSON object per line. POSIX `O_APPEND` makes single-line writes atomic,
  so concurrent appenders don't interleave.
- The event log is additive only. Never rewrite, never truncate.
- A missing `events.jsonl` is treated as an empty log — reads do not fault on
  brand-new runs that have not emitted an event yet.
- Malformed lines raise loudly. Silent skipping would hide bugs in the
  emitters; if the file is corrupt we want to know immediately.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path


class EventError(ValueError):
    """Raised when an event cannot be appended or parsed."""


@dataclass(frozen=True)
class Event:
    event_type: str
    actor: str
    from_state: str = ""
    to_state: str = ""
    payload: dict = field(default_factory=dict)
    created_at: str = ""

    def to_dict(self) -> dict:
        d = asdict(self)
        # Drop the timestamp here; append() always supplies one.
        return d


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _events_path(run_dir: Path) -> Path:
    return run_dir / "events.jsonl"


def append(run_dir: Path, event: Event) -> None:
    """Append one JSON line to runs/<run_id>/events.jsonl.

    Atomic for single-line writes because we use O_APPEND.
    """
    if not run_dir.is_dir():
        raise EventError(f"run dir not found: {run_dir}")
    if not event.event_type:
        raise EventError("event.event_type is required")
    if not event.actor:
        raise EventError("event.actor is required")

    record = event.to_dict()
    record["created_at"] = event.created_at or _now_iso()
    # Preserve a stable key order for readability when grepping.
    ordered = {
        "created_at": record["created_at"],
        "event_type": record["event_type"],
        "actor": record["actor"],
        "from_state": record.get("from_state", ""),
        "to_state": record.get("to_state", ""),
        "payload": record.get("payload", {}),
    }
    line = json.dumps(ordered, separators=(",", ":"), sort_keys=False) + "\n"

    path = _events_path(run_dir)
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
    try:
        os.write(fd, line.encode("utf-8"))
    finally:
        os.close(fd)


def read_all(run_dir: Path) -> list[Event]:
    """Read every event for a run. Returns [] if events.jsonl is missing."""
    path = _events_path(run_dir)
    if not path.exists():
        return []
    events: list[Event] = []
    with path.open("r", encoding="utf-8") as f:
        for lineno, raw in enumerate(f, start=1):
            line = raw.rstrip("\n")
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as exc:
                raise EventError(
                    f"{path}:{lineno}: malformed JSON: {exc}"
                ) from exc
            if not isinstance(obj, dict):
                raise EventError(
                    f"{path}:{lineno}: event must be a JSON object"
                )
            try:
                events.append(
                    Event(
                        event_type=obj["event_type"],
                        actor=obj["actor"],
                        from_state=obj.get("from_state", ""),
                        to_state=obj.get("to_state", ""),
                        payload=obj.get("payload", {}) or {},
                        created_at=obj.get("created_at", ""),
                    )
                )
            except KeyError as exc:
                raise EventError(
                    f"{path}:{lineno}: missing required field {exc}"
                ) from exc
    return events


def last_transition(run_dir: Path) -> Event | None:
    """Return the most recent TransitionApplied event, or None."""
    for event in reversed(read_all(run_dir)):
        if event.event_type == "TransitionApplied":
            return event
    return None
