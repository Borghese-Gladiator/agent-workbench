"""Unit tests for lib.beads.

Skipped when `bd` is not on PATH. When `bd` is available, these tests run
against a temporary workbench root with its own `.beads/` so they don't
pollute real state.
"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lib import beads


@unittest.skipUnless(beads.is_available(), "bd not on PATH")
class TestBeadsWrapper(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_init_idempotent(self):
        self.assertFalse(beads.is_initialized(self.root))
        beads.init(self.root, prefix="testwb")
        self.assertTrue(beads.is_initialized(self.root))
        # second call must be a no-op (no error)
        beads.init(self.root, prefix="testwb")

    def test_create_and_show(self):
        beads.init(self.root, prefix="testwb")
        bid = beads.create_issue(
            self.root,
            title="hello",
            description="body",
            run_id="2026-05-06-x-001",
            run_type="feature",
        )
        self.assertTrue(bid.startswith("testwb-"), bid)
        self.assertTrue(beads.issue_exists(self.root, bid))
        self.assertEqual(beads.issue_status(self.root, bid), "open")

    def test_create_with_parent_links_in_children(self):
        beads.init(self.root, prefix="testwb")
        parent = beads.create_issue(
            self.root,
            title="parent",
            description="p",
            run_id="2026-05-06-p-001",
            run_type="investigation",
        )
        child = beads.create_issue(
            self.root,
            title="child",
            description="c",
            run_id="2026-05-06-c-001",
            run_type="feature",
            parent_bead_id=parent,
        )
        kids = beads.query_children(self.root, parent)
        self.assertIn(child, kids)

    def test_status_mapping(self):
        beads.init(self.root, prefix="testwb")
        bid = beads.create_issue(
            self.root,
            title="lifecycle",
            description="x",
            run_id="2026-05-06-l-001",
            run_type="feature",
        )
        self.assertEqual(beads.issue_status(self.root, bid), "open")

        beads.update_issue_status(self.root, bid, "in_progress")
        self.assertEqual(beads.issue_status(self.root, bid), "in_progress")

        # in_review/qa add labels but don't change status; verify no exception.
        beads.update_issue_status(self.root, bid, "in_review")
        beads.update_issue_status(self.root, bid, "qa")

        beads.update_issue_status(self.root, bid, "merged")
        self.assertEqual(beads.issue_status(self.root, bid), "closed")

    def test_no_op_statuses(self):
        beads.init(self.root, prefix="testwb")
        bid = beads.create_issue(
            self.root,
            title="parent",
            description="x",
            run_id="2026-05-06-p-001",
            run_type="investigation",
        )
        # These should not raise and should not change state.
        for s in ("draft", "planned", "investigating", "investigated"):
            beads.update_issue_status(self.root, bid, s)
        self.assertEqual(beads.issue_status(self.root, bid), "open")

    def test_missing_issue_probe(self):
        beads.init(self.root, prefix="testwb")
        self.assertFalse(beads.issue_exists(self.root, "testwb-doesnotexist"))


if __name__ == "__main__":
    unittest.main()
