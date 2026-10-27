"""Unit tests for lib.metrics.lines."""
from __future__ import annotations

import json
import pathlib
import subprocess
import tempfile
import unittest

from lib.metrics import lines


def _git(cwd: pathlib.Path, *args, check=True):
    proc = subprocess.run(
        ["git", "-C", str(cwd), "-c", "user.name=t", "-c", "user.email=t@x", *args],
        capture_output=True, text=True, check=check,
    )
    return proc


class TestExtractSha(unittest.TestCase):
    def test_plain_hex(self):
        self.assertEqual(lines._extract_sha("abc1234"), "abc1234")

    def test_local_branch_prefix(self):
        self.assertIsNone(lines._extract_sha("local-branch:agent/x"))

    def test_colon_suffix_sha(self):
        self.assertEqual(lines._extract_sha("merge:abc1234567"), "abc1234567")

    def test_garbage_returns_none(self):
        self.assertIsNone(lines._extract_sha("not-a-sha"))

    def test_full_40_char_sha(self):
        sha = "a" * 40
        self.assertEqual(lines._extract_sha(sha), sha)


class TestGenerated(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="aw-lines-"))
        _git(self.tmp, "init", "-q", "-b", "main")
        (self.tmp / "a.txt").write_text("hello\n")
        _git(self.tmp, "add", "-A")
        _git(self.tmp, "commit", "-q", "-m", "init")

    def test_generated_lines_from_log(self):
        _git(self.tmp, "checkout", "-q", "-b", "feature")
        (self.tmp / "b.txt").write_text("one\ntwo\nthree\n")
        _git(self.tmp, "add", "-A")
        _git(self.tmp, "commit", "-q", "-m", "add b")
        n = lines.count_generated(
            worktree_path=str(self.tmp),
            base_ref="main",
            events_path=None,
        )
        self.assertEqual(n, 3)

    def test_generated_zero_when_no_commits(self):
        n = lines.count_generated(
            worktree_path=str(self.tmp),
            base_ref="main",
            events_path=None,
        )
        self.assertEqual(n, 0)

    def test_generated_includes_artifact_writes(self):
        events_path = self.tmp / "events.jsonl"
        events_path.write_text(
            json.dumps({"type": "ArtifactWritten", "payload": {"content_length_lines": 12}}) + "\n"
            + json.dumps({"type": "ArtifactWritten", "payload": {"content_length_lines": 8}}) + "\n"
            + json.dumps({"type": "Other"}) + "\n"
        )
        n = lines.count_generated(
            worktree_path=str(self.tmp),
            base_ref="main",
            events_path=events_path,
        )
        self.assertEqual(n, 20)


class TestAccepted(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="aw-lines-"))
        _git(self.tmp, "init", "-q", "-b", "main")
        (self.tmp / "a.txt").write_text("hello\n")
        _git(self.tmp, "add", "-A")
        _git(self.tmp, "commit", "-q", "-m", "init")

    def test_accepted_zero_when_no_merge(self):
        n, sha = lines.count_accepted(
            worktree_path=str(self.tmp),
            base_ref="main",
            completion_ref="local-branch:agent/x",
        )
        self.assertEqual(n, 0)
        self.assertIsNone(sha)

    def test_accepted_zero_when_completion_ref_empty(self):
        n, sha = lines.count_accepted(
            worktree_path=str(self.tmp),
            base_ref="main",
            completion_ref=None,
        )
        self.assertEqual(n, 0)
        self.assertIsNone(sha)

    def test_accepted_from_merged_commit(self):
        _git(self.tmp, "checkout", "-q", "-b", "feature")
        (self.tmp / "b.txt").write_text("one\ntwo\n")
        _git(self.tmp, "add", "-A")
        _git(self.tmp, "commit", "-q", "-m", "add b")
        sha = _git(self.tmp, "rev-parse", "HEAD").stdout.strip()
        n, returned_sha = lines.count_accepted(
            worktree_path=str(self.tmp),
            base_ref="main",
            completion_ref=sha,
        )
        self.assertEqual(n, 2)
        self.assertEqual(returned_sha, sha)


