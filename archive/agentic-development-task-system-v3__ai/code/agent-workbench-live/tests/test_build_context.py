"""Unit tests for the deterministic build-context.md generator (TODO §1).

Mirrors the shape of `tests/test_validate_context_build.py`.
"""
from __future__ import annotations

import pathlib
import tempfile
import unittest
from unittest import mock

from tests._helpers import make_tmp_workbench, cleanup, reset_caches  # noqa: F401

from lib import build_context


class TestBuildContextBuild(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="bctx-"))
        self.brief = self.tmp / "brief.md"
        self.brief.write_text(
            "# Brief\n\n"
            "## Goal\n\nDo a thing.\n\n"
            "## Acceptance criteria\n\n- [x] Thing works.\n\n"
            "## Non-goals\n\n- No yak shaving.\n"
        )
        self.plan = self.tmp / "plan.md"
        self.plan.write_text(
            "# Plan\n\n"
            "## Proposed changes\n\nChange A, change B.\n\n"
            "## Files likely to change\n\n- lib/foo.py\n- lib/bar.py\n\n"
            "## Test plan\n\nUnit tests in tests/test_foo.py.\n\n"
            "## Definition of done\n\nTests pass; code reviewed.\n\n"
            "## Decisions & assumptions\n\n"
            "### DR-001\n- **Decision**: choose A over B\n"
            "- **Rationale**: simpler\n\n"
            "### ASM-001\n- **Text**: foo is stable\n"
            "- **Impact**: low\n"
        )
        self.template = self.tmp / "build.md"
        self.template.write_text(
            "# Build report\n\n## What changed\n\n## Files changed\n"
        )
        self.meta = {
            "target": {
                "repo": {"base_ref": "main", "base_ref_sha": "abc123def"},
                "worktree": {
                    "path": "/wt/foo",
                    "branch_name": "agent/foo",
                },
            },
        }

    def tearDown(self):
        cleanup(self.tmp)

    def _build(self) -> str:
        return build_context.build(
            brief_path=self.brief,
            plan_path=self.plan,
            meta=self.meta,
            build_template_path=self.template,
        )

    def test_renders_all_sections(self):
        body = self._build()
        for header in (
            "# build-context.md",
            "## Acceptance criteria",
            "## Non-goals",
            "## Proposed changes",
            "## Files likely to change",
            "## Test plan",
            "## Definition of done",
            "## Decisions & assumptions",
            "## Worktree",
            "## build.md template skeleton",
            "## Rules",
        ):
            self.assertIn(header, body, f"missing section: {header}")

    def test_brief_sections_inlined(self):
        body = self._build()
        self.assertIn("Thing works", body)
        self.assertIn("No yak shaving", body)

    def test_plan_sections_inlined(self):
        body = self._build()
        self.assertIn("Change A, change B", body)
        self.assertIn("lib/foo.py", body)
        self.assertIn("Unit tests in tests/test_foo.py", body)
        self.assertIn("Tests pass; code reviewed", body)

    def test_decisions_block_includes_all_dr_and_asm(self):
        body = self._build()
        # At building-entry there is no build.md to filter against, so all
        # blocks should appear (contrast with validate_context._filtered_plan_blocks).
        self.assertIn("DR-001", body)
        self.assertIn("ASM-001", body)
        self.assertIn("choose A over B", body)
        self.assertIn("foo is stable", body)

    def test_worktree_block_renders_metadata(self):
        body = self._build()
        self.assertIn("/wt/foo", body)
        self.assertIn("agent/foo", body)
        self.assertIn("abc123def", body)
        self.assertIn("main", body)

    def test_template_inlined(self):
        body = self._build()
        self.assertIn("# Build report", body)
        self.assertIn("## What changed", body)

    def test_rules_block_load_bearing_one_liners(self):
        body = self._build()
        self.assertIn("Stay bounded by the brief", body)
        self.assertIn("Record deviations from the plan", body)

    def test_missing_brief_section_emits_fallback(self):
        self.brief.write_text("# Brief\n\n## Goal\n\nOnly the goal.\n")
        body = self._build()
        # No Acceptance criteria, no Non-goals headings.
        self.assertIn("(none in brief.md)", body)

    def test_missing_plan_section_emits_fallback(self):
        self.plan.write_text("# Plan\n\n## Proposed changes\n\nOnly this.\n")
        body = self._build()
        self.assertIn("(none in plan.md)", body)

    def test_missing_template_emits_fallback(self):
        body = build_context.build(
            brief_path=self.brief,
            plan_path=self.plan,
            meta=self.meta,
            build_template_path=self.tmp / "nope.md",
        )
        self.assertIn("(templates/build.md missing or empty)", body)

    def test_missing_brief_file_does_not_crash(self):
        body = build_context.build(
            brief_path=self.tmp / "nope-brief.md",
            plan_path=self.plan,
            meta=self.meta,
            build_template_path=self.template,
        )
        # Sections that depend on brief render fallbacks; the build still runs.
        self.assertIn("(none in brief.md)", body)

    def test_missing_meta_fields_render_fallback(self):
        body = build_context.build(
            brief_path=self.brief,
            plan_path=self.plan,
            meta={},
            build_template_path=self.template,
        )
        self.assertIn("(not set)", body)

    def test_returns_string(self):
        body = self._build()
        self.assertIsInstance(body, str)

    def test_write_creates_parent_dir(self):
        target = self.tmp / "deep" / "nested" / "build-context.md"
        build_context.write(target, "hello\n")
        self.assertTrue(target.exists())
        self.assertEqual(target.read_text(), "hello\n")


