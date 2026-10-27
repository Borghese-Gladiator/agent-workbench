"""Unit tests for the deterministic validate-context.md / blast-radius
generators (pass-2 B2 + B4).
"""
from __future__ import annotations

import pathlib
import subprocess
import tempfile
import unittest

from lib import validate_context


def _git(path: pathlib.Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(path), *args],
        capture_output=True, text=True, check=True,
    ).stdout


def _init_repo(d: pathlib.Path) -> str:
    d.mkdir(parents=True, exist_ok=True)
    _git(d, "init", "-q")
    _git(d, "config", "user.email", "t@e.x")
    _git(d, "config", "user.name", "test")
    (d / "README.md").write_text("# repo\n")
    _git(d, "add", "README.md")
    _git(d, "commit", "-qm", "initial")
    base = _git(d, "rev-parse", "HEAD").strip()
    return base


class TestValidateContextBuild(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="vctx-"))
        # Inputs.
        self.brief = self.tmp / "brief.md"
        self.brief.write_text(
            "# Brief\n\n## Goal\n\nDo the thing.\n\n## Acceptance criteria\n\n- [x] Thing works.\n"
        )
        self.plan = self.tmp / "plan.md"
        self.plan.write_text(
            "# Plan\n\n## Decisions & assumptions\n\n"
            "### DR-001\n- **Decision**: foo\n\n"
            "### ASM-001\n- **Text**: bar\n\n"
            "### DR-002\n- **Decision**: unused\n"
        )
        self.build_md = self.tmp / "build.md"
        self.build_md.write_text(
            "# Build\n\nRefs: DR-001 and ASM-001.\n\n"
            "## Commands run\n\n- `pytest -q`\n\n"
            "## Known issues\n\n- none\n"
        )
        self.qa = self.tmp / "qa-report.md"
        self.qa.write_text("# QA\n\n## Test results\n\n- 100 passed\n")
        # Real worktree with one extra file.
        self.worktree = self.tmp / "wt"
        self.base_ref = _init_repo(self.worktree)
        (self.worktree / "feature.py").write_text("def f():\n    return 1\n")
        _git(self.worktree, "add", "feature.py")
        _git(self.worktree, "commit", "-qm", "add feature")

    def test_renders_all_sections(self):
        body = validate_context.build(
            brief_path=self.brief,
            plan_path=self.plan,
            build_md_path=self.build_md,
            qa_report_path=self.qa,
            worktree_path=str(self.worktree),
            base_ref=self.base_ref,
        )
        for header in (
            "## Original task",
            "## Acceptance criteria",
            "## Plan decisions + assumptions (filtered)",
            "## Final diff",
            "## Files changed",
            "## Commands run",
            "## Test results",
            "## Known issues / risks",
            "## Reviewer reading order",
        ):
            self.assertIn(header, body, f"missing section: {header}")

    def test_plan_filter_keeps_only_referenced_ids(self):
        body = validate_context.build(
            brief_path=self.brief,
            plan_path=self.plan,
            build_md_path=self.build_md,
            qa_report_path=self.qa,
            worktree_path=str(self.worktree),
            base_ref=self.base_ref,
        )
        self.assertIn("DR-001", body)
        self.assertIn("ASM-001", body)
        # DR-002 is in plan but NOT referenced by build_md — must be filtered.
        self.assertNotIn("DR-002", body)

    def test_plan_filter_fallback_when_no_references(self):
        # Build.md mentions nothing → all IDs should be included.
        (self.tmp / "build-empty.md").write_text("# Build\n\nNothing of note.\n")
        body = validate_context.build(
            brief_path=self.brief,
            plan_path=self.plan,
            build_md_path=self.tmp / "build-empty.md",
            qa_report_path=self.qa,
            worktree_path=str(self.worktree),
            base_ref=self.base_ref,
        )
        self.assertIn("DR-001", body)
        self.assertIn("DR-002", body)

    def test_diff_section_includes_stat(self):
        body = validate_context.build(
            brief_path=self.brief,
            plan_path=self.plan,
            build_md_path=self.build_md,
            qa_report_path=self.qa,
            worktree_path=str(self.worktree),
            base_ref=self.base_ref,
        )
        # Diff stat output mentions the new file.
        self.assertIn("feature.py", body)

    def test_diff_section_with_symbolic_head_and_sha(self):
        """TODO §3 item 2a: when base_ref is symbolic 'HEAD', a passed
        base_ref_sha must be preferred so the diff is non-empty."""
        body = validate_context.build(
            brief_path=self.brief,
            plan_path=self.plan,
            build_md_path=self.build_md,
            qa_report_path=self.qa,
            worktree_path=str(self.worktree),
            base_ref="HEAD",  # symbolic — would diff against itself
            base_ref_sha=self.base_ref,  # the SHA captured at /start time
        )
        # Diff is non-empty because we resolved to the captured SHA.
        self.assertIn("feature.py", body)
        self.assertNotIn("(no files changed yet)", body)

    def test_diff_section_with_symbolic_head_no_sha_falls_back(self):
        """Without base_ref_sha, the symbolic 'HEAD' resolves to the
        worktree's own HEAD via lazy resolution; diff against itself is
        empty. This documents the legacy behavior — runs without the SHA
        captured at /start time still produce a degraded curated file."""
        body = validate_context.build(
            brief_path=self.brief,
            plan_path=self.plan,
            build_md_path=self.build_md,
            qa_report_path=self.qa,
            worktree_path=str(self.worktree),
            base_ref="HEAD",
            base_ref_sha=None,
        )
        # Lazy resolution: rev-parse HEAD == worktree HEAD == diff is empty.
        self.assertIn("(no files changed yet)", body)

    def test_handles_missing_inputs(self):
        body = validate_context.build(
            brief_path=self.tmp / "no-brief.md",
            plan_path=self.tmp / "no-plan.md",
            build_md_path=self.tmp / "no-build.md",
            qa_report_path=self.tmp / "no-qa.md",
            worktree_path=str(self.worktree),
            base_ref=self.base_ref,
        )
        # Generator must not crash; sections should mark themselves as missing.
        self.assertIn("brief.md missing or empty", body)
        self.assertIn("plan.md missing or empty", body)

    def test_write_creates_parent_dir(self):
        target = self.tmp / "deep" / "nested" / "validate-context.md"
        validate_context.write(target, "hello\n")
        self.assertTrue(target.exists())
        self.assertEqual(target.read_text(), "hello\n")

    def test_uncommitted_changes_appear_in_files_changed(self):
        """Uncommitted (staged but not committed) edits must show up under
        the Uncommitted section of `Files changed`. Validation typically
        runs before the builder has committed, so committed-only diffs
        render an empty section in the common case.
        """
        (self.worktree / "feature2.py").write_text("def alpha():\n    return 1\n")
        _git(self.worktree, "add", "feature2.py")
        # NOTE: deliberately NOT committing — we want to see the uncommitted
        # case in the rendered output.
        body = validate_context.build(
            brief_path=self.brief,
            plan_path=self.plan,
            build_md_path=self.build_md,
            qa_report_path=self.qa,
            worktree_path=str(self.worktree),
            base_ref=self.base_ref,
        )
        self.assertIn("Uncommitted", body)
        self.assertIn("feature2.py", body)

    def test_untracked_files_appear_in_files_changed(self):
        """Untracked files must show up under the Untracked section."""
        (self.worktree / "untracked.py").write_text("# new file\n")
        body = validate_context.build(
            brief_path=self.brief,
            plan_path=self.plan,
            build_md_path=self.build_md,
            qa_report_path=self.qa,
            worktree_path=str(self.worktree),
            base_ref=self.base_ref,
        )
        self.assertIn("Untracked", body)
        self.assertIn("untracked.py", body)


