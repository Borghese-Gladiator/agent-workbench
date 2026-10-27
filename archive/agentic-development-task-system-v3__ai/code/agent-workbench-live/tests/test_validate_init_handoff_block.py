"""Unit tests for the fresh-session handoff block (pass-2 B5) and the
board's session-staleness indicator (A9).
"""
from __future__ import annotations

import io
import unittest
from unittest import mock

from lib.cli import cmd_validate


class TestSessionStalenessThreshold(unittest.TestCase):
    def test_defaults_to_100(self):
        cfg = mock.Mock()
        cfg.raw = {}
        self.assertEqual(cmd_validate._session_staleness_threshold(cfg), 100)

    def test_reads_configured_value(self):
        cfg = mock.Mock()
        cfg.raw = {"session_staleness_threshold_turns": 250}
        self.assertEqual(cmd_validate._session_staleness_threshold(cfg), 250)

    def test_falls_back_to_default_on_bad_value(self):
        cfg = mock.Mock()
        cfg.raw = {"session_staleness_threshold_turns": "not a number"}
        self.assertEqual(cmd_validate._session_staleness_threshold(cfg), 100)


class TestFreshSessionHandoffBlock(unittest.TestCase):
    """B5: when largest_session_turns > threshold, validate --init prints
    a copy-pasteable handoff block."""

    def _meta(self, branch="agent/foo", path="/wt/foo"):
        return {
            "target": {
                "worktree": {"branch_name": branch, "path": path},
            }
        }

    @mock.patch("lib.cli.cmd_validate.metrics_summary.summarize")
    def test_prints_block_when_over_threshold(self, mock_summarize):
        s = mock.Mock()
        s.largest_session_turns = 250
        mock_summarize.return_value = s
        cfg = mock.Mock()
        cfg.raw = {"session_staleness_threshold_turns": 100}
        rd = mock.Mock()
        rd.__truediv__ = lambda self, p: mock.Mock(exists=lambda: True)
        # Set up the metrics.jsonl exists() check.
        import pathlib
        with mock.patch.object(pathlib.Path, "exists", return_value=True):
            buf = io.StringIO()
            with mock.patch("sys.stdout", buf):
                cmd_validate._print_fresh_session_handoff(cfg, "r-1", rd, self._meta())
            out = buf.getvalue()
        self.assertIn("fresh Claude Code session", out)
        self.assertIn("run_id:    r-1", out)
        self.assertIn("branch:    agent/foo", out)
        self.assertIn("worktree:  /wt/foo", out)
        self.assertIn("/validate r-1", out)
        # Block is bordered with `=` rules.
        self.assertIn("=" * 60, out)
        # Reports the actual turn count + threshold.
        self.assertIn("250 turns", out)

    @mock.patch("lib.cli.cmd_validate.metrics_summary.summarize")
    def test_silent_when_under_threshold(self, mock_summarize):
        s = mock.Mock()
        s.largest_session_turns = 50
        mock_summarize.return_value = s
        cfg = mock.Mock()
        cfg.raw = {"session_staleness_threshold_turns": 100}
        import pathlib
        with mock.patch.object(pathlib.Path, "exists", return_value=True):
            buf = io.StringIO()
            with mock.patch("sys.stdout", buf):
                cmd_validate._print_fresh_session_handoff(cfg, "r-1", mock.Mock(), self._meta())
        self.assertEqual(buf.getvalue(), "")

    def test_silent_when_no_metrics_yet(self):
        cfg = mock.Mock()
        cfg.raw = {}
        import pathlib
        with mock.patch.object(pathlib.Path, "exists", return_value=False):
            buf = io.StringIO()
            with mock.patch("sys.stdout", buf):
                cmd_validate._print_fresh_session_handoff(cfg, "r-1", mock.Mock(), self._meta())
        self.assertEqual(buf.getvalue(), "")


class TestBoardMetricsLine(unittest.TestCase):
    """A9: board metrics line gains ` · turns N` when > 100."""

    def test_appends_turns_when_high(self):
        from lib.board import app as board_app
        from tests.test_cmd_board import _make_snapshot
        snap = _make_snapshot(
            metrics_total_tokens=10_000,
            metrics_approves=1,
            metrics_validate_attempts=1,
            metrics_cost_usd=0.05,
            metrics_largest_session_turns=250,
        )
        line = board_app._format_metrics_line(snap)
        self.assertIn("turns 250", line)

    def test_no_suffix_below_threshold(self):
        from lib.board import app as board_app
        from tests.test_cmd_board import _make_snapshot
        snap = _make_snapshot(
            metrics_total_tokens=10_000,
            metrics_approves=1,
            metrics_validate_attempts=1,
            metrics_cost_usd=0.05,
            metrics_largest_session_turns=50,
        )
        line = board_app._format_metrics_line(snap)
        self.assertNotIn("turns", line)

    def test_no_suffix_when_none(self):
        from lib.board import app as board_app
        from tests.test_cmd_board import _make_snapshot
        snap = _make_snapshot(
            metrics_total_tokens=10_000,
            metrics_approves=1,
            metrics_validate_attempts=1,
            metrics_cost_usd=0.05,
            metrics_largest_session_turns=None,
        )
        line = board_app._format_metrics_line(snap)
        self.assertNotIn("turns", line)


if __name__ == "__main__":
    unittest.main()
