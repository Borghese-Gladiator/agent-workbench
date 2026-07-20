"""Unit tests for lib/lifecycle.py — the staged-layout helper module."""
from __future__ import annotations

import pathlib
import unittest

from tests._helpers import make_tmp_workbench, cleanup, reset_caches  # noqa: F401

from lib import config as cfg_mod
from lib import lifecycle, metadata


def _make_draft_run(tmp: pathlib.Path, run_id: str = "2026-05-20-test") -> tuple[cfg_mod.Config, str]:
    cfg = cfg_mod.load(tmp)
    rd = cfg.runs_path / run_id
    rd.mkdir(parents=True)
    (rd / "metadata.yaml").write_text(
        "schema_version: 1\n"
        f"run_id: {run_id}\n"
        "status: draft\n"
        "created_at: 2026-05-20T00:00:00\n"
        "updated_at: 2026-05-20T00:00:00\n"
        "target:\n"
        "  repo: {mode: existing, path: /tmp/x, name: x, base_ref: main, fingerprint: null, created_by_run: null}\n"
        "  worktree: {name: x, path: null, branch_name: agent/x, created: false, base_ref: main, initial_commit_sha: null}\n"
        "scope: {kind: implementation, summary: ''}\n"
        "artifacts: {raw_idea: raw-idea.md, answers: null, brief: null, plan: null, preflight: null, assumptions: null, decisions: null, implementation_summary: null, diff_summary: null, review_report: null, qa_report: null, audit: null, handoff: null}\n"
        "validation: {required: true, review_completed: false, qa_completed: false, qa_recorded: false, tests_passed: null, known_issues_count: 0}\n"
        "completion: {accepted_by: null, completion_ref: null, completed_at: null, abandoned_reason: null}\n"
    )
    return cfg, run_id


class TestLayoutDetection(unittest.TestCase):
    def setUp(self):
        self.tmp = make_tmp_workbench()

    def tearDown(self):
        cleanup(self.tmp)

    def test_flat_run_detected_as_flat(self):
        cfg, run_id = _make_draft_run(self.tmp)
        self.assertEqual(lifecycle.detect_layout(cfg, run_id), lifecycle.LAYOUT_FLAT)
        self.assertFalse(lifecycle.is_staged_run(cfg, run_id))

    def test_staged_run_detected_after_init(self):
        cfg, run_id = _make_draft_run(self.tmp)
        lifecycle.init_staged_layout(cfg, run_id)
        self.assertEqual(lifecycle.detect_layout(cfg, run_id), lifecycle.LAYOUT_STAGED)
        self.assertTrue(lifecycle.is_staged_run(cfg, run_id))
        self.assertTrue((metadata.run_dir(cfg, run_id) / "stages").is_dir())


