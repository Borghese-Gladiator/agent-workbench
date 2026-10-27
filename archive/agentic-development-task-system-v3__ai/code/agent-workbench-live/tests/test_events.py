"""Tests for lib/events."""
from __future__ import annotations

import unittest

from tests._helpers import make_tmp_workbench, cleanup, reset_caches
from lib import config, metadata, events


class TestEvents(unittest.TestCase):
    def setUp(self):
        self.tmp = make_tmp_workbench()
        reset_caches()
        self.cfg = config.load(self.tmp)
        self.run_id = "2026-05-18-test"
        metadata.create(
            self.cfg, self.run_id,
            repo_mode="existing", repo_path="/tmp/x", repo_name="x",
            base_ref="HEAD", worktree_name="x", branch_name="agent/x",
            raw_idea_path="raw-idea.md",
        )
        self.actor = {"type": "agent", "name": "test"}

    def tearDown(self):
        cleanup(self.tmp)

    def test_append_valid_event(self):
        ev = events.append(
            self.cfg, self.run_id, "RunCreated",
            payload={
                "raw_idea_path": "raw-idea.md",
                "repo_path": "/tmp/x",
                "repo_name": "x",
                "repo_mode": "existing",
                "worktree_name": "x",
                "branch_name": "agent/x",
            },
            actor=self.actor,
        )
        self.assertEqual(ev["seq"], 1)
        self.assertEqual(ev["type"], "RunCreated")
        self.assertEqual(ev["status"], "draft")
        self.assertTrue(ev["event_id"].startswith("evt_"))

    def test_seq_increments(self):
        for _ in range(3):
            events.append(
                self.cfg, self.run_id, "ArtifactWritten",
                payload={"artifact_key": "x", "path": "x.md"},
                actor=self.actor,
            )
        all_events = list(events.iter_events(self.cfg, self.run_id))
        self.assertEqual([e["seq"] for e in all_events], [1, 2, 3])

    def test_rejects_invalid_appends(self):
        # Each case is (label, event_type, payload, actor). Folded into one
        # test because the assertion shape is identical: append(...) raises
        # EventError. The label disambiguates which branch when one regresses.
        bad = [
            ("missing required payload field",
             "RunCreated",
             {"repo_path": "/tmp/x"},  # missing raw_idea_path, repo_name, etc.
             self.actor),
            ("unknown event type",
             "MadeUpEvent",
             {},
             self.actor),
            ("actor type is unknown role",
             "ArtifactWritten",
             {"artifact_key": "x", "path": "x.md"},
             {"type": "unknown_role", "name": "x"}),
            ("actor missing 'type' key",
             "ArtifactWritten",
             {"artifact_key": "x", "path": "x.md"},
             {"name": "x"}),
        ]
        for label, ev_type, payload, actor in bad:
            with self.assertRaises(events.EventError, msg=label):
                events.append(self.cfg, self.run_id, ev_type, payload=payload, actor=actor)


if __name__ == "__main__":
    unittest.main()
