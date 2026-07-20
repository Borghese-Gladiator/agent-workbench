"""Unit tests for lib.metrics.summary."""
from __future__ import annotations

import json
import pathlib
import shutil
import tempfile
import unittest

from tests._helpers import make_tmp_workbench  # noqa: F401


def _write_metrics(rd: pathlib.Path, rows: list[dict]) -> None:
    rd.mkdir(parents=True, exist_ok=True)
    with (rd / "metrics.jsonl").open("w") as f:
        for r in rows:
            f.write(json.dumps(r, sort_keys=True) + "\n")


def _write_metadata(rd: pathlib.Path, run_id: str, status: str = "done",
                    scope_kind: str = "implementation", completion_ref=None):
    rd.mkdir(parents=True, exist_ok=True)
    meta = {
        "schema_version": 1,
        "run_id": run_id,
        "status": status,
        "created_at": "2026-05-22T00:00:00-04:00",
        "updated_at": "2026-05-22T01:00:00-04:00",
        "target": {
            "repo": {
                "mode": "existing",
                "path": "/tmp/x",
                "name": "x",
                "base_ref": "HEAD",
                "fingerprint": None,
                "created_by_run": None,
            },
            "worktree": {
                "name": "w",
                "path": None,
                "branch_name": "agent/w",
                "created": False,
                "base_ref": "HEAD",
                "initial_commit_sha": None,
            },
        },
        "scope": {"kind": scope_kind, "summary": ""},
        "artifacts": {
            "raw_idea": "raw-idea.md",
            "answers": None,
            "brief": None,
            "plan": None,
            "preflight": None,
            "assumptions": None,
            "decisions": None,
            "implementation_summary": None,
            "diff_summary": None,
            "review_report": None,
            "qa_report": None,
            "audit": None,
            "handoff": None,
        },
        "validation": {
            "required": True,
            "review_completed": False,
            "qa_completed": False,
            "qa_recorded": False,
            "tests_passed": None,
            "known_issues_count": 0,
        },
        "completion": {
            "accepted_by": None,
            "completion_ref": completion_ref,
            "completed_at": None,
            "abandoned_reason": None,
        },
        "build": {
            "iterations": None,
            "exit_reason": None,
            "max_iterations": 5,
        },
    }
    from lib import yaml_io
    (rd / "metadata.yaml").write_text(yaml_io.dumps(meta))


