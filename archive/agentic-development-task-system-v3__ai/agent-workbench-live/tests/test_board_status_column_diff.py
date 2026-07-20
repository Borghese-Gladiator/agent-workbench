"""Tests for StatusColumn's in-place card diff.

The motivation for PR2 was: every refresh used to call
`self._body.remove_children()` and remount every RunCard, which destroyed
the user's scroll position. The new code reuses widget identity via a
`run_id -> RunCard` dict.

We can't drive Textual without an event loop, but we CAN exercise the
diff logic by stubbing the mount points. This is integration-light: we're
asserting that the right cards survive across calls, not that Textual
renders them correctly (that's covered by the live board smoke test).
"""
from __future__ import annotations

import datetime as dt
import pathlib
import sys
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from lib.board.app import RunCard, StatusColumn  # noqa: E402
from lib.board.source import RunSnapshot  # noqa: E402


def _snap(run_id: str, status: str = "building") -> RunSnapshot:
    """Minimal RunSnapshot for diff tests. We don't care about most fields."""
    return RunSnapshot(
        run_id=run_id,
        status=status,
        scope_kind="implementation",
        repo_name="r",
        repo_path="/r",
        repo_path_tail="r",
        branch_name="b",
        worktree_name="wt",
        run_dir="/r/runs/" + run_id,
        worktree_path="/r/wt",
        created_at="2026-05-27T00:00:00-04:00",
        updated_at="2026-05-27T00:00:00-04:00",
        age_seconds=0.0,
        total_age_seconds=0.0,
        time_in_stage_seconds=None,
        is_live=False,
        build_iterations=None,
        build_max_iterations=None,
        build_exit_reason=None,
        build_md_exists=False,
        avg_iteration_seconds=None,
        ac_total=None,
        ac_covered=None,
        ac_table_missing=False,
        diff_added=None,
        diff_removed=None,
        diff_files=None,
        review_completed=False,
        qa_completed=False,
        tests_passed=None,
        known_issues_count=0,
        tests_recorded_age_seconds=None,
        followups_entry_count=None,
        followups_categories=(),
        is_stale_human_review=False,
        builder_gave_up=False,
        failing_tests=False,
        has_known_issues=False,
        has_recent_error=False,
        bounce_count=0,
        recent_bounce_reason=None,
        bounced_from=None,
        bounced_at_age_seconds=None,
        worktree_missing=False,
        completed_at=None,
        accepted_by=None,
        abandoned_reason=None,
        completion_ref=None,
        recent_events=(),
        metrics_total_tokens=None,
        metrics_approves=None,
        metrics_validate_attempts=None,
        metrics_cost_usd=None,
        metrics_largest_session_turns=None,
    )


class _FakeBody:
    """Stand-in for ScrollableContainer; records mounts and removals."""
    def __init__(self) -> None:
        self.children: list[RunCard] = []

    def mount(self, widget: RunCard, *, before=None) -> None:
        if before is None:
            self.children.append(widget)
        elif isinstance(before, int):
            self.children.insert(before, widget)
        else:
            idx = self.children.index(before)
            self.children.insert(idx, widget)

    def move_child(self, child, *, before=None, after=None) -> None:
        self.children.remove(child)
        if isinstance(before, int):
            self.children.insert(before, child)
        elif before is not None:
            idx = self.children.index(before)
            self.children.insert(idx, child)
        else:
            self.children.append(child)


def _make_column() -> StatusColumn:
    col = StatusColumn("building")
    # Replace the real body with our fake; the column's update_column path
    # only touches body.mount / body.move_child / body.children.
    col._body = _FakeBody()
    # The header Static.update() needs an active Textual app; stub it.
    col._header.update = mock.MagicMock()  # type: ignore[method-assign]
    return col


_REMOVE_LOG: list[RunCard] = []


def _fake_remove(self) -> None:
    """Stand-in for RunCard.remove that doesn't need a Textual app context."""
    _REMOVE_LOG.append(self)
    # The diff path doesn't reach into the body's children list after the
    # pop, so we don't have to keep the fake body in sync here.


def _fake_init(self, run, *_args, **_kw):
    self._run_id = run.run_id


def _patched_update(col: StatusColumn, runs: tuple[RunSnapshot, ...]) -> None:
    """Run update_column with stubbed RunCard methods (no Textual app)."""
    with mock.patch.object(RunCard, "apply"), \
         mock.patch.object(RunCard, "remove", _fake_remove), \
         mock.patch.object(RunCard, "is_mounted", new=True), \
         mock.patch.object(RunCard, "__init__", _fake_init):
        col.update_column(
            runs, compact=False, workbench_root=None, show_paths=False,
        )


class TestStatusColumnDiff(unittest.TestCase):

    def test_same_set_preserves_card_identity(self) -> None:
        col = _make_column()
        _patched_update(col, (_snap("a"), _snap("b"), _snap("c")))
        first = dict(col._cards)
        _patched_update(col, (_snap("a"), _snap("b"), _snap("c")))
        for run_id, card in col._cards.items():
            self.assertIs(card, first[run_id],
                          f"card {run_id} was remounted instead of reused")

    def test_new_card_added_to_dict(self) -> None:
        col = _make_column()
        _patched_update(col, (_snap("a"), _snap("b")))
        before = dict(col._cards)
        _patched_update(col, (_snap("a"), _snap("b"), _snap("c")))
        self.assertIn("c", col._cards)
        self.assertIs(col._cards["a"], before["a"])
        self.assertIs(col._cards["b"], before["b"])

    def test_vanished_card_removed(self) -> None:
        col = _make_column()
        _patched_update(col, (_snap("a"), _snap("b"), _snap("c")))
        before = dict(col._cards)
        _REMOVE_LOG.clear()
        _patched_update(col, (_snap("a"), _snap("c")))
        self.assertNotIn("b", col._cards)
        self.assertIn(before["b"], _REMOVE_LOG)
        self.assertIs(col._cards["a"], before["a"])
        self.assertIs(col._cards["c"], before["c"])

    def test_empty_set_clears_all(self) -> None:
        col = _make_column()
        _patched_update(col, (_snap("a"), _snap("b")))
        _patched_update(col, ())
        self.assertEqual(col._cards, {})


if __name__ == "__main__":
    unittest.main()
