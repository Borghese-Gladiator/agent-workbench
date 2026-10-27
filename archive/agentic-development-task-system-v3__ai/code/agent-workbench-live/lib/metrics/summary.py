"""Read metrics.jsonl, derive RunMetricsSummary.

Returns a frozen dataclass with the 8 brief-spec metrics. Memoized on
``(run_id, mtime(metrics.jsonl))`` so repeated reads in the board are cheap.
"""
from __future__ import annotations

import dataclasses
import json
import pathlib
from functools import lru_cache

from lib import metadata as metadata_mod
from lib.metrics import buckets as buckets_mod


METRICS_FILE = "metrics.jsonl"
SUMMARY_FILE = "metrics-summary.json"


@dataclasses.dataclass(frozen=True)
class RunMetricsSummary:
    run_id: str
    status: str
    scope_kind: str | None

    # Token totals (sum across all turns).
    total_tokens: int
    total_input: int
    total_output: int
    total_cache_read: int
    total_cache_creation: int

    # Build outcomes.
    validate_attempts: int
    approves: int
    tokens_per_passing_build: float | None  # None if approves == 0

    # Per-run attempt count (build → validate cycles up to terminal state).
    attempts_per_success: int

    # Bucket histograms (pass-2: three independent streams).
    bucket_totals: dict  # str -> int (input only — back-compat name)
    cache_read_by_bucket: dict  # str -> int (pass-2 A4)
    cache_creation_by_bucket: dict  # str -> int (pass-2 A4)

    # Cache-miss visibility (pass-2 A6). Count of turns whose
    # cache_creation_input_tokens > 1000 — a long pause that re-wrote the
    # cache.
    cache_misses: int

    # Session-turn-count metric (pass-2 A8).
    largest_session_turns: int
    largest_session_id: str

    # Lines.
    generated_lines: int
    accepted_lines: int
    merge_commit: str | None

    # Repair = total minus "first happy path" tokens. First happy path is the
    # tokens consumed during the first /shape /plan /build /validate cycle.
    repair_tokens: int

    # Cost.
    cost_generated_usd: float
    cost_accepted_usd: float  # 0.0 unless meta.status == 'done' and merge sha present

    # Tokens / agent-approved validate (existing) vs. *billable net* /
    # approved validate (pass-2 A7) — the latter excludes cache_read so the
    # metric tracks agent efficiency rather than session length.
    billable_net_per_passing_build: float | None

    # Per-stage / per-command breakdowns (read-only conveniences).
    tokens_by_stage: dict  # stage -> total tokens
    tokens_by_command: dict  # command -> total tokens

    def to_dict(self) -> dict:
        d = dataclasses.asdict(self)
        return d


def _safe_load_rows(metrics_path: pathlib.Path) -> list[dict]:
    out: list[dict] = []
    if not metrics_path.exists():
        return out
    with metrics_path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def _total_tokens(usage: dict) -> int:
    return int(
        (usage.get("input") or 0)
        + (usage.get("output") or 0)
        + (usage.get("cache_read") or 0)
        + (usage.get("cache_creation") or 0)
    )


