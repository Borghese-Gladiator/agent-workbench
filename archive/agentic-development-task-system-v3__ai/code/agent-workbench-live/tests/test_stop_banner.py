"""Unit + snapshot tests for lib/cli/_stop_banner.py (TODO §2)."""
from __future__ import annotations

import contextlib
import io
import os
import pathlib
import tempfile
import unittest

from lib.cli._stop_banner import BORDER, print_stop_banner, render_stop_banner


SNAPSHOTS = pathlib.Path(__file__).resolve().parent / "snapshots"
SAMPLE_RUN_ID = "SAMPLE-RUN-ID"


def _render(state: str, run_id: str = SAMPLE_RUN_ID) -> str:
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        print_stop_banner(state, run_id)
    return buf.getvalue()


class TestPrintStopBanner(unittest.TestCase):
    def test_ready_banner_structure(self):
        out = _render("ready")
        self.assertTrue(out.startswith(BORDER + "\n"))
        self.assertTrue(out.rstrip("\n").endswith(BORDER))
        self.assertIn("STOP. State: ready (human-owned).", out)
        self.assertIn(SAMPLE_RUN_ID, out)
        self.assertIn(f"/start {SAMPLE_RUN_ID}", out)
        # Slash-form replaces the shell-form.
        self.assertNotIn("agent-workbench start", out)
        self.assertIn("Next moves (human-triggered, type in a session):", out)

    def test_no_shell_form_in_any_banner(self):
        """Cross-state pin: no banner renders the shell-form `agent-workbench` literal."""
        for state in ("ready", "human_review", "done", "abandoned"):
            out = _render(state)
            self.assertNotIn(
                "agent-workbench ",
                out,
                f"shell-form leaked into {state} banner",
            )

    def test_human_review_banner_structure(self):
        # No-cfg fallback: only the three slash-form Next moves lines are
        # rendered. The full five-section body is exercised in
        # test_stop_banner_human_review_body.py.
        out = _render("human_review")
        self.assertIn("STOP. State: human_review (human-owned).", out)
        self.assertIn(SAMPLE_RUN_ID, out)
        self.assertIn(f"/complete {SAMPLE_RUN_ID}", out)
        self.assertIn(f"/bounce {SAMPLE_RUN_ID}", out)
        self.assertIn(f"/abandon {SAMPLE_RUN_ID}", out)
        # Slash-form replaces the shell-form (TODO §2 acceptance).
        self.assertNotIn("agent-workbench complete", out)
        self.assertNotIn("agent-workbench bounce", out)
        self.assertNotIn("agent-workbench abandon", out)
        self.assertIn("Next moves (human-triggered, type in a session):", out)

    def test_done_banner_structure(self):
        out = _render("done")
        self.assertIn("STOP. State: done (terminal).", out)
        self.assertIn("Terminal state. No further action.", out)
        self.assertNotIn("Next moves", out)
        # Terminal banners do not interpolate the run_id.
        self.assertNotIn(SAMPLE_RUN_ID, out)

    def test_abandoned_banner_structure(self):
        out = _render("abandoned")
        self.assertIn("STOP. State: abandoned (terminal).", out)
        self.assertIn("Terminal state. No further action.", out)
        self.assertNotIn("Next moves", out)
        self.assertNotIn(SAMPLE_RUN_ID, out)

    def test_invalid_state_raises(self):
        with self.assertRaises(ValueError) as cm:
            print_stop_banner("planning", SAMPLE_RUN_ID)
        self.assertIn("planning", str(cm.exception))

    def test_other_invalid_states_raise(self):
        # Spot-check a couple of other lifecycle states that are NOT
        # agent-stopping. Sanity check on the closed-set validation.
        for bad in ("draft", "shaping", "building", "validating", "followups", ""):
            with self.assertRaises(ValueError):
                print_stop_banner(bad, SAMPLE_RUN_ID)

    def test_border_is_60_columns(self):
        # Pin the border width so future edits don't drift it silently.
        self.assertEqual(len(BORDER), 60)
        out = _render("ready")
        for line in (out.splitlines()[0], out.splitlines()[-1]):
            self.assertEqual(line, BORDER)


