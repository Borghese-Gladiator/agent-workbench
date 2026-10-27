"""Regression test for the §5 rebuild fix.

The validate subagent on the first §5 build found F-001: the canonical user
path (`agent-workbench validate <run_id>`) did NOT write
`followups-context.md` on the `validating -> followups` transition. Only the
rarer `cmd_followups --init` shortcut wrote it. This test pins the contract
that BOTH paths now produce the curated file.

The test drives `cmd_validate.run()` in default mode on a synthetic
validating-state run and asserts that `stages/6_followups/followups-context.md`
exists with the expected content after the transition completes.
"""
from __future__ import annotations

import argparse
import pathlib
import subprocess
import unittest
from unittest import mock

from tests._helpers import make_tmp_workbench, cleanup, reset_caches  # noqa: F401


class TestValidateDefaultModeWritesFollowupsContext(unittest.TestCase):
    """Drive a synthetic run through `cmd_validate.run()` default mode and
    assert `followups-context.md` lands in `stages/6_followups/`.
    """

    def setUp(self):
        self.tmp = make_tmp_workbench()

    def tearDown(self):
        cleanup(self.tmp)
        reset_caches()

    def _git(self, *args, cwd: pathlib.Path) -> None:
        subprocess.run(
            ["git", *args],
            cwd=cwd,
            check=True,
            capture_output=True,
        )

    def _init_worktree_repo(self) -> pathlib.Path:
        """Create a real git repo for the run's worktree so the audit and
        doc-claim subprocesses don't choke."""
        wt = self.tmp / "fake-worktree"
        wt.mkdir(exist_ok=True)
        self._git("init", "-q", cwd=wt)
        self._git("config", "user.email", "test@example.com", cwd=wt)
        self._git("config", "user.name", "test", cwd=wt)
        (wt / "README.md").write_text("hello\n")
        self._git("add", ".", cwd=wt)
        self._git("commit", "-q", "-m", "initial", cwd=wt)
        return wt

    def _make_validating_run(self, run_id: str) -> tuple:
        """Construct a synthetic staged run in `validating` state with all
        prior-stage outputs in their stage dirs."""
        from lib import config, metadata as metadata_mod, lifecycle
        cfg = config.load(self.tmp)
        wt = self._init_worktree_repo()
        metadata_mod.create(
            cfg, run_id,
            repo_mode="existing",
            repo_path=str(wt),
            repo_name="fake-worktree",
            base_ref="master",
            worktree_name="wt",
            branch_name="agent/wt",
            raw_idea_path="raw-idea.md",
            worktree_path=str(wt),
            base_ref_sha="0" * 40,
        )
        def _m(d):
            d["status"] = "validating"
            d["artifacts"]["implementation_summary"] = "stages/4_building/build.md"
            d["artifacts"]["diff_summary"] = "stages/4_building/build.md#files-changed"
            d["artifacts"]["review_report"] = "review.md"
            d["artifacts"]["qa_report"] = "qa/report.md"
            d["artifacts"]["handoff"] = "HUMAN_REVIEW.md"
        metadata_mod.update(cfg, run_id, _m)

        rd = metadata_mod.run_dir(cfg, run_id)
        # Stage prior-stage outputs in their stage dirs.
        for stage_name, name, body in [
            ("shaping", "brief.md",
             "# Brief\n\n## Goal\n\nDo it.\n\n## Non-goals\n\n- Skip Y.\n"),
            ("planning", "plan.md",
             "# Plan\n\n## Risks\n\n- Risk A.\n"),
            ("building", "build.md",
             "# Build report\n\n## Implementation summary\n\nDone.\n\n"
             "## Files changed\n\n- foo.py\n\n"
             "## Acceptance criteria coverage\n\n| AC | Test |\n|----|------|\n| A1 | ok |\n\n"
             "## Deviations from plan\n\n- Dev A.\n\n"
             "## Known issues\n\n- none\n\n"
             "## Commands run\n\n- pytest\n\n"
             "## Documentation touched\n\nnone needed — internal change only\n"),
        ]:
            d = lifecycle.stage_dir(cfg, run_id, stage_name)
            d.mkdir(parents=True, exist_ok=True)
            (d / name).write_text(body)

        # review.md + qa/report.md still at run root (they get moved by the
        # validating -> followups transition).
        (rd / "review.md").write_text(
            "# Review\n\n## Decision\n\napprove\n\n## Findings\n\n- F1.\n"
        )
        (rd / "qa").mkdir(parents=True, exist_ok=True)
        (rd / "qa" / "report.md").write_text(
            "# QA\n\n## Summary\n\nok\n\n## Known issues\n\n- I1.\n"
        )
        # Minimal HUMAN_REVIEW.md so the cmd_followups default path's heading
        # validation (which runs at validating->followups time? actually at
        # followups->human_review) doesn't trip. We're not driving that far
        # here — just stopping at validating -> followups.
        (rd / "HUMAN_REVIEW.md").write_text(
            "# Human Review\n\n## Files\n\n## Summary of changes\n\n"
            "## Testing\n\n## Run timeline\n"
        )
        return cfg, rd

    def test_validate_default_mode_writes_followups_context(self):
        from lib.cli import cmd_validate
        from lib import lifecycle

        cfg, rd = self._make_validating_run("2030-01-01-validate-fctx")

        args = argparse.Namespace(
            run_id="2030-01-01-validate-fctx",
            init=False,
            tests_passed="true",
            known_issues=0,
            root=self.tmp,
        )

        # Drive the default-mode path. The audit module shells out to git
        # against the worktree, which exists with one commit, so it should
        # succeed. `_write_validate_context_artifacts` is called on
        # `building -> validating` only (not exercised in default mode); the
        # new call we're testing is `_write_followups_context_artifacts`.
        rc = cmd_validate.run(args)
        self.assertEqual(rc, 0, "cmd_validate.run() returned non-zero")

        # The §5 contract requires followups-context.md to be present after
        # the validating -> followups transition on the CANONICAL path
        # (this test would have failed pre-fix; the previous build only
        # wrote the file from `cmd_followups --init`).
        target = lifecycle.stage_dir(cfg, "2030-01-01-validate-fctx", "followups") / "followups-context.md"
        self.assertTrue(
            target.exists(),
            f"cmd_validate default mode did NOT write followups-context.md "
            f"(F-001 regression). Expected at: {target}"
        )

        body = target.read_text()
        # Spot-check a few lifted sections to confirm the right helper ran.
        self.assertIn("# followups-context.md", body)
        self.assertIn("Skip Y.", body)  # from brief's Non-goals
        self.assertIn("Risk A.", body)  # from plan's Risks
        self.assertIn("F1.", body)  # from review's Findings
        self.assertIn("I1.", body)  # from qa's Known issues
        self.assertIn("Dev A.", body)  # from build's Deviations


if __name__ == "__main__":
    unittest.main()
