"""Tests for lib/transitions.

Covers every (from, to) pair declared in schemas/transitions.yaml plus rejection
cases: terminal-state transitions, missing evidence, unknown transitions.
"""
from __future__ import annotations

import unittest

from tests._helpers import make_tmp_workbench, cleanup, reset_caches
from lib import config, metadata, events, transitions, lifecycle


ACTOR = {"type": "agent", "name": "test"}


def _evidence_for(from_state: str, to_state: str, run_id: str) -> dict:
    """Minimal valid evidence for each rule in the schema."""
    if (from_state, to_state) == ("draft", "shaping"):
        return {"raw_idea_path": f"runs/{run_id}/raw-idea.md"}
    if (from_state, to_state) == ("shaping", "planning"):
        return {"brief_path": f"runs/{run_id}/brief.md"}
    if (from_state, to_state) == ("planning", "ready"):
        return {
            "plan_path": "p.md", "assumptions_path": "a.md",
            "decisions_path": "d.md", "preflight_path": "pf.md",
            "repo_path": "/tmp/x", "repo_name": "x",
            "worktree_name": "x", "branch_name": "agent/x",
        }
    if (from_state, to_state) == ("ready", "building"):
        return {
            "approved_by": "tim", "repo_path": "/tmp/x", "repo_name": "x",
            "base_ref": "HEAD", "branch_name": "agent/x", "worktree_name": "x",
            "worktree_path": "/tmp/wt", "preflight_path": "pf.md",
        }
    if (from_state, to_state) == ("building", "validating"):
        return {
            "implementation_summary_path": "i.md", "diff_summary_path": "ds.md",
            "build_iterations": 1, "build_exit_reason": "tests_green",
        }
    if (from_state, to_state) == ("validating", "followups"):
        return {
            "review_report_path": "r.md", "qa_report_path": "qa/report.md",
            "audit_path": "audit.md",
        }
    if (from_state, to_state) == ("validating", "human_review"):
        # Flat-layout legacy path (still in the schema).
        return {
            "review_report_path": "r.md", "qa_report_path": "qa/report.md",
            "audit_path": "audit.md", "handoff_path": "handoff.md",
            "branch_name": "agent/x", "worktree_path": "/tmp/wt",
        }
    if (from_state, to_state) == ("followups", "human_review"):
        return {
            "followups_path": "stages/6_followups/follow-ups.md",
            "handoff_path": "handoff.md",
            "branch_name": "agent/x", "worktree_path": "/tmp/wt",
        }
    if (from_state, to_state) == ("human_review", "done"):
        return {"accepted_by": "tim", "completion_ref": "local-branch:x", "audit_path": "audit.md"}
    if (from_state, to_state) == ("human_review", "building"):
        return {"bounce_reason": "fix it"}
    return {"abandoned_reason": "stop"}  # wildcard


