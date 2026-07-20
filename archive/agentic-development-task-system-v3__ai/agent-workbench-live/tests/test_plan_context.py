"""Unit tests for the deterministic plan-context.md generator (TODO §5).

Mirrors the shape of `tests/test_build_context.py`.
"""
from __future__ import annotations

import pathlib
import tempfile
import unittest
from unittest import mock

from tests._helpers import make_tmp_workbench, cleanup, reset_caches  # noqa: F401

from lib import plan_context


class TestPlanContextBuild(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="pctx-"))
        self.brief = self.tmp / "brief.md"
        self.brief.write_text(
            "# Brief\n\n"
            "## Goal\n\nDo a thing.\n\n"
            "## Acceptance criteria\n\n- [x] Thing works.\n\n"
            "## Files likely to change\n\n- lib/foo.py\n- lib/bar.py\n"
        )
        self.template = self.tmp / "plan.md"
        self.template.write_text(
            "# Plan\n\n## Current repo understanding\n\n## Proposed changes\n"
        )
        self.worktree = self.tmp / "worktree"
        self.worktree.mkdir()
        self.meta = {
            "target": {
                "repo": {"base_ref": "main", "base_ref_sha": "abc123def"},
                "worktree": {
                    "path": str(self.worktree),
                    "branch_name": "agent/foo",
                },
            },
        }

    def tearDown(self):
        cleanup(self.tmp)

    _SENTINEL = object()

    def _build(self, *, worktree_path=_SENTINEL) -> str:
        if worktree_path is self._SENTINEL:
            worktree_path = str(self.worktree)
        return plan_context.build(
            brief_path=self.brief,
            plan_template_path=self.template,
            worktree_path=worktree_path,
            meta=self.meta,
        )

    def test_renders_all_sections(self):
        body = self._build()
        for header in (
            "# plan-context.md",
            "## Brief",
            "## Repo map",
            "## Files likely to change (from brief)",
            "## Worktree",
            "## plan.md template skeleton",
            "## Rules",
        ):
            self.assertIn(header, body, f"missing section: {header}")

    def test_brief_inlined(self):
        body = self._build()
        self.assertIn("Do a thing.", body)
        self.assertIn("Thing works.", body)

    def test_files_likely_to_change_lifted(self):
        body = self._build()
        self.assertIn("lib/foo.py", body)
        self.assertIn("lib/bar.py", body)

    def test_files_likely_to_change_omitted_when_missing(self):
        self.brief.write_text(
            "# Brief\n\n## Goal\n\nNo files-list here.\n"
        )
        body = self._build()
        self.assertIn("(none in brief.md)", body)

    def test_worktree_block_renders(self):
        body = self._build()
        self.assertIn(str(self.worktree), body)
        self.assertIn("agent/foo", body)
        self.assertIn("main", body)
        self.assertIn("abc123def", body)

    def test_template_inlined(self):
        body = self._build()
        self.assertIn("# Plan", body)
        self.assertIn("## Current repo understanding", body)

    def test_rules_block_load_bearing_lines(self):
        body = self._build()
        self.assertIn("MAY read code", body)
        self.assertIn("Do NOT ask the user questions", body)
        self.assertIn("the cache cost", body)
        self.assertIn("Explore", body)

    def test_repo_map_detects_python_pyproject(self):
        (self.worktree / "pyproject.toml").write_text(
            "[tool.poetry]\nname='foo'\n\n[tool.pytest.ini_options]\n"
        )
        body = self._build()
        self.assertIn("Python (`pyproject.toml`)", body)
        self.assertIn("`pytest`", body)

    def test_repo_map_detects_javascript_package_json(self):
        (self.worktree / "package.json").write_text(
            '{"name":"foo","scripts":{"test":"jest","build":"webpack","lint":"eslint ."}}'
        )
        body = self._build()
        self.assertIn("JavaScript/TypeScript (`package.json`)", body)
        self.assertIn("npm run test", body)
        self.assertIn("npm run build", body)

    def test_repo_map_detects_rust(self):
        (self.worktree / "Cargo.toml").write_text("[package]\nname='foo'\n")
        body = self._build()
        self.assertIn("Rust (`Cargo.toml`)", body)
        self.assertIn("`cargo test`", body)

    def test_repo_map_detects_go(self):
        (self.worktree / "go.mod").write_text("module foo\n\ngo 1.21\n")
        body = self._build()
        self.assertIn("Go (`go.mod`)", body)
        self.assertIn("go test ./...", body)

    def test_repo_map_detects_makefile_targets(self):
        (self.worktree / "Makefile").write_text(
            ".PHONY: test build lint\n\n"
            "test:\n\tpytest\n\n"
            "build:\n\techo build\n\n"
            "lint:\n\tflake8\n\n"
            "random-target:\n\techo nope\n"
        )
        body = self._build()
        self.assertIn("make test", body)
        self.assertIn("make build", body)
        self.assertIn("make lint", body)
        # Uninteresting targets are NOT lifted (random-target shouldn't appear
        # in the curated command list).
        self.assertNotIn("make random-target", body)

    def test_repo_map_handles_missing_worktree_path(self):
        body = self._build(worktree_path=None)
        self.assertIn("worktree not yet created", body)

    def test_repo_map_handles_nonexistent_worktree_path(self):
        body = self._build(worktree_path="/no/such/path/xyz")
        self.assertIn("does not exist", body)

    def test_repo_map_lists_top_level_dirs(self):
        (self.worktree / "src").mkdir()
        (self.worktree / "tests").mkdir()
        (self.worktree / ".hidden").mkdir()
        (self.worktree / "node_modules").mkdir()
        body = self._build()
        self.assertIn("`src/`", body)
        self.assertIn("`tests/`", body)
        # Dotfiles and skip-dirs aren't listed.
        self.assertNotIn("`.hidden/`", body)
        self.assertNotIn("`node_modules/`", body)

    def test_repo_map_no_manifests_emits_explicit_fallback(self):
        # Worktree exists but has no recognized manifests.
        (self.worktree / "src").mkdir()
        body = self._build()
        self.assertIn("no recognized manifests at worktree root", body)

    def test_missing_brief_renders_fallback(self):
        body = plan_context.build(
            brief_path=self.tmp / "nope.md",
            plan_template_path=self.template,
            worktree_path=str(self.worktree),
            meta=self.meta,
        )
        self.assertIn("(brief.md missing or empty)", body)

    def test_missing_template_renders_fallback(self):
        body = plan_context.build(
            brief_path=self.brief,
            plan_template_path=self.tmp / "nope.md",
            worktree_path=str(self.worktree),
            meta=self.meta,
        )
        self.assertIn("(templates/plan.md missing or empty)", body)

    def test_missing_meta_fields_render_fallback(self):
        body = plan_context.build(
            brief_path=self.brief,
            plan_template_path=self.template,
            worktree_path=str(self.worktree),
            meta={},
        )
        self.assertIn("(not set)", body)

    def test_returns_string(self):
        body = self._build()
        self.assertIsInstance(body, str)

    def test_write_creates_parent_dir(self):
        target = self.tmp / "deep" / "nested" / "plan-context.md"
        plan_context.write(target, "hello\n")
        self.assertTrue(target.exists())
        self.assertEqual(target.read_text(), "hello\n")