class TestBlastRadiusBuild(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="blast-"))
        self.worktree = self.tmp / "wt"
        self.base_ref = _init_repo(self.worktree)

    def test_empty_diff(self):
        out = validate_context.build_blast_radius(
            worktree_path=str(self.worktree),
            base_ref=self.base_ref,
        )
        self.assertIn("no files changed", out)

    def test_simple_diff_renders_depth_1(self):
        (self.worktree / "feature.py").write_text(
            "def alpha():\n    return 1\n\n"
            "class Beta:\n    pass\n"
        )
        _git(self.worktree, "add", "feature.py")
        _git(self.worktree, "commit", "-qm", "add")
        out = validate_context.build_blast_radius(
            worktree_path=str(self.worktree),
            base_ref=self.base_ref,
        )
        self.assertIn("depth 1 (changed files):", out)
        self.assertIn("feature.py", out)

    def test_blast_radius_with_symbolic_head_and_sha(self):
        """TODO §3 item 2a: blast_radius must honor base_ref_sha when
        base_ref is symbolic 'HEAD', otherwise it reads against the
        post-commit HEAD and finds no changes."""
        (self.worktree / "feature.py").write_text(
            "def alpha():\n    return 1\n"
        )
        _git(self.worktree, "add", "feature.py")
        _git(self.worktree, "commit", "-qm", "add")
        out = validate_context.build_blast_radius(
            worktree_path=str(self.worktree),
            base_ref="HEAD",  # symbolic — would diff against current HEAD
            base_ref_sha=self.base_ref,  # the SHA captured at /start time
        )
        self.assertIn("depth 1 (changed files):", out)
        self.assertIn("feature.py", out)
        self.assertNotIn("(no files changed yet)", out)

    def test_missing_worktree(self):
        out = validate_context.build_blast_radius(
            worktree_path="/nonexistent/path",
            base_ref=self.base_ref,
        )
        self.assertIn("not available", out)