class TestBaseRefShaResolution(unittest.TestCase):
    """Regression coverage for runs whose `base_ref` is the literal string `"HEAD"`.

    Pre-fix: `git log --numstat HEAD..HEAD` returns zero commits, so
    `generated_lines` was always 0 for runs that used the default `base_ref: HEAD`.
    Fix: prefer a captured 40-char SHA (`base_ref_sha`) over the symbolic ref,
    and fall back to a lazy `git rev-parse <base_ref>` inside the worktree
    when the SHA wasn't captured (pre-existing runs).
    """

    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="aw-lines-baseref-"))
        _git(self.tmp, "init", "-q", "-b", "main")
        (self.tmp / "a.txt").write_text("hello\n")
        _git(self.tmp, "add", "-A")
        _git(self.tmp, "commit", "-q", "-m", "init")
        self.initial_sha = _git(self.tmp, "rev-parse", "HEAD").stdout.strip()
        # Land one more commit (3 added lines) on the same branch — this is
        # the work the metrics layer should attribute as "generated".
        (self.tmp / "b.txt").write_text("one\ntwo\nthree\n")
        _git(self.tmp, "add", "-A")
        _git(self.tmp, "commit", "-q", "-m", "add b")

    def test_generated_with_base_ref_sha_pins_symbolic_head(self):
        # base_ref="HEAD" + captured SHA → the SHA wins; range is initial..HEAD.
        n = lines.count_generated(
            worktree_path=str(self.tmp),
            base_ref="HEAD",
            base_ref_sha=self.initial_sha,
            events_path=None,
        )
        self.assertEqual(n, 3)

    def test_generated_lazy_resolver_uses_symbolic_branch(self):
        # No SHA captured (pre-existing run); base_ref="main" still resolves
        # via the lazy `git rev-parse` inside the worktree. "main" points at
        # the latest commit, so `main..HEAD` is empty — that's correct
        # behavior for runs whose worktree branch == base branch.
        # Switch to a feature branch to model the real-world case.
        _git(self.tmp, "checkout", "-q", "-b", "feature")
        (self.tmp / "c.txt").write_text("x\ny\n")
        _git(self.tmp, "add", "-A")
        _git(self.tmp, "commit", "-q", "-m", "add c")
        n = lines.count_generated(
            worktree_path=str(self.tmp),
            base_ref="main",
            base_ref_sha=None,
            events_path=None,
        )
        # main is at the second commit (3 lines); feature is +2 lines on top.
        self.assertEqual(n, 2)

    def test_generated_lazy_resolver_falls_back_on_bad_ref(self):
        # No SHA, base_ref is a ref that doesn't exist. Lazy rev-parse fails;
        # `git log` then also fails on the symbolic ref; result is 0. The
        # important assertion is that the function returns cleanly (no crash).
        n = lines.count_generated(
            worktree_path=str(self.tmp),
            base_ref="nonexistent-ref-xyz",
            base_ref_sha=None,
            events_path=None,
        )
        self.assertEqual(n, 0)

    def test_accepted_with_base_ref_sha_pins_symbolic_head(self):
        # Mirror `count_generated`'s fix: a real merge SHA + base_ref="HEAD"
        # + captured SHA produces a non-zero accepted count.
        merge_sha = _git(self.tmp, "rev-parse", "HEAD").stdout.strip()
        n, returned_sha = lines.count_accepted(
            worktree_path=str(self.tmp),
            base_ref="HEAD",
            base_ref_sha=self.initial_sha,
            completion_ref=merge_sha,
        )
        self.assertEqual(n, 3)
        self.assertEqual(returned_sha, merge_sha)


if __name__ == "__main__":
    unittest.main()
