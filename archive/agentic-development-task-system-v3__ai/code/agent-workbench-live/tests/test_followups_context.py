"""Unit tests for the deterministic followups-context.md generator (TODO §5).

Mirrors the shape of `tests/test_build_context.py`.
"""
from __future__ import annotations

import pathlib
import tempfile
import unittest
from unittest import mock

from tests._helpers import make_tmp_workbench, cleanup, reset_caches  # noqa: F401

from lib import followups_context


class TestFollowupsContextBuild(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="fctx-"))
        self.brief = self.tmp / "brief.md"
        self.brief.write_text(
            "# Brief\n\n"
            "## Goal\n\nDo the thing.\n\n"
            "## Non-goals\n\n- Skip the yak shave.\n- Don't refactor X.\n"
        )
        self.plan = self.tmp / "plan.md"
        self.plan.write_text(
            "# Plan\n\n"
            "## Proposed changes\n\nDo it.\n\n"
            "## Risks\n\n1. Tricky merge ordering.\n2. Test flakiness.\n"
        )
        self.build_md = self.tmp / "build.md"
        self.build_md.write_text(
            "# Build report\n\n"
            "## Implementation summary\n\nShipped.\n\n"
            "## Deviations from plan\n\n- Renamed helper foo to bar.\n"
        )
        self.review = self.tmp / "review.md"
        self.review.write_text(
            "# Review\n\n"
            "## Decision\n\napprove\n\n"
            "## Findings\n\n- Reviewer flagged unrelated drift.\n"
        )
        self.qa = self.tmp / "qa-report.md"
        self.qa.write_text(
            "# QA report\n\n## Known issues\n\n- Slow test in tests/foo.py.\n"
        )
        self.template = self.tmp / "follow-ups.md"
        self.template.write_text(
            "# Follow-ups\n\n"
            "<!-- One YAML frontmatter block per entry. -->\n\n"
            "---\ntitle: <short imperative title>\n"
            "category: tech_debt | scope_extension | bug_risk | refactor | docs | "
            "deferred_from_bounce | no_followups\n---\n"
        )

    def tearDown(self):
        cleanup(self.tmp)

    def _build(self) -> str:
        return followups_context.build(
            brief_path=self.brief,
            plan_path=self.plan,
            build_md_path=self.build_md,
            review_path=self.review,
            qa_report_path=self.qa,
            followups_template_path=self.template,
        )

    def test_renders_all_sections(self):
        body = self._build()
        for header in (
            "# followups-context.md",
            "## Brief: Non-goals",
            "## Plan: Risks",
            "## Review: Decision",
            "## Review: Findings",
            "## QA: Known issues",
            "## Build: Deviations from plan",
            "## follow-ups.md schema",
            "## Rules",
        ):
            self.assertIn(header, body, f"missing section: {header}")

    def test_brief_non_goals_lifted(self):
        body = self._build()
        self.assertIn("Skip the yak shave.", body)
        self.assertIn("Don't refactor X.", body)

    def test_plan_risks_lifted(self):
        body = self._build()
        self.assertIn("Tricky merge ordering.", body)
        self.assertIn("Test flakiness.", body)

    def test_review_decision_and_findings_lifted(self):
        body = self._build()
        self.assertIn("approve", body)
        self.assertIn("Reviewer flagged unrelated drift.", body)

    def test_qa_known_issues_lifted(self):
        body = self._build()
        self.assertIn("Slow test in tests/foo.py.", body)

    def test_build_deviations_lifted(self):
        body = self._build()
        self.assertIn("Renamed helper foo to bar.", body)

    def test_template_inlined(self):
        body = self._build()
        self.assertIn("# Follow-ups", body)
        self.assertIn("deferred_from_bounce", body)
        self.assertIn("no_followups", body)

    def test_rules_block_load_bearing_lines(self):
        body = self._build()
        self.assertIn("Read-only stage", body)
        self.assertIn("Write 1–5 entries", body)
        self.assertIn("no_followups", body)
        self.assertIn("the cache cost", body)

    def test_missing_brief_section_emits_fallback(self):
        self.brief.write_text("# Brief\n\n## Goal\n\nOnly the goal.\n")
        body = self._build()
        self.assertIn("(none in brief.md)", body)

    def test_missing_plan_section_emits_fallback(self):
        self.plan.write_text("# Plan\n\n## Proposed changes\n\nOnly this.\n")
        body = self._build()
        self.assertIn("(none in plan.md)", body)

    def test_missing_review_emits_fallback(self):
        self.review.write_text("# Review\n")
        body = self._build()
        self.assertIn("(none in review.md)", body)

    def test_missing_qa_emits_fallback(self):
        self.qa.write_text("# QA report\n\n## Other section\n\nIrrelevant.\n")
        body = self._build()
        self.assertIn("(none in qa/report.md)", body)

    def test_missing_build_deviations_emits_fallback(self):
        self.build_md.write_text("# Build report\n\n## Implementation summary\n\nDone.\n")
        body = self._build()
        self.assertIn("(none in build.md)", body)

    def test_findings_section_falls_back_to_alternate_heading(self):
        self.review.write_text(
            "# Review\n\n## Decision\n\nrequest_changes\n\n"
            "## Findings & remediations\n\n- Alternate heading style.\n"
        )
        body = self._build()
        self.assertIn("Alternate heading style.", body)

    def test_missing_template_emits_fallback(self):
        body = followups_context.build(
            brief_path=self.brief,
            plan_path=self.plan,
            build_md_path=self.build_md,
            review_path=self.review,
            qa_report_path=self.qa,
            followups_template_path=self.tmp / "nope.md",
        )
        self.assertIn("(templates/follow-ups.md missing or empty)", body)

    def test_returns_string(self):
        body = self._build()
        self.assertIsInstance(body, str)

    def test_write_creates_parent_dir(self):
        target = self.tmp / "deep" / "nested" / "followups-context.md"
        followups_context.write(target, "hello\n")
        self.assertTrue(target.exists())
        self.assertEqual(target.read_text(), "hello\n")


