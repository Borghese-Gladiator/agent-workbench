"""Unit tests for the deterministic shape-context.md generator (TODO §5).

Mirrors the shape of `tests/test_build_context.py`.
"""
from __future__ import annotations

import pathlib
import tempfile
import unittest
from unittest import mock

from tests._helpers import make_tmp_workbench, cleanup, reset_caches  # noqa: F401

from lib import shape_context


class TestShapeContextBuild(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="sctx-"))
        self.raw_idea = self.tmp / "raw-idea.md"
        self.raw_idea.write_text("# Idea\n\nBuild a thing.\n")
        self.answers = self.tmp / "answers.md"
        self.answers.write_text(
            "# Answers\n\n## Q1\n**Question:** scope?\n**Answer:** narrow\n"
        )
        self.template = self.tmp / "brief.md"
        self.template.write_text(
            "# Brief\n\n## Goal\n\n## Non-goals\n\n## Constraints\n"
        )

    def tearDown(self):
        cleanup(self.tmp)

    def _build(self, *, with_answers: bool = True) -> str:
        return shape_context.build(
            raw_idea_path=self.raw_idea,
            answers_path=self.answers if with_answers else None,
            brief_template_path=self.template,
        )

    def test_renders_all_sections_with_answers(self):
        body = self._build(with_answers=True)
        for header in (
            "# shape-context.md",
            "## Raw idea",
            "## Answers",
            "## brief.md template skeleton",
            "## Rules",
        ):
            self.assertIn(header, body, f"missing section: {header}")

    def test_raw_idea_inlined(self):
        body = self._build()
        self.assertIn("Build a thing.", body)

    def test_answers_inlined_when_present(self):
        body = self._build(with_answers=True)
        self.assertIn("scope?", body)
        self.assertIn("narrow", body)

    def test_answers_section_omitted_when_path_is_none(self):
        body = self._build(with_answers=False)
        self.assertNotIn("## Answers", body)

    def test_answers_section_omitted_when_file_missing(self):
        self.answers.unlink()
        body = shape_context.build(
            raw_idea_path=self.raw_idea,
            answers_path=self.answers,
            brief_template_path=self.template,
        )
        # Empty answers file (read returns "") -> section omitted because content
        # is whitespace-only.
        self.assertNotIn("## Answers", body)

    def test_template_inlined(self):
        body = self._build()
        self.assertIn("# Brief", body)
        self.assertIn("## Goal", body)

    def test_rules_block_load_bearing_lines(self):
        body = self._build()
        self.assertIn("Do NOT read code", body)
        self.assertIn("Do NOT ask the user questions", body)
        self.assertIn("the cache cost", body)

    def test_missing_raw_idea_renders_fallback(self):
        body = shape_context.build(
            raw_idea_path=self.tmp / "nope.md",
            answers_path=None,
            brief_template_path=self.template,
        )
        self.assertIn("(raw-idea.md missing or empty)", body)

    def test_missing_template_renders_fallback(self):
        body = shape_context.build(
            raw_idea_path=self.raw_idea,
            answers_path=None,
            brief_template_path=self.tmp / "nope.md",
        )
        self.assertIn("(templates/brief.md missing or empty)", body)

    def test_returns_string(self):
        body = self._build()
        self.assertIsInstance(body, str)

    def test_write_creates_parent_dir(self):
        target = self.tmp / "deep" / "nested" / "shape-context.md"
        shape_context.write(target, "hello\n")
        self.assertTrue(target.exists())
        self.assertEqual(target.read_text(), "hello\n")


class TestWriteShapeContextArtifacts(unittest.TestCase):
    """Integration test for cmd_shape._write_shape_context_artifacts."""

    def setUp(self):
        self.tmp = make_tmp_workbench()

    def tearDown(self):
        cleanup(self.tmp)
        reset_caches()

    def _make_run_in_shaping(self, run_id: str):
        from lib import config, metadata as metadata_mod
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
        )
        def _m(d):
            d["status"] = "shaping"
        metadata_mod.update(cfg, run_id, _m)

        rd = metadata_mod.run_dir(cfg, run_id)
        (rd / "raw-idea.md").write_text("# Idea\n\nMake it.\n")
        return cfg, rd

    def test_writes_shape_context_md_into_stage_dir(self):
        from lib import lifecycle
        from lib.cli import cmd_shape

        cfg, rd = self._make_run_in_shaping("2030-01-01-shapectx")
        cmd_shape._write_shape_context_artifacts(cfg, "2030-01-01-shapectx", rd)
        # New staged runs always have the stages/ layout (init_staged_layout
        # is called from new-run); the helper resolves to stages/2_shaping/.
        if lifecycle.is_staged_run(cfg, "2030-01-01-shapectx"):
            target = lifecycle.stage_dir(cfg, "2030-01-01-shapectx", "shaping") / "shape-context.md"
        else:
            target = rd / "shape-context.md"
        self.assertTrue(target.exists(), f"helper did not write shape-context.md at {target}")
        body = target.read_text()
        self.assertIn("# shape-context.md", body)
        self.assertIn("Make it.", body)

    def test_swallows_builder_exception(self):
        from lib.cli import cmd_shape

        cfg, rd = self._make_run_in_shaping("2030-01-02-shapectx-fail")
        with mock.patch("lib.cli.cmd_shape.shape_context.build",
                        side_effect=RuntimeError("boom")):
            cmd_shape._write_shape_context_artifacts(cfg, "2030-01-02-shapectx-fail", rd)
        # No file should have been written.
        from lib import lifecycle
        if lifecycle.is_staged_run(cfg, "2030-01-02-shapectx-fail"):
            target = lifecycle.stage_dir(cfg, "2030-01-02-shapectx-fail", "shaping") / "shape-context.md"
        else:
            target = rd / "shape-context.md"
        self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
