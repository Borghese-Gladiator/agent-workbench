"""Unit tests for lib.transitions.

Run from the workbench root:
    PYTHONPATH=. python3 -m unittest discover tests
"""

import sys
import unittest
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lib.metadata import Metadata, MetadataError, new_metadata
from lib.transitions import (
    ANY_NON_TERMINAL,
    EVIDENCE,
    TransitionError,
    documented_edges,
    transition_with_evidence,
)


def _feature_md(**overrides) -> Metadata:
    base = dict(
        run_id="2026-05-13-foo-001",
        feature_slug="foo",
        repo_key="frontend",
        repo_path="/tmp/frontend",
        github_repo="org/frontend",
        default_branch="main",
    )
    base.update(overrides)
    return new_metadata(**base)


def _md_at(status: str, **overrides) -> Metadata:
    """Build a metadata fixture parked at `status` without going through
    transition_with_evidence (which is what we're testing)."""
    md = _feature_md(**overrides)
    return replace(md, status=status)


# A sample evidence dict large enough to satisfy every documented edge.
# Tests pick the subset they need by passing the keys explicitly.
EVIDENCE_SAMPLE = {
    "normalized_spec_path": "runs/x/normalized-feature-input.md",
    "approved_by": "timothy",
    "worktree_path": "/tmp/wt",
    "branch_name": "ai/x",
    "pr_url": "https://github.com/org/x/pull/1",
    "review_decision": "approved",
    "tests_passed": "true",
    "merge_sha": "deadbeef",
    "spec_path": "runs/x/spec.md",
    "wbs_children": "3",
    "children_complete": "true",
    "bounce_reason": "review caught a bug",
    "abandoned_reason": "no longer needed",
}


class TestHappyPaths(unittest.TestCase):
    def test_every_documented_edge_round_trips_with_full_evidence(self):
        # For every documented edge, build a metadata at the `from` state and
        # confirm the transition succeeds when full evidence is supplied.
        for (from_state, to_state), requirement in EVIDENCE.items():
            with self.subTest(edge=(from_state, to_state)):
                if from_state == ANY_NON_TERMINAL:
                    # The wildcard edge is tested separately; skip here.
                    continue
                run_type = (
                    "investigation"
                    if to_state in ("investigating", "investigated")
                    or from_state in ("investigating", "investigated")
                    else "feature"
                )
                md = _md_at(from_state, run_type=run_type)
                evidence = {k: EVIDENCE_SAMPLE[k] for k in requirement.keys}
                new_md, trimmed = transition_with_evidence(md, to_state, evidence)
                self.assertEqual(new_md.status, to_state)
                self.assertEqual(set(trimmed.keys()), set(requirement.keys))

    def test_trimmed_evidence_drops_unrelated_keys(self):
        md = _md_at("brainstorm")
        new_md, trimmed = transition_with_evidence(
            md,
            "ready",
            {"approved_by": "timothy", "noise": "ignored", "more_noise": "also ignored"},
        )
        self.assertEqual(new_md.status, "ready")
        self.assertEqual(trimmed, {"approved_by": "timothy"})


class TestEvidenceFailures(unittest.TestCase):
    def test_missing_key_rejected(self):
        md = _md_at("qa")
        with self.assertRaises(TransitionError) as cm:
            transition_with_evidence(md, "merged", {"tests_passed": "true"})
        msg = str(cm.exception)
        self.assertIn("missing", msg)
        self.assertIn("merge_sha", msg)
        self.assertIn("pr_url", msg)

    def test_empty_string_rejected(self):
        md = _md_at("brainstorm")
        with self.assertRaises(TransitionError) as cm:
            transition_with_evidence(md, "ready", {"approved_by": "   "})
        self.assertIn("empty", str(cm.exception))

    def test_none_value_rejected(self):
        md = _md_at("in_progress")
        with self.assertRaises(TransitionError):
            transition_with_evidence(md, "in_review", {"pr_url": None})

    def test_non_dict_evidence_rejected(self):
        md = _md_at("in_progress")
        with self.assertRaises(TransitionError):
            transition_with_evidence(md, "in_review", "pr_url=foo")  # type: ignore[arg-type]

    def test_no_evidence_passed_at_all(self):
        md = _md_at("ready")
        with self.assertRaises(TransitionError):
            transition_with_evidence(md, "in_progress", {})


class TestUndocumentedEdges(unittest.TestCase):
    def test_skip_edge_rejected(self):
        # draft → merged is not a defined edge.
        md = _md_at("draft")
        with self.assertRaises(TransitionError) as cm:
            transition_with_evidence(md, "merged", EVIDENCE_SAMPLE)
        self.assertIn("no transition defined", str(cm.exception))

    def test_backwards_edge_rejected(self):
        # in_review → draft is not defined (bounce-back only goes to in_progress).
        md = _md_at("in_review")
        with self.assertRaises(TransitionError):
            transition_with_evidence(md, "draft", EVIDENCE_SAMPLE)

    def test_invalid_status_rejected(self):
        md = _md_at("draft")
        with self.assertRaises(TransitionError) as cm:
            transition_with_evidence(md, "bogus", {})
        self.assertIn("invalid target status", str(cm.exception))


class TestAbandonWildcard(unittest.TestCase):
    def test_abandon_from_each_non_terminal(self):
        for status in (
            "draft",
            "normalize",
            "brainstorm",
            "ready",
            "planned",
            "in_progress",
            "in_review",
            "qa",
        ):
            with self.subTest(status=status):
                md = _md_at(status)
                new_md, trimmed = transition_with_evidence(
                    md, "abandoned", {"abandoned_reason": "no longer needed"}
                )
                self.assertEqual(new_md.status, "abandoned")
                self.assertEqual(trimmed, {"abandoned_reason": "no longer needed"})

    def test_abandon_requires_reason(self):
        md = _md_at("in_progress")
        with self.assertRaises(TransitionError):
            transition_with_evidence(md, "abandoned", {})

    def test_cannot_abandon_from_terminal(self):
        md = _md_at("merged")
        with self.assertRaises(TransitionError) as cm:
            transition_with_evidence(
                md, "abandoned", {"abandoned_reason": "wrong"}
            )
        self.assertIn("terminal", str(cm.exception))


class TestInvestigationGuard(unittest.TestCase):
    def test_feature_cannot_enter_investigating_even_with_evidence(self):
        md = _md_at("planned", run_type="feature")
        # Evidence is valid; metadata-level guard must still reject.
        with self.assertRaises(MetadataError):
            transition_with_evidence(
                md, "investigating", {"worktree_path": "/tmp/wt"}
            )


class TestDocumentedEdgesHelper(unittest.TestCase):
    def test_documented_edges_returns_every_key(self):
        edges = list(documented_edges())
        self.assertIn(("draft", "normalize"), edges)
        self.assertIn(("qa", "merged"), edges)
        self.assertIn((ANY_NON_TERMINAL, "abandoned"), edges)


if __name__ == "__main__":
    unittest.main()