class TestWriteBuildContextArtifacts(unittest.TestCase):
    """Integration test for cmd_start._write_build_context_artifacts.

    Drives the helper directly against a minimal flat-layout run (no full
    /shape /plan /start subprocess wrapping needed). Covers:
      - The helper writes build-context.md to the right path.
      - The helper swallows builder exceptions without raising.
    """

    def setUp(self):
        self.tmp = make_tmp_workbench()

    def tearDown(self):
        cleanup(self.tmp)
        reset_caches()

    def _make_flat_run(self, run_id: str) -> tuple:
        """Construct a minimal flat-layout run on disk via metadata.create
        and mutate metadata to `ready` with a worktree path + base_ref_sha
        set, matching the post-/start state cmd_start would have produced.
        """
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
            worktree_path="/tmp/wt",
            base_ref_sha="deadbeef" * 5,
        )
        # Bump status to `ready` so the helper's reload sees a sensible state.
        def _m(d):
            d["status"] = "ready"
        metadata_mod.update(cfg, run_id, _m)

        rd = metadata_mod.run_dir(cfg, run_id)
        (rd / "brief.md").write_text(
            "# Brief\n\n## Acceptance criteria\n\n- [x] Works.\n\n## Non-goals\n\n- None.\n"
        )
        (rd / "plan.md").write_text(
            "# Plan\n\n## Proposed changes\n\nDo it.\n\n"
            "## Files likely to change\n\n- foo.py\n\n"
            "## Test plan\n\nTest it.\n\n"
            "## Definition of done\n\nDone.\n"
        )
        return cfg, rd

    def test_writes_build_context_md_for_flat_run(self):
        from lib.cli import cmd_start

        cfg, rd = self._make_flat_run("2030-01-01-bctx-helper")
        cmd_start._write_build_context_artifacts(cfg, "2030-01-01-bctx-helper", staged=False)
        target = rd / "build-context.md"
        self.assertTrue(target.exists(), "helper did not write build-context.md")
        body = target.read_text()
        self.assertIn("# build-context.md", body)
        self.assertIn("- [x] Works.", body)  # brief content lifted
        self.assertIn("foo.py", body)  # plan content lifted
        self.assertIn("/tmp/wt", body)  # worktree from meta

    def test_swallows_builder_exception(self):
        from lib.cli import cmd_start

        cfg, rd = self._make_flat_run("2030-01-02-bctx-helper-fail")
        with mock.patch("lib.cli.cmd_start.build_context.build",
                        side_effect=RuntimeError("boom")):
            # Must not raise.
            cmd_start._write_build_context_artifacts(
                cfg, "2030-01-02-bctx-helper-fail", staged=False,
            )
        # And nothing should have been written.
        self.assertFalse((rd / "build-context.md").exists())


if __name__ == "__main__":
    unittest.main()
