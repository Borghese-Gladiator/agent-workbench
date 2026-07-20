"""Tests for the FS-event debounce + filter in lib/board/app.py.

We don't spin up a Textual event loop; the methods under test
(`_mark_fs_dirty`, `_drain_fs_events`) are pure-Python state machines.
"""
from __future__ import annotations

import pathlib
import shutil
import sys
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from lib import config  # noqa: E402
from lib.board.app import (  # noqa: E402
    AgentBoardApp,
    BoardOptions,
    _FS_DEBOUNCE_SECONDS,
    _Handler,
)


class _Event:
    """Stand-in for a watchdog FileSystemEvent."""
    def __init__(self, src_path: str) -> None:
        self.src_path = src_path


class DebounceCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="aw-debounce-"))
        shutil.copy(ROOT / "agent-workbench.yaml", self.tmp / "agent-workbench.yaml")
        shutil.copytree(ROOT / "schemas", self.tmp / "schemas")
        self.cfg = config.load(self.tmp)
        self.app = AgentBoardApp(self.cfg, BoardOptions())
        # Stub out _refresh so a fired drain doesn't try to read disk.
        self.app._refresh = mock.MagicMock()
        self.handler = _Handler(self.app)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)


class TestHandlerFilters(DebounceCase):
    """`_Handler.on_any_event` drops events the board doesn't care about
    before they ever reach the dirty flag."""

    def test_tmp_suffix_dropped(self) -> None:
        self.handler.on_any_event(_Event("/runs/abc/metadata.yaml.tmp"))
        self.assertEqual(self.app._fs_dirty_at, 0.0)

    def test_dot_prefixed_basename_dropped(self) -> None:
        self.handler.on_any_event(_Event("/runs/.DS_Store"))
        self.handler.on_any_event(_Event("/runs/abc/.swp"))
        self.assertEqual(self.app._fs_dirty_at, 0.0)

    def test_archive_path_dropped(self) -> None:
        self.handler.on_any_event(_Event("/runs/abc/archive/old.md"))
        self.assertEqual(self.app._fs_dirty_at, 0.0)

    def test_real_metadata_event_marks_dirty(self) -> None:
        self.handler.on_any_event(_Event("/runs/abc/metadata.yaml"))
        self.assertGreater(self.app._fs_dirty_at, 0.0)


class TestDebounceDrain(DebounceCase):
    """`_drain_fs_events` fires exactly one refresh per quiet window."""

    def test_clean_state_does_nothing(self) -> None:
        self.app._drain_fs_events()
        self.app._refresh.assert_not_called()

    def test_inside_window_does_not_fire(self) -> None:
        with mock.patch("lib.board.app.time.monotonic") as t:
            t.return_value = 100.0
            self.handler.on_any_event(_Event("/runs/abc/metadata.yaml"))
            t.return_value = 100.0 + _FS_DEBOUNCE_SECONDS / 2
            self.app._drain_fs_events()
        self.app._refresh.assert_not_called()
        # Still dirty — drain didn't clear the flag prematurely.
        self.assertGreater(self.app._fs_dirty_at, 0.0)

    def test_outside_window_fires_once(self) -> None:
        with mock.patch("lib.board.app.time.monotonic") as t:
            t.return_value = 100.0
            self.handler.on_any_event(_Event("/runs/abc/metadata.yaml"))
            t.return_value = 100.0 + _FS_DEBOUNCE_SECONDS + 0.01
            self.app._drain_fs_events()
            # Second drain immediately after — clean state, no second fire.
            self.app._drain_fs_events()
        self.assertEqual(self.app._refresh.call_count, 1)
        self.assertEqual(self.app._fs_dirty_at, 0.0)

    def test_burst_coalesces_to_one_refresh(self) -> None:
        """100 events in a 50ms burst -> exactly one refresh after the
        quiet window elapses. This is the headline guarantee — the board
        previously fired N refreshes per metadata save.
        """
        with mock.patch("lib.board.app.time.monotonic") as t:
            t.return_value = 100.0
            for i in range(100):
                t.return_value = 100.0 + i * 0.0005  # 50ms burst
                self.handler.on_any_event(_Event(f"/runs/abc/file{i}.jsonl"))
            t.return_value = 100.0 + 0.05 + _FS_DEBOUNCE_SECONDS + 0.01
            self.app._drain_fs_events()
        self.assertEqual(self.app._refresh.call_count, 1)

    def test_event_resets_quiet_window(self) -> None:
        """A second event mid-window resets the clock — drain must wait
        the full quiet window from the LATEST event, not the first."""
        with mock.patch("lib.board.app.time.monotonic") as t:
            t.return_value = 100.0
            self.handler.on_any_event(_Event("/runs/abc/metadata.yaml"))
            # Halfway through window, another event arrives.
            t.return_value = 100.0 + _FS_DEBOUNCE_SECONDS / 2
            self.handler.on_any_event(_Event("/runs/abc/events.jsonl"))
            # Past first event's window but still inside the second's.
            t.return_value = 100.0 + _FS_DEBOUNCE_SECONDS + 0.01
            self.app._drain_fs_events()
            self.app._refresh.assert_not_called()
            # Now past second event's window.
            t.return_value = (
                100.0 + _FS_DEBOUNCE_SECONDS / 2
                + _FS_DEBOUNCE_SECONDS + 0.01
            )
            self.app._drain_fs_events()
        self.assertEqual(self.app._refresh.call_count, 1)


if __name__ == "__main__":
    unittest.main()