class TestTransitions(unittest.TestCase):
    def setUp(self):
        self.tmp = make_tmp_workbench()
        reset_caches()
        self.cfg = config.load(self.tmp)

    def tearDown(self):
        cleanup(self.tmp)

    def _make_run(self, rid="r"):
        metadata.create(
            self.cfg, rid,
            repo_mode="existing", repo_path="/tmp/x", repo_name="x",
            base_ref="HEAD", worktree_name="x", branch_name="agent/x",
            raw_idea_path="raw-idea.md",
        )
        return rid

    def _advance(self, run_id, *path):
        for to in path:
            meta = metadata.load(self.cfg, run_id)
            ev = _evidence_for(meta["status"], to, run_id)
            transitions.transition(self.cfg, run_id, to, ev, ACTOR)

    def test_full_happy_path(self):
        rid = self._make_run("happy")
        self._advance(rid, "shaping", "planning", "ready", "building", "validating", "human_review", "done")
        self.assertEqual(metadata.load(self.cfg, rid)["status"], "done")

    def test_bounce_loop(self):
        rid = self._make_run("bounce-loop")
        self._advance(rid, "shaping", "planning", "ready", "building", "validating", "human_review")
        self._advance(rid, "building", "validating", "human_review")
        self.assertEqual(metadata.load(self.cfg, rid)["status"], "human_review")

    def test_abandon_from_each_non_terminal(self):
        # for each non-terminal state, build a run that reaches it and abandon.
        paths = {
            "draft": [],
            "shaping": ["shaping"],
            "planning": ["shaping", "planning"],
            "ready": ["shaping", "planning", "ready"],
            "building": ["shaping", "planning", "ready", "building"],
            "validating": ["shaping", "planning", "ready", "building", "validating"],
            "human_review": ["shaping", "planning", "ready", "building", "validating", "human_review"],
        }
        for n, (state, path) in enumerate(paths.items()):
            rid = f"abandon-{n}"
            self._make_run(rid)
            self._advance(rid, *path)
            self.assertEqual(metadata.load(self.cfg, rid)["status"], state)
            transitions.transition(self.cfg, rid, "abandoned",
                                   {"abandoned_reason": "test"}, ACTOR)
            self.assertEqual(metadata.load(self.cfg, rid)["status"], "abandoned")

    def test_terminal_cannot_transition(self):
        rid = self._make_run("terminal")
        transitions.transition(self.cfg, rid, "abandoned",
                               {"abandoned_reason": "x"}, ACTOR)
        with self.assertRaises(transitions.TransitionError):
            transitions.transition(self.cfg, rid, "shaping",
                                   {"raw_idea_path": "x"}, ACTOR)

    def test_missing_evidence_rejected(self):
        rid = self._make_run("missing-ev")
        with self.assertRaises(transitions.TransitionError):
            transitions.transition(self.cfg, rid, "shaping", {}, ACTOR)
        # TransitionRejected event should have been emitted.
        types = [e["type"] for e in events.iter_events(self.cfg, rid)]
        self.assertIn("TransitionRejected", types)

    def test_unknown_transition_rejected(self):
        rid = self._make_run("no-rule")
        with self.assertRaises(transitions.TransitionError):
            transitions.transition(
                self.cfg, rid, "done",
                {"accepted_by": "x", "completion_ref": "y", "audit_path": "z"},
                ACTOR,
            )

    def test_empty_string_evidence_rejected(self):
        rid = self._make_run("empty-str")
        with self.assertRaises(transitions.TransitionError):
            transitions.transition(self.cfg, rid, "shaping",
                                   {"raw_idea_path": "   "}, ACTOR)

    def test_secondary_events_emitted(self):
        # ready -> building should emit TransitionApplied AND WorktreeCreated.
        rid = self._make_run("secondary")
        self._advance(rid, "shaping", "planning", "ready", "building")
        types = [e["type"] for e in events.iter_events(self.cfg, rid)]
        self.assertIn("WorktreeCreated", types)

    def test_building_to_validating_rejects_missing_build_evidence(self):
        # TODO §1e: build_iterations and build_exit_reason are required.
        rid = self._make_run("missing-build")
        self._advance(rid, "shaping", "planning", "ready", "building")
        with self.assertRaises(transitions.TransitionError) as ctx:
            transitions.transition(
                self.cfg, rid, "validating",
                {"implementation_summary_path": "i.md", "diff_summary_path": "ds.md"},
                ACTOR,
            )
        msg = str(ctx.exception)
        self.assertIn("build_iterations", msg)
        self.assertIn("build_exit_reason", msg)

    def test_followups_to_human_review_requires_followups_path(self):
        # TODO §1f: the new transition demands followups_path evidence.
        rid = self._make_run("missing-followups-path")
        self._advance(
            rid, "shaping", "planning", "ready", "building", "validating", "followups"
        )
        with self.assertRaises(transitions.TransitionError) as ctx:
            transitions.transition(
                self.cfg, rid, "human_review",
                {
                    "handoff_path": "handoff.md",
                    "branch_name": "agent/x", "worktree_path": "/tmp/wt",
                },
                ACTOR,
            )
        self.assertIn("followups_path", str(ctx.exception))


