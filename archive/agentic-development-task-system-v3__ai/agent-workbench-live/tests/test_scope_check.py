"""Unit tests for lib/scope_check.py (TODO §1g)."""
from __future__ import annotations

import unittest

from tests._helpers import make_tmp_workbench, cleanup  # noqa: F401

from lib import scope_check


BRIEF_WITH_LIKELY = """\
# Brief

## Goal

Add a /hello endpoint.

## Files likely to change

- src/server.py
- src/routes/
- *.md
- tests/test_hello.py

## Acceptance criteria

- Endpoint returns 200.
"""

BRIEF_WITH_SCOPE_HEADING = """\
# Brief

## Scope

- src/foo.py
"""

BRIEF_NO_SECTION = """\
# Brief

## Goal

Just a goal.

## Acceptance criteria

- A
"""

BRIEF_EMPTY_SECTION = """\
# Brief

## Files likely to change

<!-- placeholder; the planner left this empty -->

## Goal

x
"""


class TestExtractExpectedFiles(unittest.TestCase):
    """All call shape: extract_expected_files(text). Cases share no fixture but
    are folded into one test because the assertions are uniform — each line is
    one (input, expected) pair.
    """

    def test_extract_cases(self):
        cases = [
            ("no section → None", BRIEF_NO_SECTION, None),
            ("empty section → []", BRIEF_EMPTY_SECTION, []),
            (
                "files-likely-to-change → bullets",
                BRIEF_WITH_LIKELY,
                ["src/server.py", "src/routes/", "*.md", "tests/test_hello.py"],
            ),
            ("scope heading also accepted", BRIEF_WITH_SCOPE_HEADING, ["src/foo.py"]),
            ("case-insensitive heading", "## files Likely to change\n\n- foo.py\n", ["foo.py"]),
            (
                "skips html-comment placeholders",
                "## Files likely to change\n\n"
                "<!-- - <placeholder> — describe -->\n"
                "- real.py\n",
                ["real.py"],
            ),
        ]
        for label, text, expected in cases:
            self.assertEqual(
                scope_check.extract_expected_files(text), expected, msg=label
            )


class TestDetectCreep(unittest.TestCase):
    """All call shape: detect_creep(expected, actual). Cases fold into one
    test because each is one (expected, actual, creep) row."""

    def test_creep_cases(self):
        cases = [
            ("exact match → empty", ["foo.py"], ["foo.py"], []),
            ("extra unexpected file is creep", ["foo.py"], ["foo.py", "bar.py"], ["bar.py"]),
            (
                "trailing-slash prefix covers nested files",
                ["src/routes/"],
                ["src/routes/hello.py", "src/routes/auth.py"],
                [],
            ),
            (
                "prefix does NOT cover unrelated paths",
                ["src/routes/"],
                ["src/server.py"],
                ["src/server.py"],
            ),
            (
                "glob *.md matches README but not src/foo.py",
                ["*.md"],
                ["README.md", "src/foo.py"],
                ["src/foo.py"],
            ),
            ("empty expected → everything is creep", [], ["a.py", "b.py"], ["a.py", "b.py"]),
            ("no actuals → no creep", ["a.py"], [], []),
            (
                "suffix match: workbench-relative expected, worktree-root actual",
                ["lib/run_ids.py"],
                ["agentic-development-task-system-v2__ai/agent-workbench-live/lib/run_ids.py"],
                [],
            ),
            (
                "suffix match: reverse direction",
                ["agentic-development-task-system-v2__ai/agent-workbench-live/lib/run_ids.py"],
                ["lib/run_ids.py"],
                [],
            ),
            (
                "suffix match respects /-boundary (foo.py does NOT match barfoo.py)",
                ["foo.py"],
                ["barfoo.py"],
                ["barfoo.py"],
            ),
        ]
        for label, expected, actual, creep in cases:
            self.assertEqual(
                scope_check.detect_creep(expected, actual), creep, msg=label
            )


if __name__ == "__main__":
    unittest.main()
