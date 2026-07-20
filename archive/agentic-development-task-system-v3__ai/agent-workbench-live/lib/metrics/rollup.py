"""Workbench-wide rollup → metrics/index.json.

Walks every ``runs/*/metrics.jsonl``, derives cross-run metrics
(``first_pass_build_rate`` per scope kind, totals across scope kinds, dollars
by month, leaderboard by ``tokens_per_passing_build``) and writes
``agent-workbench-live/metrics/index.json``.

Regenerated on demand only — never edits per-run files.
"""
from __future__ import annotations

import datetime as dt
import json
import pathlib

from lib import metadata as metadata_mod, runs as runs_mod
from lib.metrics import summary as summary_mod


INDEX_FILE = "index.json"


def _now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def _first_pass_for_run(run_summary, run_meta) -> bool | None:
    """Did the run hit APPROVE on the first /validate after the first /build,
    with no subsequent re-validation?

    Returns:
      - True  → first-pass success.
      - False → bounced or required re-validation.
      - None  → run never validated (e.g. still in shaping), excluded from the rate.
    """
    if run_summary.validate_attempts == 0:
        return None
    if run_summary.validate_attempts == 1 and run_summary.approves == 1:
        return True
    return False


def _month_key(ts: str | None) -> str | None:
    if not ts:
        return None
    try:
        if ts.endswith("Z"):
            ts = ts[:-1] + "+00:00"
        d = dt.datetime.fromisoformat(ts)
        return d.strftime("%Y-%m")
    except ValueError:
        return None


def rebuild(cfg) -> pathlib.Path:
    """Walk every run's metrics.jsonl and write metrics/index.json.

    Enumerates the union of master + worktree run dirs via
    ``runs.iter_all_runs`` (TODO §1B2). Per-run reads use the resolved
    ``run.run_dir`` so worktree-side artifacts are picked up correctly.
    """
    summaries: list[dict] = []
    per_scope: dict[str, dict] = {}
    monthly_cost: dict[str, float] = {}
    monthly_accepted: dict[str, float] = {}

    for run in sorted(runs_mod.iter_all_runs(cfg), key=lambda r: r.run_id):
        run_id = run.run_id
        run_dir = run.run_dir
        metrics_path = run_dir / "metrics.jsonl"
        if not metrics_path.exists():
            continue
        run_meta = run.metadata
        try:
            s = summary_mod.summarize(cfg, run_id)
        except Exception:
            continue

        scope = s.scope_kind or "unknown"
        bucket = per_scope.setdefault(
            scope,
            {"runs": 0, "first_pass": 0, "validated": 0,
             "total_tokens": 0, "cost_generated_usd": 0.0,
             "cost_accepted_usd": 0.0},
        )
        bucket["runs"] += 1
        bucket["total_tokens"] += s.total_tokens
        bucket["cost_generated_usd"] += s.cost_generated_usd
        bucket["cost_accepted_usd"] += s.cost_accepted_usd
        fp = _first_pass_for_run(s, run_meta)
        if fp is not None:
            bucket["validated"] += 1
            if fp:
                bucket["first_pass"] += 1

        mk = _month_key(run_meta.get("created_at"))
        if mk:
            monthly_cost[mk] = monthly_cost.get(mk, 0.0) + s.cost_generated_usd
            monthly_accepted[mk] = monthly_accepted.get(mk, 0.0) + s.cost_accepted_usd

        summaries.append({
            "run_id": run_id,
            "status": s.status,
            "scope_kind": s.scope_kind,
            "total_tokens": s.total_tokens,
            "tokens_per_passing_build": s.tokens_per_passing_build,
            "attempts_per_success": s.attempts_per_success,
            "approves": s.approves,
            "validate_attempts": s.validate_attempts,
            "generated_lines": s.generated_lines,
            "accepted_lines": s.accepted_lines,
            "cost_generated_usd": round(s.cost_generated_usd, 6),
            "cost_accepted_usd": round(s.cost_accepted_usd, 6),
            "repair_tokens": s.repair_tokens,
        })

    # Fleet-level first_pass_build_rate (overall + per scope).
    total_validated = sum(b["validated"] for b in per_scope.values())
    total_first_pass = sum(b["first_pass"] for b in per_scope.values())
    overall_rate = (total_first_pass / total_validated) if total_validated > 0 else None

    per_scope_view = {}
    for k, b in per_scope.items():
        v = b["validated"]
        rate = (b["first_pass"] / v) if v > 0 else None
        per_scope_view[k] = {
            "runs": b["runs"],
            "validated": v,
            "first_pass_count": b["first_pass"],
            "first_pass_rate": rate,
            "total_tokens": b["total_tokens"],
            "cost_generated_usd": round(b["cost_generated_usd"], 6),
            "cost_accepted_usd": round(b["cost_accepted_usd"], 6),
        }

    # Leaderboard: top 20 worst tokens_per_passing_build (None entries last).
    def _sort_key(r):
        tpb = r.get("tokens_per_passing_build")
        return (-(tpb or -1), r["run_id"])
    leaderboard = sorted(summaries, key=_sort_key)[:20]

    out = {
        "schema_version": 1,
        "generated_at": _now_iso(),
        "totals": {
            "runs": len(summaries),
            "validated_runs": total_validated,
            "first_pass_count": total_first_pass,
            "first_pass_build_rate": overall_rate,
            "total_tokens": sum(s["total_tokens"] for s in summaries),
            "cost_generated_usd": round(sum(s["cost_generated_usd"] for s in summaries), 6),
            "cost_accepted_usd": round(sum(s["cost_accepted_usd"] for s in summaries), 6),
        },
        "by_scope": per_scope_view,
        "monthly_cost_generated_usd": {k: round(v, 6) for k, v in sorted(monthly_cost.items())},
        "monthly_cost_accepted_usd": {k: round(v, 6) for k, v in sorted(monthly_accepted.items())},
        "leaderboard": leaderboard,
        "runs": summaries,
    }

    metrics_dir = cfg.root / "metrics"
    metrics_dir.mkdir(parents=True, exist_ok=True)
    idx = metrics_dir / INDEX_FILE
    idx.write_text(json.dumps(out, sort_keys=True, indent=2))
    return idx


def load(cfg) -> dict | None:
    p = cfg.root / "metrics" / INDEX_FILE
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except (OSError, json.JSONDecodeError):
        return None
