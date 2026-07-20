"""Smoke tests for the `agent-workbench metrics` CLI."""
from __future__ import annotations

import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

from tests._helpers import make_tmp_workbench
from tests.test_metrics_summary import _write_metadata


ROOT = pathlib.Path(__file__).resolve().parent.parent
CLI = ROOT / "bin" / "agent-workbench"


def _run_cli(workbench_root: pathlib.Path, *args) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["AGENT_WORKBENCH_ROOT"] = str(workbench_root)
    return subprocess.run(
        [sys.executable, str(CLI), "--root", str(workbench_root), *args],
        capture_output=True, text=True, env=env,
    )


class TestMetricsCLI(unittest.TestCase):
    def setUp(self):
        self.tmp = make_tmp_workbench()
        shutil.copytree(ROOT / "bin", self.tmp / "bin")
        shutil.copytree(ROOT / "lib", self.tmp / "lib")
        # Seed prices.yaml so the writer can compute cost.
        (self.tmp / "metrics").mkdir(parents=True, exist_ok=True)
        shutil.copy(ROOT / "metrics" / "prices.yaml", self.tmp / "metrics" / "prices.yaml")
        # Seed a finished run with a hand-rolled metrics.jsonl.
        run_id = "2026-05-22-r1"
        rd = self.tmp / "runs" / run_id
        _write_metadata(rd, run_id, status="done")
        rows = [
            {"schema_version": 1, "kind": "header", "at": "x", "run_id": run_id},
            {"schema_version": 1, "kind": "turn", "at": "2026-05-22T10:00:00Z",
             "stage": "building", "command": "/build", "model": "claude-opus-4-7",
             "usage": {"input": 100, "output": 10, "cache_read": 0, "cache_creation": 0},
             "bucket_attribution": {"system_prompt": 5, "tool_defs": 10, "claude_md_and_agents_md": 5,
                                    "context_imports": 0, "slash_command_body": 5, "user_messages": 30,
                                    "assistant_history": 0, "tool_results": 45, "other": 0},
             "transcript_ref": {"session_id": "sess-fixture", "path": "x", "turn_id": "t1"},
             "cost_usd": 0.0023},
            {"schema_version": 1, "kind": "build_outcome", "at": "2026-05-22T10:30:00Z",
             "attempt": 1, "validate_result": "approve"},
            {"schema_version": 1, "kind": "line_count", "phase": "generated", "lines": 50},
            {"schema_version": 1, "kind": "line_count", "phase": "accepted", "lines": 0},
        ]
        with (rd / "metrics.jsonl").open("w") as f:
            for r in rows:
                f.write(json.dumps(r, sort_keys=True) + "\n")
        self.run_id = run_id

    def test_single_run_plain(self):
        r = _run_cli(self.tmp, "metrics", self.run_id)
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        # Section headings.
        self.assertIn("Token spend", r.stdout)
        self.assertIn("Build progress", r.stdout)
        self.assertIn("Acceptance", r.stdout)
        # Pass-2: three bucket sub-sections instead of one "Context buckets".
        self.assertIn("input buckets", r.stdout)
        self.assertIn("cache_read buckets", r.stdout)
        self.assertIn("cache_creation buckets", r.stdout)
        # Pass-2 surface fields.
        self.assertIn("cache misses", r.stdout)
        self.assertIn("billable_net_per_passing_build", r.stdout)
        self.assertIn("largest session", r.stdout)
        # Units present.
        self.assertIn("tokens", r.stdout)
        # Cache-read row labeled.
        self.assertIn("cache_read", r.stdout)
        # Bucket bullet present.
        self.assertIn("- tool_results", r.stdout)

    def test_single_run_plain_pre_acceptance_warning(self):
        """When status != done, the report must lead with an acceptance-pending note."""
        r = _run_cli(self.tmp, "metrics", self.run_id)
        # The fixture has status=done so no NOTE is rendered. Create another
        # run with status=building and verify the NOTE shows up there.
        from tests.test_metrics_summary import _write_metadata
        building_id = "2026-05-22-r-building"
        rd = self.tmp / "runs" / building_id
        _write_metadata(rd, building_id, status="building")
        (rd / "metrics.jsonl").write_text(
            json.dumps({"schema_version": 1, "kind": "turn", "at": "x",
                        "stage": "building", "command": "/build", "model": "m",
                        "usage": {"input": 1, "output": 0, "cache_read": 0, "cache_creation": 0},
                        "bucket_attribution": {}, "cost_usd": 0.0}, sort_keys=True) + "\n"
        )
        r2 = _run_cli(self.tmp, "metrics", building_id)
        self.assertEqual(r2.returncode, 0, msg=r2.stderr)
        self.assertIn("acceptance pending", r2.stdout)

    def test_single_run_json(self):
        r = _run_cli(self.tmp, "metrics", self.run_id, "--json")
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        out = json.loads(r.stdout)
        self.assertEqual(out["run_id"], self.run_id)
        self.assertEqual(out["total_tokens"], 110)
        self.assertEqual(out["approves"], 1)

    def test_all_rollup(self):
        r = _run_cli(self.tmp, "metrics", "--all")
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        self.assertIn("workbench rollup", r.stdout)
        self.assertIn("first_pass_rate", r.stdout)

    def test_rebuild(self):
        r = _run_cli(self.tmp, "metrics", "--rebuild")
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        idx = self.tmp / "metrics" / "index.json"
        self.assertTrue(idx.exists())
        data = json.loads(idx.read_text())
        self.assertGreaterEqual(data["totals"]["runs"], 1)


if __name__ == "__main__":
    unittest.main()