class TestPrefersBaseRefSha(unittest.TestCase):
    """Regression tests for the 2a fix: when base_ref is the literal string
    'HEAD' but base_ref_sha carries the real fork point, both `build` and
    `build_blast_radius` must use the SHA rather than the symbolic ref."""

    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="vctx-sha-"))
        self.brief = self.tmp / "brief.md"
        self.brief.write_text("# Brief\n\n## Goal\n\nDo work.\n")
        self.plan = self.tmp / "plan.md"
        self.plan.write_text("# Plan\n")
        self.build_md = self.tmp / "build.md"
        self.build_md.write_text("# Build\n")
        self.qa = self.tmp / "qa-report.md"
        self.qa.write_text("# QA\n")
        # Two-commit worktree: one before recording the fork point, one after.
        self.worktree = self.tmp / "wt"
        self.fork_sha = _init_repo(self.worktree)
        # Two real commits past the fork — the diff against the fork point
        # should list both files.
        (self.worktree / "added_one.py").write_text("x = 1\n")
        _git(self.worktree, "add", "added_one.py")
        _git(self.worktree, "commit", "-qm", "first real commit")
        (self.worktree / "added_two.py").write_text("y = 2\n")
        _git(self.worktree, "add", "added_two.py")
        _git(self.worktree, "commit", "-qm", "second real commit")

    def test_build_prefers_sha_over_symbolic_HEAD(self):
        # With base_ref='HEAD' alone, `HEAD...HEAD` is empty (the original
        # bug). With the SHA passed, the diff sees both new files.
        body_broken = validate_context.build(
            brief_path=self.brief,
            plan_path=self.plan,
            build_md_path=self.build_md,
            qa_report_path=self.qa,
            worktree_path=str(self.worktree),
            base_ref="HEAD",
        )
        self.assertIn("no files changed yet", body_broken)
        self.assertNotIn("added_one.py", body_broken)

        body_fixed = validate_context.build(
            brief_path=self.brief,
            plan_path=self.plan,
            build_md_path=self.build_md,
            qa_report_path=self.qa,
            worktree_path=str(self.worktree),
            base_ref="HEAD",
            base_ref_sha=self.fork_sha,
        )
        self.assertIn("added_one.py", body_fixed)
        self.assertIn("added_two.py", body_fixed)

    def test_build_blast_radius_prefers_sha(self):
        out_broken = validate_context.build_blast_radius(
            worktree_path=str(self.worktree),
            base_ref="HEAD",
        )
        self.assertIn("no files changed", out_broken)

        out_fixed = validate_context.build_blast_radius(
            worktree_path=str(self.worktree),
            base_ref="HEAD",
            base_ref_sha=self.fork_sha,
        )
        self.assertIn("depth 1 (changed files):", out_fixed)
        self.assertIn("added_one.py", out_fixed)
        self.assertIn("added_two.py", out_fixed)

    def test_falls_back_to_symbolic_when_sha_missing(self):
        # When base_ref names a real symbolic ref, the SHA-less call path
        # must lazily rev-parse it inside the worktree. Tag the fork point
        # so we have a non-SHA name to resolve.
        _git(self.worktree, "tag", "fork-point", self.fork_sha)
        body = validate_context.build(
            brief_path=self.brief,
            plan_path=self.plan,
            build_md_path=self.build_md,
            qa_report_path=self.qa,
            worktree_path=str(self.worktree),
            base_ref="fork-point",
            base_ref_sha=None,
        )
        self.assertIn("added_one.py", body)
        self.assertIn("added_two.py", body)


if __name__ == "__main__":
    unittest.main()
