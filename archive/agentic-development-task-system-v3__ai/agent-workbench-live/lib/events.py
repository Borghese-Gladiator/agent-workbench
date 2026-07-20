"""Append-only event log.

Each run has runs/<run_id>/events.jsonl. One JSON object per line.

The schema lives in schemas/events.jsonl (one event-type definition per line).
We validate payload required_fields before writing. Malformed writes are rejected
before they hit disk.

Only this module writes events.jsonl.
"""
from __future__ import annotations

import datetime as dt
import json
import pathlib
from functools import lru_cache
from typing import Any

from lib.config import Config
from lib.metadata import load as load_metadata, run_dir


class EventError(Exception):
    pass


SCHEMA_VERSION = 1


@lru_cache(maxsize=1)
def _load_schemas(schemas_path: pathlib.Path) -> dict[str, dict]:
    """Load event-type schemas keyed by event_type. Cached per process."""
    p = schemas_path / "events.jsonl"
    if not p.exists():
        raise EventError(f"event schema not found: {p}")
    out: dict[str, dict] = {}
    for n, line in enumerate(p.read_text().splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        try:
            spec = json.loads(line)
        except json.JSONDecodeError as e:
            raise EventError(f"events.jsonl line {n}: invalid JSON: {e}")
        if spec.get("kind") != "event_schema":
            raise EventError(f"events.jsonl line {n}: kind must be 'event_schema'")
        et = spec.get("event_type")
        if not et:
            raise EventError(f"events.jsonl line {n}: missing event_type")
        out[et] = spec
    return out


def _next_seq(jsonl_path: pathlib.Path) -> int:
    if not jsonl_path.exists():
        return 1
    # Read last line cheaply by counting from the end.
    with open(jsonl_path, "rb") as f:
        try:
            f.seek(-1, 2)
        except OSError:
            return 1
        size = f.tell() + 1
        if size == 0:
            return 1
        chunk = 1024
        data = b""
        while size > 0:
            read = min(chunk, size)
            size -= read
            f.seek(size)
            data = f.read(read) + data
            if b"\n" in data.rstrip(b"\n"):
                break
        lines = [ln for ln in data.splitlines() if ln.strip()]
        if not lines:
            return 1
        try:
            last = json.loads(lines[-1])
        except json.JSONDecodeError:
            raise EventError(f"{jsonl_path}: last line is not valid JSON")
        return int(last.get("seq", 0)) + 1


def _make_event_id(seq: int, now: dt.datetime) -> str:
    return f"evt_{now.strftime('%Y%m%d_%H%M%S')}_{seq:04d}"


def _validate_payload(spec: dict, payload: dict) -> None:
    required = spec.get("payload_required", []) or []
    missing = [k for k in required if k not in payload or payload[k] in (None, "")]
    if missing:
        raise EventError(
            f"event {spec['event_type']!r}: missing required payload fields: {missing}"
        )


def _validate_actor(actor: dict) -> None:
    if not isinstance(actor, dict):
        raise EventError("actor must be a mapping with type and name")
    if "type" not in actor or "name" not in actor:
        raise EventError("actor missing required keys: type, name")
    if actor["type"] not in ("human", "agent", "script", "system"):
        raise EventError(f"actor.type invalid: {actor['type']!r}")


def append(
    cfg: Config,
    run_id: str,
    event_type: str,
    payload: dict,
    actor: dict,
    *,
    from_state: str | None = None,
    to_state: str | None = None,
    extra: dict | None = None,
) -> dict:
    """Append one event to runs/<run_id>/events.jsonl. Returns the written event."""
    schemas = _load_schemas(cfg.schemas_path)
    if event_type not in schemas:
        raise EventError(f"unknown event_type: {event_type!r}")
    spec = schemas[event_type]
    _validate_actor(actor)
    _validate_payload(spec, payload)

    # current status from metadata (events record the status at write time)
    meta = load_metadata(cfg, run_id)
    rd = run_dir(cfg, run_id)
    jsonl = rd / "events.jsonl"
    seq = _next_seq(jsonl)
    now = dt.datetime.now().astimezone().replace(microsecond=0)

    event: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "seq": seq,
        "event_id": _make_event_id(seq, now),
        "run_id": run_id,
        "at": now.isoformat(),
        "actor": actor,
        "type": event_type,
        "status": meta["status"],
        "payload": payload,
    }
    if from_state is not None:
        event["from"] = from_state
    if to_state is not None:
        event["to"] = to_state
    if extra:
        event.update(extra)

    # Re-check that schema-mandated top-level fields are present (e.g. from/to on TransitionApplied).
    for k in spec.get("required_fields", []):
        if k not in event:
            raise EventError(f"event {event_type!r}: missing required top-level field {k!r}")

    line = json.dumps(event, separators=(",", ":")) + "\n"
    with open(jsonl, "a") as f:
        f.write(line)
    return event


def iter_events(cfg: Config, run_id: str):
    """Yield each event for one run in order."""
    jsonl = run_dir(cfg, run_id) / "events.jsonl"
    if not jsonl.exists():
        return
    for line in jsonl.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        yield json.loads(line)
