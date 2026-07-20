"""Unit tests for the wb-watch.py TUI's pure-logic helpers.

The curses loop itself is not tested — that's terminal plumbing. We test
the rendering inputs: collect_rows, _format_age, _short_actor,
_evidence_pending.

Run from the workbench root:
    PYTHONPATH=. python3 -m unittest tests.test_wb_watch
"""

from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

WORKBENCH_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKBENCH_ROOT))


def _load_wb_watch():
    """Load wb-watch.py as a real module via importlib.

    Register it in sys.modules first so dataclasses' __module__ lookup
    succeeds (otherwise the module exists in the loader but not in
    sys.modules, and @dataclass fails at class-creation time).
    """
    path = WORKBENCH_ROOT / "scripts" / "wb-watch.py"
    spec = importlib.util.spec_from_file_location("wb_watch", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["wb_watch"] = module
    spec.loader.exec_module(module)
    return module


wb_watch = _load_wb_watch()


class TestFormatAge(unittest.TestCase):
    def test_seconds(self):
        self.assertEqual(wb_watch._format_age(10), "10s")
        self.assertEqual(wb_watch._format_age(59), "59s")

    def test_minutes(self):
        self.assertEqual(wb_watch._format_age(60), "1m")
        self.assertEqual(wb_watch._format_age(150), "2m")
        self.assertEqual(wb_watch._format_age(3599), "59m")

    def test_hours(self):
        self.assertEqual(wb_watch._format_age(3600), "1h")
        self.assertEqual(wb_watch._format_age(7200), "2h")
        self.assertEqual(wb_watch._format_age(86399), "23h")

    def test_days(self):
        self.assertEqual(wb_watch._format_age(86400), "1d")
        self.assertEqual(wb_watch._format_age(200_000), "2d")


class TestShortActor(unittest.TestCase):
    def test_script_actor(self):
        self.assertEqual(
            wb_watch._short_actor("script:create-worktree.sh"),
            "create-worktree",
        )

    def test_slash_actor(self):
        self.assertEqual(wb_watch._short_actor("slash:normalize"), "normalize")

    def test_passthrough_when_no_colon(self):
        self.assertEqual(wb_watch._short_actor("human"), "human")

    def test_empty(self):
        self.assertEqual(wb_watch._short_actor(""), "")


class TestEvidencePending(unittest.TestCase):
    def _md(self, status: str, run_type: str = "feature"):
        from lib.metadata import Metadata
        return Metadata(
            run_id="2026-05-17-x-001",
            feature_slug="x",
            repo_key="testrepo",
            repo_path="/tmp/x",
            github_repo="org/x",
            default_branch="main",
            branch_name="ai/2026-05-17-x-001",
            status=status,
            run_type=run_type,
        )

    def test_in_progress_needs_pr_url(self):
        self.assertIn("pr_url", wb_watch._evidence_pending(self._md("in_progress")))

    def test_brainstorm_needs_approved_by(self):
        self.assertIn("approved_by", wb_watch._evidence_pending(self._md("brainstorm")))

    def test_terminal_states_have_no_pending_evidence(self):
        self.assertEqual(wb_watch._evidence_pending(self._md("merged")), "")
        self.assertEqual(wb_watch._evidence_pending(self._md("abandoned")), "")

    def test_qa_needs_merge_evidence(self):
        out = wb_watch._evidence_pending(self._md("qa"))
        self.assertIn("merge_sha", out)
        self.assertIn("pr_url", out)


class TestCollectRows(unittest.TestCase):
    def test_empty_runs_dir(self):
        with tempfile.TemporaryDirectory() as td:
            self.assertEqual(wb_watch.collect_rows(Path(td)), [])

    def test_missing_runs_dir(self):
        self.assertEqual(wb_watch.collect_rows(Path("/nonexistent/path")), [])

    def test_loads_a_real_run_fixture(self):
        from lib.metadata import new_metadata, save
        from lib.events import Event, append

        with tempfile.TemporaryDirectory() as td:
            runs_dir = Path(td)
            run_dir = runs_dir / "2026-05-17-fixture-001"
            run_dir.mkdir()
            md = new_metadata(
                run_id="2026-05-17-fixture-001",
                feature_slug="fixture",
                repo_key="testrepo",
                repo_path="/tmp/x",
                github_repo="org/x",
                default_branch="main",
            )
            save(run_dir, md)
            append(run_dir, Event(
                event_type="TaskCreated",
                actor="script:new-feature.sh",
                to_state="draft",
                payload={"run_id": "2026-05-17-fixture-001"},
            ))

            rows = wb_watch.collect_rows(runs_dir)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0].run_id, "2026-05-17-fixture-001")
            self.assertEqual(rows[0].metadata.status, "draft")
            self.assertEqual(len(rows[0].events), 1)
            self.assertEqual(rows[0].last_event.event_type, "TaskCreated")

    def test_skips_dirs_without_metadata_yaml(self):
        with tempfile.TemporaryDirectory() as td:
            runs_dir = Path(td)
            (runs_dir / "not-a-run").mkdir()
            (runs_dir / ".gitkeep").touch()
            self.assertEqual(wb_watch.collect_rows(runs_dir), [])


if __name__ == "__main__":
    unittest.main()