class TestStagedLayoutTransitions(unittest.TestCase):
    """Transitions with staged layout (TODO §1) — engine rewrites evidence
    paths and gates validating→human_review on HUMAN_REVIEW.md sections."""

    def setUp(self):
        self.tmp = make_tmp_workbench()
        reset_caches()
        self.cfg = config.load(self.tmp)

    def tearDown(self):
        cleanup(self.tmp)

    def _make_staged_run(self, rid="staged") -> str:
        metadata.create(
            self.cfg, rid,
            repo_mode="existing", repo_path="/tmp/x", repo_name="x",
            base_ref="HEAD", worktree_name="x", branch_name="agent/x",
            raw_idea_path="raw-idea.md",
        )
        lifecycle.init_staged_layout(self.cfg, rid)
        return rid

    def test_evidence_path_rewritten_on_shaping_to_planning(self):
        rid = self._make_staged_run("rewrite")
        rd = metadata.run_dir(self.cfg, rid)
        (rd / "brief.md").write_text("# brief\n")
        transitions.transition(
            self.cfg, rid, "shaping",
            {"raw_idea_path": str(rd / "raw-idea.md")},
            ACTOR,
        )
        transitions.transition(
            self.cfg, rid, "planning",
            {"brief_path": str(rd / "brief.md")},
            ACTOR,
        )
        # The TransitionApplied event for shaping->planning records the new
        # post-move path, not the run-root one.
        applied = [
            e for e in events.iter_events(self.cfg, rid)
            if e["type"] == "TransitionApplied" and e.get("to") == "planning"
        ]
        self.assertEqual(len(applied), 1)
        self.assertEqual(
            applied[0]["payload"]["evidence"]["brief_path"],
            "stages/2_shaping/brief.md",
        )

    def test_followups_to_human_review_rejects_missing_sections(self):
        """TODO §1f: the HUMAN_REVIEW.md section gate moved from
        validating→human_review (which no longer exists for staged runs) to
        followups→human_review."""
        rid = self._make_staged_run("gate")
        rd = metadata.run_dir(self.cfg, rid)
        # Advance to validating, then followups.
        (rd / "brief.md").write_text("b\n")
        (rd / "plan.md").write_text("# Plan\n\n## Decisions & assumptions\nx\n")
        (rd / "build.md").write_text("b\n")
        (rd / "review.md").write_text("r\n")
        (rd / "qa").mkdir()
        (rd / "qa" / "report.md").write_text("qa\n")
        (rd / "follow-ups.md").write_text(
            "---\ntitle: t\nmotivation: m\nsuggested_scope: s\ncategory: tech_debt\n---\n"
        )

        transitions.transition(self.cfg, rid, "shaping", {"raw_idea_path": "raw-idea.md"}, ACTOR)
        transitions.transition(self.cfg, rid, "planning", {"brief_path": "brief.md"}, ACTOR)
        transitions.transition(
            self.cfg, rid, "ready",
            {
                "plan_path": "plan.md", "assumptions_path": "plan.md",
                "decisions_path": "plan.md", "preflight_path": "plan.md",
                "repo_path": "/tmp/x", "repo_name": "x",
                "worktree_name": "x", "branch_name": "agent/x",
            },
            ACTOR,
        )
        transitions.transition(
            self.cfg, rid, "building",
            {
                "approved_by": "t", "repo_path": "/tmp/x", "repo_name": "x",
                "base_ref": "HEAD", "branch_name": "agent/x", "worktree_name": "x",
                "worktree_path": "/tmp/wt", "preflight_path": "plan.md#preflight",
            },
            ACTOR,
        )
        transitions.transition(
            self.cfg, rid, "validating",
            {
                "implementation_summary_path": "build.md",
                "diff_summary_path": "build.md",
                "build_iterations": 1,
                "build_exit_reason": "tests_green",
            },
            ACTOR,
        )
        transitions.transition(
            self.cfg, rid, "followups",
            {
                "review_report_path": "review.md", "qa_report_path": "qa/report.md",
                "audit_path": "audit.md",
            },
            ACTOR,
        )

        # No HUMAN_REVIEW.md yet → rejected.
        with self.assertRaises(transitions.TransitionError) as ctx:
            transitions.transition(
                self.cfg, rid, "human_review",
                {
                    "followups_path": "follow-ups.md", "handoff_path": "HUMAN_REVIEW.md",
                    "branch_name": "agent/x", "worktree_path": "/tmp/wt",
                },
                ACTOR,
            )
        self.assertIn("HUMAN_REVIEW.md", str(ctx.exception))

        # Add HUMAN_REVIEW.md with only some of the required headings.
        (rd / "HUMAN_REVIEW.md").write_text(
            "# H\n\n## Files\nrow\n\n## Summary of changes\nbullet\n"
        )
        with self.assertRaises(transitions.TransitionError):
            transitions.transition(
                self.cfg, rid, "human_review",
                {
                    "followups_path": "follow-ups.md", "handoff_path": "HUMAN_REVIEW.md",
                    "branch_name": "agent/x", "worktree_path": "/tmp/wt",
                },
                ACTOR,
            )

        # Fix it; transition now succeeds.
        (rd / "HUMAN_REVIEW.md").write_text(
            "# H\n\n## Files\nrow\n\n## Summary of changes\nbullet\n\n"
            "## Testing\noutcome\n\n## Run timeline\nrow\n"
        )
        transitions.transition(
            self.cfg, rid, "human_review",
            {
                "followups_path": "follow-ups.md", "handoff_path": "HUMAN_REVIEW.md",
                "branch_name": "agent/x", "worktree_path": "/tmp/wt",
            },
            ACTOR,
        )
        self.assertEqual(metadata.load(self.cfg, rid)["status"], "human_review")


if __name__ == "__main__":
    unittest.main()