class TestOnTransition(unittest.TestCase):
    def setUp(self):
        self.tmp = make_tmp_workbench()
        self.cfg, self.run_id = _make_draft_run(self.tmp)
        lifecycle.init_staged_layout(self.cfg, self.run_id)
        self.rd = metadata.run_dir(self.cfg, self.run_id)

    def tearDown(self):
        cleanup(self.tmp)

    def test_stage_dirs_are_numbered(self):
        self.assertEqual(
            lifecycle.stage_dir(self.cfg, self.run_id, "draft").name, "1_draft"
        )
        self.assertEqual(
            lifecycle.stage_dir(self.cfg, self.run_id, "shaping").name, "2_shaping"
        )
        self.assertEqual(
            lifecycle.stage_dir(self.cfg, self.run_id, "planning").name, "3_planning"
        )
        self.assertEqual(
            lifecycle.stage_dir(self.cfg, self.run_id, "building").name, "4_building"
        )
        self.assertEqual(
            lifecycle.stage_dir(self.cfg, self.run_id, "validating").name, "5_validating"
        )
        self.assertEqual(
            lifecycle.stage_dir(self.cfg, self.run_id, "followups").name, "6_followups"
        )

    def test_sorted_stage_dirs_match_lifecycle_flow(self):
        # The whole point of the numeric prefix: `ls` (which is sorted())
        # must yield draft → shaping → planning → building → validating →
        # followups, not the alphabetical building/draft/followups/... mess.
        stages = ["draft", "shaping", "planning", "building", "validating", "followups"]
        for s in stages:
            lifecycle.stage_dir(self.cfg, self.run_id, s).mkdir(parents=True, exist_ok=True)
        on_disk = sorted(p.name for p in (self.rd / "stages").iterdir())
        self.assertEqual(
            on_disk,
            ["1_draft", "2_shaping", "3_planning", "4_building", "5_validating", "6_followups"],
        )

    def test_stage_dir_prefers_legacy_unnumbered_dir(self):
        # In-flight runs created before the numbering change keep their
        # unnumbered directory: if it exists, it wins over the numbered name.
        legacy = self.rd / "stages" / "shaping"
        legacy.mkdir(parents=True)
        self.assertEqual(
            lifecycle.stage_dir(self.cfg, self.run_id, "shaping"), legacy
        )

    def test_shaping_to_planning_moves_brief(self):
        (self.rd / "brief.md").write_text("# Brief\nx\n")
        evidence = {"brief_path": str(self.rd / "brief.md")}
        rewrites = lifecycle.on_transition(self.cfg, self.run_id, "shaping", "planning", evidence)
        self.assertEqual(rewrites["brief_path"], "stages/2_shaping/brief.md")
        self.assertTrue((self.rd / "stages" / "2_shaping" / "brief.md").exists())
        self.assertFalse((self.rd / "brief.md").exists())

    def test_planning_to_ready_moves_plan_and_anchors_other_keys(self):
        (self.rd / "plan.md").write_text("# Plan\nx\n")
        evidence = {
            "plan_path": str(self.rd / "plan.md"),
            "preflight_path": str(self.rd / "plan.md"),
            "assumptions_path": str(self.rd / "plan.md"),
            "decisions_path": str(self.rd / "plan.md"),
        }
        rewrites = lifecycle.on_transition(self.cfg, self.run_id, "planning", "ready", evidence)
        self.assertEqual(rewrites["plan_path"], "stages/3_planning/plan.md")
        self.assertEqual(rewrites["preflight_path"], "stages/3_planning/plan.md#preflight")
        self.assertEqual(rewrites["assumptions_path"], "stages/3_planning/plan.md#decisions--assumptions")
        self.assertEqual(rewrites["decisions_path"], "stages/3_planning/plan.md#decisions--assumptions")

    def test_on_transition_is_idempotent(self):
        (self.rd / "brief.md").write_text("hello\n")
        lifecycle.on_transition(self.cfg, self.run_id, "shaping", "planning", {"brief_path": "x"})
        # Calling again with the file already promoted should not raise nor double-move.
        rewrites = lifecycle.on_transition(self.cfg, self.run_id, "shaping", "planning", {"brief_path": "x"})
        self.assertEqual(rewrites["brief_path"], "stages/2_shaping/brief.md")
        self.assertTrue((self.rd / "stages" / "2_shaping" / "brief.md").exists())

    def test_validating_to_human_review_moves_qa_dir(self):
        qa = self.rd / "qa"
        qa.mkdir()
        (qa / "report.md").write_text("# QA\nx\n")
        (self.rd / "review.md").write_text("# Review\nx\n")
        lifecycle.on_transition(
            self.cfg, self.run_id, "validating", "human_review",
            {"review_report_path": str(self.rd / "review.md")},
        )
        self.assertTrue((self.rd / "stages" / "5_validating" / "review.md").exists())
        self.assertTrue((self.rd / "stages" / "5_validating" / "qa" / "report.md").exists())
        self.assertFalse((self.rd / "qa").exists())


class TestArchiveForBounce(unittest.TestCase):
    def setUp(self):
        self.tmp = make_tmp_workbench()
        self.cfg, self.run_id = _make_draft_run(self.tmp)
        lifecycle.init_staged_layout(self.cfg, self.run_id)
        self.rd = metadata.run_dir(self.cfg, self.run_id)
        # Seed stages/4_building and stages/5_validating as if a build cycle
        # just finished.
        (self.rd / "stages" / "4_building").mkdir(parents=True)
        (self.rd / "stages" / "4_building" / "build.md").write_text("# v1\n")
        (self.rd / "stages" / "5_validating").mkdir(parents=True)
        (self.rd / "stages" / "5_validating" / "review.md").write_text("# v1\n")
        (self.rd / "stages" / "5_validating" / "qa").mkdir()
        (self.rd / "stages" / "5_validating" / "qa" / "report.md").write_text("# qa v1\n")

    def tearDown(self):
        cleanup(self.tmp)

    def test_first_bounce_versions_at_v1(self):
        moved = lifecycle.archive_for_bounce(self.cfg, self.run_id)
        self.assertTrue((self.rd / "archive" / "4_building" / "build-v1.md").exists())
        self.assertTrue((self.rd / "archive" / "5_validating" / "review-v1.md").exists())
        self.assertTrue((self.rd / "archive" / "5_validating" / "qa-v1" / "report.md").exists())
        # Stage dirs are left in place but empty, ready for the rebuild.
        self.assertTrue((self.rd / "stages" / "4_building").is_dir())
        self.assertEqual(list((self.rd / "stages" / "4_building").iterdir()), [])
        self.assertGreater(len(moved), 0)

    def test_second_bounce_versions_at_v2(self):
        lifecycle.archive_for_bounce(self.cfg, self.run_id)
        # Refill stages with v2 content.
        (self.rd / "stages" / "4_building" / "build.md").write_text("# v2\n")
        (self.rd / "stages" / "5_validating" / "review.md").write_text("# v2\n")
        (self.rd / "stages" / "5_validating" / "qa").mkdir()
        (self.rd / "stages" / "5_validating" / "qa" / "report.md").write_text("# qa v2\n")
        lifecycle.archive_for_bounce(self.cfg, self.run_id)
        self.assertTrue((self.rd / "archive" / "4_building" / "build-v2.md").exists())
        self.assertTrue((self.rd / "archive" / "5_validating" / "review-v2.md").exists())
        self.assertTrue((self.rd / "archive" / "5_validating" / "qa-v2" / "report.md").exists())