class TestWriteTo(unittest.TestCase):
    """`write_to` persists the rendered banner to disk for durable handoff."""

    def test_write_to_writes_rendered_banner(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = pathlib.Path(tmp) / "nested" / "stop-banner.txt"
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                print_stop_banner("ready", SAMPLE_RUN_ID, write_to=target)
            self.assertTrue(target.exists())
            on_disk = target.read_text()
            stdout = buf.getvalue()
            # File content matches render_stop_banner exactly + a trailing newline.
            self.assertEqual(on_disk, render_stop_banner("ready", SAMPLE_RUN_ID) + "\n")
            # Same content also went to stdout (minus the writer's trailing newline,
            # since print() adds its own).
            self.assertEqual(stdout.rstrip("\n"), on_disk.rstrip("\n"))

    def test_write_to_creates_parent_dirs(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = pathlib.Path(tmp) / "a" / "b" / "c" / "stop-banner.txt"
            with contextlib.redirect_stdout(io.StringIO()):
                print_stop_banner("done", SAMPLE_RUN_ID, write_to=target)
            self.assertTrue(target.exists())

    def test_write_to_none_skips_write(self):
        # The default (write_to=None) must not raise and must not touch disk.
        with contextlib.redirect_stdout(io.StringIO()):
            print_stop_banner("abandoned", SAMPLE_RUN_ID)  # no write_to kwarg

    def test_write_failure_is_swallowed(self):
        # Convenience artifact: a write failure must NOT propagate, so the
        # transition itself never fails on disk weirdness.
        with tempfile.TemporaryDirectory() as tmp:
            # Point write_to at a path whose "parent" is a regular file —
            # mkdir(parents=True) will raise OSError on this.
            blocker = pathlib.Path(tmp) / "blocker"
            blocker.write_text("not a directory")
            target = blocker / "stop-banner.txt"
            with contextlib.redirect_stdout(io.StringIO()):
                # Must not raise.
                print_stop_banner("ready", SAMPLE_RUN_ID, write_to=target)


class TestSnapshots(unittest.TestCase):
    """Exact-format snapshot per landing state. Catches wording drift.

    Set ``WRITE_SNAPSHOTS=1`` to re-baseline; commit only after eyeballing
    the diff.
    """

    def _check_snapshot(self, state: str) -> None:
        rendered = _render(state)
        path = SNAPSHOTS / f"stop_banner_{state}.expected.txt"
        if os.environ.get("WRITE_SNAPSHOTS"):
            path.write_text(rendered)
            return
        self.assertTrue(
            path.exists(),
            f"missing snapshot: {path}; rerun with WRITE_SNAPSHOTS=1 to baseline",
        )
        expected = path.read_text()
        self.assertMultiLineEqual(expected, rendered)

    def test_ready_snapshot(self):
        self._check_snapshot("ready")

    def test_human_review_snapshot(self):
        self._check_snapshot("human_review")

    def test_done_snapshot(self):
        self._check_snapshot("done")

    def test_abandoned_snapshot(self):
        self._check_snapshot("abandoned")


class TestHandoffRenderingRegressions(unittest.TestCase):
    """TODO §13 regression: the banner's `Summary of changes` must show file
    names inline. Previously the parent `- N file(s) touched:` bullet would
    render with no file names below it because the banner extractor dropped
    nested rows."""

    def test_file_list_renders_inline_not_split(self):
        from tests._helpers import make_tmp_workbench, cleanup, reset_caches
        from lib import config as cfg_mod, metadata, lifecycle, human_review
        tmp = make_tmp_workbench()
        try:
            cfg = cfg_mod.load(tmp)
            run_id = "2026-05-27-banner-inline-test"
            metadata.create(
                cfg, run_id,
                repo_mode="existing", repo_path="/tmp/repo", repo_name="repo",
                base_ref="HEAD", worktree_name="inline-test",
                branch_name="agent/inline-test", raw_idea_path="raw-idea.md",
                scope_kind="implementation", scope_summary="inline test",
            )
            lifecycle.init_staged_layout(cfg, run_id)
            rd = metadata.run_dir(cfg, run_id)
            (rd / "raw-idea.md").write_text("test idea\n")
            # Stage a build.md with 3 named files.
            build_dir = rd / "stages" / "4_building"
            build_dir.mkdir(parents=True, exist_ok=True)
            (build_dir / "build.md").write_text(
                "# Build\n\n"
                "## What changed\n\nWired up the new endpoint.\n\n"
                "## Files changed\n\n"
                "- `alpha.py`\n- `beta.py`\n- `gamma.py`\n"
            )
            # Render HUMAN_REVIEW.md, then drive the banner's bullet extractor.
            human_review.render(cfg, run_id)
            from lib.cli._stop_banner import _render_summary_bullets
            bullets = _render_summary_bullets(rd / "HUMAN_REVIEW.md")
            joined = "\n".join(bullets)
            # The banner must show the file names inline, not the hollow form.
            self.assertIn("alpha.py", joined)
            self.assertIn("beta.py", joined)
            self.assertIn("gamma.py", joined)
            self.assertNotIn("- 3 file(s) touched:\n", joined + "\n")
        finally:
            cleanup(tmp)
            reset_caches()


if __name__ == "__main__":
    unittest.main()
