"""Unit tests for lib/cli/cmd_validate.py.

Currently exercises the TODO §13 half-Candidate-B fix: the build.md template
fallback must be observable (stderr warning + ArtifactWritten event +
meta["build"]["template_fallback_fired"] flag) instead of silent.
"""
from __future__ import annotations

import argparse
import contextlib
import io
import unittest

from tests._helpers import make_tmp_workbench, cleanup, reset_caches


class TestTemplateFallbackObservable(unittest.TestCase):
    """TODO §13 half-Candidate-B regression."""

    def setUp(self):
        self.tmp = make_tmp_workbench()

    def tearDown(self):
        cleanup(self.tmp)
        reset_caches()

    def _make_building_run(self):
        """Create a staged run, then drop it directly into `building` state by
        editing metadata.yaml — bypassing the transition engine. The point of
        this test is the template-fallback path inside cmd_validate --init,
        not the chain of upstream transitions."""
        from lib import config as cfg_mod, metadata, lifecycle
        cfg = cfg_mod.load(self.tmp)
        run_id = "2026-05-27-template-fallback-test"
        metadata.create(
            cfg, run_id,
            repo_mode="existing", repo_path="/tmp/repo", repo_name="repo",
            base_ref="HEAD", worktree_name="fallback-test",
            branch_name="agent/fallback-test", raw_idea_path="raw-idea.md",
            scope_kind="implementation", scope_summary="fallback test",
        )
        lifecycle.init_staged_layout(cfg, run_id)
        rd = metadata.run_dir(cfg, run_id)
        (rd / "raw-idea.md").write_text("test idea\n")
        # Force status -> building. Bypasses the transition engine intentionally.
        def _b(d):
            d["status"] = "building"
        metadata.update(cfg, run_id, _b)
        return cfg, run_id, rd

    def test_template_fallback_emits_warning_and_flag(self):
        from lib import metadata, events
        from lib.cli import cmd_validate

        cfg, run_id, rd = self._make_building_run()
        # Sanity: builder produced no build.md.
        self.assertFalse((rd / "build.md").exists())

        args = argparse.Namespace(
            run_id=run_id, init=True, tests_passed=None, known_issues=0,
            root=self.tmp,
        )
        err_buf = io.StringIO()
        out_buf = io.StringIO()
        with contextlib.redirect_stderr(err_buf), contextlib.redirect_stdout(out_buf):
            rc = cmd_validate.run(args)
        self.assertEqual(rc, 0, msg=f"stderr={err_buf.getvalue()!r}")

        # (a) stderr warning names the missing build output.
        stderr = err_buf.getvalue()
        self.assertIn("WARNING", stderr)
        self.assertIn("build.md", stderr)

        # (b) meta["build"]["template_fallback_fired"] is True.
        meta = metadata.load(cfg, run_id)
        self.assertTrue(meta["build"].get("template_fallback_fired"))

        # (c) an ArtifactWritten event records the fallback.
        evs = [
            e for e in events.iter_events(cfg, run_id)
            if e["type"] == "ArtifactWritten"
            and (e.get("payload") or {}).get("summary", "").startswith(
                "template fallback fired"
            )
        ]
        self.assertEqual(len(evs), 1, msg=f"events={evs!r}")


if __name__ == "__main__":
    unittest.main()