def summarize(cfg, run_id: str) -> RunMetricsSummary:
    """Public entry: read ``metrics.jsonl`` and produce a summary."""
    rd = metadata_mod.run_dir(cfg, run_id)
    metrics_path = rd / METRICS_FILE
    rows = _safe_load_rows(metrics_path)
    meta = metadata_mod.load(cfg, run_id)

    turn_rows = [r for r in rows if r.get("kind") == "turn"]
    outcome_rows = [r for r in rows if r.get("kind") == "build_outcome"]
    line_rows = [r for r in rows if r.get("kind") == "line_count"]

    total_input = sum(int(r["usage"].get("input", 0) or 0) for r in turn_rows)
    total_output = sum(int(r["usage"].get("output", 0) or 0) for r in turn_rows)
    total_cr = sum(int(r["usage"].get("cache_read", 0) or 0) for r in turn_rows)
    total_cc = sum(int(r["usage"].get("cache_creation", 0) or 0) for r in turn_rows)
    total_tokens = total_input + total_output + total_cr + total_cc

    bucket_totals = buckets_mod.merge(
        r.get("bucket_attribution") or {} for r in turn_rows
    )
    cache_read_by_bucket = buckets_mod.merge(
        r.get("cache_read_attribution") or {} for r in turn_rows
    )
    cache_creation_by_bucket = buckets_mod.merge(
        r.get("cache_creation_attribution") or {} for r in turn_rows
    )

    # A6: cache misses = turns whose cache_creation crossed the 1k threshold.
    # A long pause (> 5 min cache TTL) re-writes the cache; we count those.
    cache_misses = sum(
        1 for r in turn_rows
        if int((r.get("usage") or {}).get("cache_creation", 0) or 0) > 1000
    )

    # A8: largest session by turn count.
    session_counts: dict[str, int] = {}
    for r in turn_rows:
        sid = (r.get("transcript_ref") or {}).get("session_id") or ""
        if sid:
            session_counts[sid] = session_counts.get(sid, 0) + 1
    if session_counts:
        largest_session_id = max(session_counts, key=lambda k: session_counts[k])
        largest_session_turns = session_counts[largest_session_id]
    else:
        largest_session_id = ""
        largest_session_turns = 0

    approves = sum(1 for r in outcome_rows if r.get("validate_result") == "approve")
    validate_attempts = len(outcome_rows)
    tokens_per_passing = (total_tokens / approves) if approves > 0 else None

    # A7: billable net per passing build = (input + output + cache_creation) /
    # approves. Excludes cache_read so the metric tracks agent efficiency
    # rather than session length.
    billable_net = total_input + total_output + total_cc
    billable_net_per_passing = (
        billable_net / approves if approves > 0 else None
    )

    cost_gen = round(sum(float(r.get("cost_usd") or 0) for r in turn_rows), 6)
    is_done = meta.get("status") == "done"

    gen_lines = next((int(r.get("lines") or 0) for r in line_rows if r.get("phase") == "generated"), 0)
    acc_row = next((r for r in line_rows if r.get("phase") == "accepted"), None)
    acc_lines = int((acc_row or {}).get("lines") or 0)
    merge_sha = (acc_row or {}).get("merge_commit")

    cost_accepted = cost_gen if (is_done and merge_sha) else 0.0

    # Repair tokens: tokens after the first build → validate cycle.
    # Approach: walk turn rows in order, mark the first cycle (shape → plan →
    # build → validate, stages = {shaping, planning, building, validating}).
    # Anything after the first ``ReviewCompleted`` event row that's not
    # ``approve`` (or after any second ``building`` re-entry) counts as repair.
    repair_tokens = _compute_repair_tokens(turn_rows, outcome_rows)

    # Attempts per success: number of build → validate cycles.
    attempts_per_success = max(1, validate_attempts) if validate_attempts else 0
    if attempts_per_success == 0 and meta.get("status") in ("done", "abandoned"):
        # Edge case: terminal with no validate outcomes (shouldn't happen, but
        # be defensive).
        attempts_per_success = 1

    tokens_by_stage: dict[str, int] = {}
    tokens_by_command: dict[str, int] = {}
    for r in turn_rows:
        tt = _total_tokens(r.get("usage") or {})
        s = r.get("stage") or "other"
        c = r.get("command") or ""
        tokens_by_stage[s] = tokens_by_stage.get(s, 0) + tt
        tokens_by_command[c] = tokens_by_command.get(c, 0) + tt

    return RunMetricsSummary(
        run_id=run_id,
        status=meta.get("status") or "",
        scope_kind=(meta.get("scope") or {}).get("kind"),
        total_tokens=total_tokens,
        total_input=total_input,
        total_output=total_output,
        total_cache_read=total_cr,
        total_cache_creation=total_cc,
        validate_attempts=validate_attempts,
        approves=approves,
        tokens_per_passing_build=tokens_per_passing,
        attempts_per_success=attempts_per_success,
        bucket_totals=bucket_totals,
        cache_read_by_bucket=cache_read_by_bucket,
        cache_creation_by_bucket=cache_creation_by_bucket,
        cache_misses=cache_misses,
        largest_session_turns=largest_session_turns,
        largest_session_id=largest_session_id,
        generated_lines=gen_lines,
        accepted_lines=acc_lines,
        merge_commit=merge_sha,
        repair_tokens=repair_tokens,
        cost_generated_usd=cost_gen,
        cost_accepted_usd=cost_accepted,
        billable_net_per_passing_build=billable_net_per_passing,
        tokens_by_stage=tokens_by_stage,
        tokens_by_command=tokens_by_command,
    )


def _compute_repair_tokens(turn_rows: list[dict], outcome_rows: list[dict]) -> int:
    """Tokens spent on repair = total minus tokens spent in the first happy
    path through {shaping, planning, building, validating} before the first
    APPROVE.

    Heuristic: if outcomes has 0 or 1 entries (first APPROVE or none), repair =
    0. Otherwise, sum every turn whose timestamp is after the first
    ``ReviewCompleted`` whose decision was NOT ``approve``.
    """
    if len(outcome_rows) < 2:
        return 0
    # Find the first non-approve outcome.
    threshold_ts = None
    for r in outcome_rows:
        if r.get("validate_result") != "approve":
            threshold_ts = r.get("at")
            break
    if not threshold_ts:
        return 0
    repair = 0
    for r in turn_rows:
        if (r.get("at") or "") >= threshold_ts:
            repair += _total_tokens(r.get("usage") or {})
    return repair


def write_summary_cache(cfg, run_id: str) -> pathlib.Path:
    """Materialize ``metrics-summary.json`` on disk for cheap board reads."""
    summary = summarize(cfg, run_id)
    rd = metadata_mod.run_dir(cfg, run_id)
    path = rd / SUMMARY_FILE
    path.write_text(json.dumps(summary.to_dict(), sort_keys=True, indent=2))
    return path


def read_summary_cache(cfg, run_id: str) -> dict | None:
    """Return cached dict from ``metrics-summary.json``, or None if absent /
    stale. Stale = ``metrics.jsonl`` mtime newer than the cache."""
    rd = metadata_mod.run_dir(cfg, run_id)
    summary_path = rd / SUMMARY_FILE
    metrics_path = rd / METRICS_FILE
    if not summary_path.exists():
        return None
    if metrics_path.exists():
        if summary_path.stat().st_mtime < metrics_path.stat().st_mtime:
            return None
    try:
        return json.loads(summary_path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