class TestWritePlanContextArtifacts(unittest.TestCase):
    """Integration test for cmd_plan._write_plan_context_artifacts."""

    def setUp(self):
        self.tmp = make_tmp_workbench()

    def tearDown(self):
        cleanup(self.tmp)
        reset_caches()

    def _make_run_in_planning(self, run_id: str):
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
            worktree_path=str(self.tmp / "fake-wt"),
        )
        (self.tmp / "fake-wt").mkdir(exist_ok=True)
        def _m(d):
            d["status"] = "planning"
        metadata_mod.update(cfg, run_id, _m)

        rd = metadata_mod.run_dir(cfg, run_id)
        (rd / "brief.md").write_text(
            "# Brief\n\n## Goal\n\nDo it.\n\n## Files likely to change\n\n- foo.py\n"
        )
        return cfg, rd

    def test_writes_plan_context_md_into_stage_dir(self):
        from lib import lifecycle, metadata as metadata_mod
        from lib.cli import cmd_plan

        cfg, rd = self._make_run_in_planning("2030-01-01-pctx")
        meta = metadata_mod.load(cfg, "2030-01-01-pctx")
        staged = lifecycle.is_staged_run(cfg, "2030-01-01-pctx")
        cmd_plan._write_plan_context_artifacts(cfg, "2030-01-01-pctx", rd, staged, meta)
        if staged:
            target = lifecycle.stage_dir(cfg, "2030-01-01-pctx", "planning") / "plan-context.md"
        else:
            target = rd / "plan-context.md"
        self.assertTrue(target.exists(), f"helper did not write plan-context.md at {target}")
        body = target.read_text()
        self.assertIn("# plan-context.md", body)
        self.assertIn("Do it.", body)
        self.assertIn("foo.py", body)

    def test_swallows_builder_exception(self):
        from lib import lifecycle, metadata as metadata_mod
        from lib.cli import cmd_plan

        cfg, rd = self._make_run_in_planning("2030-01-02-pctx-fail")
        meta = metadata_mod.load(cfg, "2030-01-02-pctx-fail")
        staged = lifecycle.is_staged_run(cfg, "2030-01-02-pctx-fail")
        with mock.patch("lib.cli.cmd_plan.plan_context.build",
                        side_effect=RuntimeError("boom")):
            cmd_plan._write_plan_context_artifacts(cfg, "2030-01-02-pctx-fail", rd, staged, meta)
        if staged:
            target = lifecycle.stage_dir(cfg, "2030-01-02-pctx-fail", "planning") / "plan-context.md"
        else:
            target = rd / "plan-context.md"
        self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