class TestSummarize(unittest.TestCase):
    def setUp(self):
        self.tmp = make_tmp_workbench()
        from lib import config as config_mod
        self.cfg = config_mod.load(self.tmp)

    def _make_run(self, run_id: str, rows: list[dict], **meta_kw):
        rd = self.tmp / "runs" / run_id
        _write_metadata(rd, run_id, **meta_kw)
        _write_metrics(rd, rows)
        return rd

    def test_basic_totals(self):
        from lib.metrics import summary as summ
        rows = [
            {"schema_version": 1, "kind": "header", "at": "x", "run_id": "r1"},
            {
                "schema_version": 1, "kind": "turn", "at": "2026-05-22T10:00:00Z",
                "stage": "building", "command": "/build", "model": "claude-opus-4-7",
                "usage": {"input": 100, "output": 20, "cache_read": 1000, "cache_creation": 0},
                "bucket_attribution": {"system_prompt": 10, "tool_defs": 20, "claude_md_and_agents_md": 5,
                                       "context_imports": 0, "slash_command_body": 5, "user_messages": 30,
                                       "assistant_history": 0, "tool_results": 30, "other": 0},
                "cost_usd": 0.05,
            },
            {
                "schema_version": 1, "kind": "build_outcome", "at": "2026-05-22T10:30:00Z",
                "attempt": 1, "validate_result": "approve",
            },
            {"schema_version": 1, "kind": "line_count", "phase": "generated", "lines": 42},
            {"schema_version": 1, "kind": "line_count", "phase": "accepted", "lines": 30, "merge_commit": "abc1234"},
        ]
        self._make_run("r1", rows)
        s = summ.summarize(self.cfg, "r1")
        self.assertEqual(s.total_input, 100)
        self.assertEqual(s.total_output, 20)
        self.assertEqual(s.total_cache_read, 1000)
        self.assertEqual(s.total_tokens, 100 + 20 + 1000 + 0)
        self.assertEqual(s.approves, 1)
        self.assertEqual(s.validate_attempts, 1)
        self.assertEqual(s.tokens_per_passing_build, 1120.0)
        self.assertEqual(s.generated_lines, 42)
        self.assertEqual(s.accepted_lines, 30)
        self.assertEqual(s.merge_commit, "abc1234")
        # Done status + merge commit → accepted cost == generated cost.
        self.assertEqual(s.cost_accepted_usd, s.cost_generated_usd)
        self.assertGreater(s.bucket_totals["tool_results"], 0)

    def test_no_approves_means_tpb_none(self):
        from lib.metrics import summary as summ
        rows = [
            {"schema_version": 1, "kind": "turn", "at": "x",
             "stage": "building", "command": "/build", "model": "m",
             "usage": {"input": 5, "output": 0, "cache_read": 0, "cache_creation": 0},
             "bucket_attribution": {}, "cost_usd": 0},
            {"schema_version": 1, "kind": "build_outcome", "at": "y", "attempt": 1,
             "validate_result": "request_changes"},
        ]
        self._make_run("r2", rows, status="building")
        s = summ.summarize(self.cfg, "r2")
        self.assertIsNone(s.tokens_per_passing_build)
        self.assertEqual(s.approves, 0)

    def test_repair_tokens_zero_with_single_outcome(self):
        from lib.metrics import summary as summ
        rows = [
            {"schema_version": 1, "kind": "turn", "at": "10:00",
             "stage": "building", "command": "/build", "model": "m",
             "usage": {"input": 100, "output": 0, "cache_read": 0, "cache_creation": 0},
             "bucket_attribution": {}, "cost_usd": 0},
            {"schema_version": 1, "kind": "build_outcome", "at": "10:30",
             "attempt": 1, "validate_result": "approve"},
        ]
        self._make_run("r3", rows)
        s = summ.summarize(self.cfg, "r3")
        self.assertEqual(s.repair_tokens, 0)

    def test_repair_tokens_after_request_changes(self):
        from lib.metrics import summary as summ
        rows = [
            {"schema_version": 1, "kind": "turn", "at": "2026-05-22T10:00:00Z",
             "stage": "building", "command": "/build", "model": "m",
             "usage": {"input": 100, "output": 0, "cache_read": 0, "cache_creation": 0},
             "bucket_attribution": {}, "cost_usd": 0},
            {"schema_version": 1, "kind": "build_outcome", "at": "2026-05-22T10:10:00Z",
             "attempt": 1, "validate_result": "request_changes"},
            {"schema_version": 1, "kind": "turn", "at": "2026-05-22T10:20:00Z",
             "stage": "building", "command": "/build", "model": "m",
             "usage": {"input": 50, "output": 0, "cache_read": 0, "cache_creation": 0},
             "bucket_attribution": {}, "cost_usd": 0},
            {"schema_version": 1, "kind": "build_outcome", "at": "2026-05-22T10:30:00Z",
             "attempt": 2, "validate_result": "approve"},
        ]
        self._make_run("r4", rows)
        s = summ.summarize(self.cfg, "r4")
        # The second turn's 50 input tokens count as repair.
        self.assertEqual(s.repair_tokens, 50)

    def test_pass2_fields_cache_misses_billable_net_largest_session(self):
        """Pass-2 A6/A7/A8 — summary surfaces the new fields."""
        from lib.metrics import summary as summ
        rows = [
            # Two turns in the same session (sess-A) — large session candidate.
            {"schema_version": 2, "kind": "turn", "at": "2026-05-22T10:00:00Z",
             "stage": "building", "command": "/build", "model": "m",
             "usage": {"input": 100, "output": 10, "cache_read": 50_000, "cache_creation": 5_000},
             "bucket_attribution": {}, "cache_read_attribution": {"system_prompt": 50_000},
             "cache_creation_attribution": {"user_messages": 5_000},
             "transcript_ref": {"session_id": "sess-A", "path": "x", "turn_id": "t1"},
             "cost_usd": 0.10},
            {"schema_version": 2, "kind": "turn", "at": "2026-05-22T10:01:00Z",
             "stage": "building", "command": "/build", "model": "m",
             "usage": {"input": 50, "output": 5, "cache_read": 50_000, "cache_creation": 200},
             "bucket_attribution": {}, "cache_read_attribution": {"system_prompt": 50_000},
             "cache_creation_attribution": {},
             "transcript_ref": {"session_id": "sess-A", "path": "x", "turn_id": "t2"},
             "cost_usd": 0.10},
            # One turn in a smaller session.
            {"schema_version": 2, "kind": "turn", "at": "2026-05-22T10:02:00Z",
             "stage": "validating", "command": "/validate", "model": "m",
             "usage": {"input": 10, "output": 1, "cache_read": 1000, "cache_creation": 2000},
             "bucket_attribution": {}, "cache_read_attribution": {},
             "cache_creation_attribution": {},
             "transcript_ref": {"session_id": "sess-B", "path": "x", "turn_id": "t3"},
             "cost_usd": 0.01},
            {"schema_version": 1, "kind": "build_outcome", "at": "z",
             "attempt": 1, "validate_result": "approve"},
        ]
        self._make_run("r-pass2", rows, status="done", completion_ref="merge:abc")
        s = summ.summarize(self.cfg, "r-pass2")
        # A8: largest session by turn count.
        self.assertEqual(s.largest_session_id, "sess-A")
        self.assertEqual(s.largest_session_turns, 2)
        # A6: cache_misses = turns with cache_creation > 1000.
        # sess-A turn 1 (5000) yes; sess-A turn 2 (200) no; sess-B (2000) yes.
        self.assertEqual(s.cache_misses, 2)
        # A7: billable_net excludes cache_read.
        # total_input=160, total_output=16, total_cc=7200 → 7376 / 1 approve.
        self.assertEqual(s.billable_net_per_passing_build, 7376.0)
        # A4: pass-2 cache_read_by_bucket / cache_creation_by_bucket.
        self.assertEqual(s.cache_read_by_bucket["system_prompt"], 100_000)
        self.assertEqual(s.cache_creation_by_bucket["user_messages"], 5_000)

    def test_v1_rows_tolerated(self):
        """schema_version=1 rows pass through; cache buckets are empty."""
        from lib.metrics import summary as summ
        rows = [
            {"schema_version": 1, "kind": "turn", "at": "x",
             "stage": "building", "command": "/build", "model": "m",
             "usage": {"input": 100, "output": 0, "cache_read": 50_000, "cache_creation": 0},
             "bucket_attribution": {"user_messages": 100}, "cost_usd": 0.01,
             "transcript_ref": {"session_id": "s1", "path": "x", "turn_id": "t"}},
        ]
        self._make_run("r-v1", rows, status="building")
        s = summ.summarize(self.cfg, "r-v1")
        self.assertEqual(s.total_cache_read, 50_000)
        # No cache_read_attribution on the v1 row → bucket totals are zero.
        self.assertEqual(sum(s.cache_read_by_bucket.values()), 0)
        # Largest session still computed from transcript_ref.
        self.assertEqual(s.largest_session_id, "s1")

    def test_summary_cache_round_trip(self):
        from lib.metrics import summary as summ
        rows = [
            {"schema_version": 1, "kind": "turn", "at": "x",
             "stage": "building", "command": "/build", "model": "m",
             "usage": {"input": 100, "output": 0, "cache_read": 0, "cache_creation": 0},
             "bucket_attribution": {}, "cost_usd": 0.01},
        ]
        self._make_run("r5", rows, status="building")
        summ.write_summary_cache(self.cfg, "r5")
        cached = summ.read_summary_cache(self.cfg, "r5")
        self.assertIsNotNone(cached)
        self.assertEqual(cached["total_tokens"], 100)


if __name__ == "__main__":
    unittest.main()