class TestWriteFollowupsContextArtifacts(unittest.TestCase):
    """Integration test for cmd_followups._write_followups_context_artifacts."""

    def setUp(self):
        self.tmp = make_tmp_workbench()

    def tearDown(self):
        cleanup(self.tmp)
        reset_caches()

    def _make_run_in_followups(self, run_id: str):
        """Construct a staged run already past validating, sitting in followups."""
        from lib import config, metadata as metadata_mod, lifecycle
        cfg = config.load(self.tmp)
        metadata_mod.create(
            cfg, run_id,
            repo_mode="existing",
            repo_path="/tmp/repo",
            repo_name="repo",
            base_ref="main",
            worktree_name="wt",
            branch_name="agent/wt",
            raw_idea_path="raw-idea.md",
            worktree_path="/tmp/wt",
        )
        def _m(d):
            d["status"] = "followups"
        metadata_mod.update(cfg, run_id, _m)

        rd = metadata_mod.run_dir(cfg, run_id)
        # Synthesize prior-stage outputs in their stage dirs.
        shaping = lifecycle.stage_dir(cfg, run_id, "shaping")
        shaping.mkdir(parents=True, exist_ok=True)
        (shaping / "brief.md").write_text(
            "# Brief\n\n## Non-goals\n\n- Skip Y.\n"
        )
        planning = lifecycle.stage_dir(cfg, run_id, "planning")
        planning.mkdir(parents=True, exist_ok=True)
        (planning / "plan.md").write_text(
            "# Plan\n\n## Risks\n\n- Risk A.\n"
        )
        building = lifecycle.stage_dir(cfg, run_id, "building")
        building.mkdir(parents=True, exist_ok=True)
        (building / "build.md").write_text(
            "# Build report\n\n## Deviations from plan\n\n- Dev A.\n"
        )
        validating = lifecycle.stage_dir(cfg, run_id, "validating")
        validating.mkdir(parents=True, exist_ok=True)
        (validating / "review.md").write_text(
            "# Review\n\n## Decision\n\napprove\n\n## Findings\n\n- F1.\n"
        )
        (validating / "qa").mkdir(parents=True, exist_ok=True)
        (validating / "qa" / "report.md").write_text(
            "# QA\n\n## Known issues\n\n- I1.\n"
        )
        return cfg, rd

    def test_writes_followups_context_md_into_stage_dir(self):
        from lib import lifecycle
        from lib.cli import cmd_followups

        cfg, rd = self._make_run_in_followups("2030-01-01-fctx")
        cmd_followups._write_followups_context_artifacts(cfg, "2030-01-01-fctx", rd)
        target = lifecycle.stage_dir(cfg, "2030-01-01-fctx", "followups") / "followups-context.md"
        self.assertTrue(target.exists(), f"helper did not write followups-context.md at {target}")
        body = target.read_text()
        self.assertIn("# followups-context.md", body)
        self.assertIn("Skip Y.", body)  # brief lifted
        self.assertIn("Risk A.", body)  # plan lifted
        self.assertIn("Dev A.", body)  # build lifted
        self.assertIn("F1.", body)  # review lifted
        self.assertIn("I1.", body)  # qa lifted

    def test_swallows_builder_exception(self):
        from lib import lifecycle
        from lib.cli import cmd_followups

        cfg, rd = self._make_run_in_followups("2030-01-02-fctx-fail")
        with mock.patch("lib.cli.cmd_followups.followups_context.build",
                        side_effect=RuntimeError("boom")):
            cmd_followups._write_followups_context_artifacts(cfg, "2030-01-02-fctx-fail", rd)
        target = lifecycle.stage_dir(cfg, "2030-01-02-fctx-fail", "followups") / "followups-context.md"
        self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