class TestPruneEmptyDirs(unittest.TestCase):
    def setUp(self):
        self.tmp = make_tmp_workbench()
        self.cfg, self.run_id = _make_draft_run(self.tmp)
        lifecycle.init_staged_layout(self.cfg, self.run_id)
        self.rd = metadata.run_dir(self.cfg, self.run_id)

    def tearDown(self):
        cleanup(self.tmp)

    def test_empty_archive_removed(self):
        (self.rd / "archive" / "4_building").mkdir(parents=True)
        lifecycle.prune_empty_dirs(self.cfg, self.run_id)
        self.assertFalse((self.rd / "archive").exists())

    def test_non_empty_archive_preserved(self):
        (self.rd / "archive" / "4_building").mkdir(parents=True)
        (self.rd / "archive" / "4_building" / "build-v1.md").write_text("# v1\n")
        lifecycle.prune_empty_dirs(self.cfg, self.run_id)
        self.assertTrue((self.rd / "archive" / "4_building" / "build-v1.md").exists())

    def test_pruning_collapses_nested_empties(self):
        (self.rd / "stages" / "5_validating" / "qa" / "artifacts").mkdir(parents=True)
        (self.rd / "stages" / "5_validating" / "qa" / "recordings").mkdir()
        # No files anywhere → entire stages/5_validating subtree should collapse.
        lifecycle.prune_empty_dirs(self.cfg, self.run_id)
        self.assertFalse((self.rd / "stages" / "5_validating").exists())


class TestHumanReviewValidation(unittest.TestCase):
    def setUp(self):
        self.tmp = make_tmp_workbench()
        self.cfg, self.run_id = _make_draft_run(self.tmp)
        self.rd = metadata.run_dir(self.cfg, self.run_id)

    def tearDown(self):
        cleanup(self.tmp)

    def test_validation_cases(self):
        # Each case is (label, file_contents_or_None, predicate(errs)).
        # Folded into one test because the call shape and the per-test setup
        # are identical apart from the file contents.
        full = (
            "# H\n\n## Files\n\nrow\n\n## Summary of changes\n\nbullet\n\n"
            "## Testing\n\noutcome\n\n## Run timeline\n\nrow\n"
        )
        partial = "# H\n\n## Files\n\nok\n\n## Summary of changes\n\nok\n"
        bare = "# bare file\n"

        cases = [
            ("missing file → one 'not found' error",
             None,
             lambda errs: len(errs) == 1 and "not found" in errs[0]),
            ("bare file → all four required headings missing",
             bare,
             lambda errs: len(errs) == 4),
            ("partial (two headings) → two errors about Testing + Run timeline",
             partial,
             lambda errs: len(errs) == 2
             and any("Testing" in e for e in errs)
             and any("Run timeline" in e for e in errs)),
            ("all headings present → no errors", full, lambda errs: errs == []),
        ]
        for label, contents, ok in cases:
            # Reset between cases.
            f = self.rd / "HUMAN_REVIEW.md"
            if f.exists():
                f.unlink()
            if contents is not None:
                f.write_text(contents)
            errs = lifecycle.validate_human_review_sections(self.cfg, self.run_id)
            self.assertTrue(ok(errs), msg=f"{label}: got {errs!r}")


if __name__ == "__main__":
    unittest.main()
