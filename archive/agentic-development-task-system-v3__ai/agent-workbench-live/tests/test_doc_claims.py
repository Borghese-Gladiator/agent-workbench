"""Unit tests for lib/doc_claims.py (TODO §1d)."""
from __future__ import annotations

import unittest

from tests._helpers import make_tmp_workbench, cleanup  # noqa: F401

from lib import doc_claims


SECTION_WITH_BULLETS = """\
# Build

## Files changed

- foo.py
- bar.py

## Documentation touched

- README.md — added a /hello example
- docs/api.md: documented the response schema
- AGENTS.md — noted the new dependency

## Commands run

- pytest
"""

SECTION_NONE_NEEDED = """\
# Build

## Documentation touched

none needed — change is internal-only with no user-facing surface

## Commands run
"""

SECTION_ABSENT = """\
# Build

## Files changed

- foo.py

## Commands run
"""

SECTION_EMPTY_BODY = """\
# Build

## Documentation touched

<!-- placeholder hint comment -->

## Commands run
"""


class TestExtract(unittest.TestCase):
    def test_extract_cases(self):
        # Most cases assert `extract(text) == expected`. NONE_NEEDED uses `is`
        # because doc_claims exports it as a sentinel; we encode that as a
        # special tuple shape (op, value).
        cases = [
            ("three bulleted paths",
             SECTION_WITH_BULLETS,
             ("eq", ["README.md", "docs/api.md", "AGENTS.md"])),
            ("none-needed sentinel",
             SECTION_NONE_NEEDED,
             ("is", doc_claims.NONE_NEEDED)),
            ("absent section → empty", SECTION_ABSENT, ("eq", [])),
            ("empty body (html comment only) → empty", SECTION_EMPTY_BODY, ("eq", [])),
            (
                "skips template placeholders",
                "## Documentation touched\n\n"
                "- <repo-relative path> — example placeholder\n"
                "- (real-doc.md) — another placeholder shape\n"
                "- actual.md — claimed update\n",
                ("eq", ["actual.md"]),
            ),
            (
                "case-insensitive heading",
                "## documentation Touched\n\n- foo.md — bar\n",
                ("eq", ["foo.md"]),
            ),
        ]
        for label, text, (op, expected) in cases:
            out = doc_claims.extract(text)
            if op == "eq":
                self.assertEqual(out, expected, msg=label)
            else:  # "is"
                self.assertIs(out, expected, msg=label)


class TestVerify(unittest.TestCase):
    """verify() shells out to git, so a real git repo is set up per test."""

    def setUp(self):
        import pathlib
        import subprocess
        import tempfile

        self.repo = pathlib.Path(tempfile.mkdtemp(prefix="aw-doc-"))
        subprocess.run(["git", "-C", str(self.repo), "init", "-q", "-b", "main"], check=True)
        (self.repo / "README.md").write_text("# repo\n")
        (self.repo / "src.py").write_text("x = 1\n")
        subprocess.run(["git", "-C", str(self.repo), "add", "-A"], check=True)
        subprocess.run([
            "git", "-C", str(self.repo),
            "-c", "user.name=t", "-c", "user.email=t@x",
            "commit", "-q", "-m", "init",
        ], check=True)
        # New branch with one changed file (src.py), README untouched.
        subprocess.run(["git", "-C", str(self.repo), "checkout", "-q", "-b", "feat"], check=True)
        (self.repo / "src.py").write_text("x = 2\n")
        subprocess.run(["git", "-C", str(self.repo), "add", "-A"], check=True)
        subprocess.run([
            "git", "-C", str(self.repo),
            "-c", "user.name=t", "-c", "user.email=t@x",
            "commit", "-q", "-m", "change",
        ], check=True)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_verify_cases(self):
        # Each case shares the git-repo fixture (one branch where src.py
        # changed, README.md did not). Cases differ only in the
        # (claims, base_ref) input and the expected `unverified` list.
        cases = [
            ("flags unchanged claim", ["README.md", "src.py"], "main", ["README.md"]),
            ("empty when all claims actually changed", ["src.py"], "main", []),
            ("empty input → empty output", [], "main", []),
            # Bad ref → git exits non-zero → verify returns [] (inconclusive).
            ("inconclusive on bad ref", ["x.md"], "no-such-ref", []),
        ]
        for label, claims, base_ref, expected in cases:
            self.assertEqual(
                doc_claims.verify(claims, self.repo, base_ref), expected, msg=label
            )

    def test_verify_prefers_base_ref_sha(self):
        """2b regression: when base_ref is the literal 'HEAD' but base_ref_sha
        carries the real fork point, verify must diff against the SHA."""
        import subprocess
        # The 'main' branch hasn't been touched since init; HEAD on the
        # current branch ('feat') is past the fork. The fork SHA is main's tip.
        fork_sha = subprocess.run(
            ["git", "-C", str(self.repo), "rev-parse", "main"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()

        # Without the SHA — HEAD...HEAD on the worktree is empty → all
        # claims look unverified, including the one that really changed.
        unverified_broken = doc_claims.verify(
            ["README.md", "src.py"], self.repo, "HEAD",
        )
        self.assertEqual(
            sorted(unverified_broken), ["README.md", "src.py"],
            "without SHA, both claims should look unverified",
        )

        # With the SHA — only README.md is unchanged, so only it shows up.
        unverified_fixed = doc_claims.verify(
            ["README.md", "src.py"], self.repo, "HEAD", base_ref_sha=fork_sha,
        )
        self.assertEqual(unverified_fixed, ["README.md"])

    def test_verify_falls_back_when_sha_missing(self):
        """SHA-less calls still resolve a valid symbolic ref."""
        # main is a valid symbolic ref → diff works without an explicit SHA.
        out = doc_claims.verify(
            ["README.md", "src.py"], self.repo, "main", base_ref_sha=None,
        )
        self.assertEqual(out, ["README.md"])


if __name__ == "__main__":
    unittest.main()
