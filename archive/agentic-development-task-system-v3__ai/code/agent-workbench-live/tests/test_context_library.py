"""Structural invariants for the @context/... library (TODO §1).

Asserts the file tree exists exactly as the brief specifies, each leaf
file follows the four-marker template, file size stays under one
screen, the README indexes every leaf, and no `workflows/` subdir has
crept in.
"""
from __future__ import annotations

import pathlib
import unittest

from tests._helpers import ROOT  # agent-workbench-live/

CONTEXT_ROOT = ROOT / "context"

# The exact tree the brief mandates. README first, then leaves grouped
# by concern. If the brief changes, change this list.
REQUIRED_FILES = (
    "README.md",
    "AUTHORING.md",
    "git/commit.md",
    "git/worktrees.md",
    "git/draft-pr.md",
    "languages/python/setup.md",
    "languages/python/dependencies.md",
    "languages/python/testing.md",
    "languages/python/quality.md",
    "languages/javascript-typescript/setup.md",
    "languages/javascript-typescript/dependencies.md",
    "languages/javascript-typescript/testing.md",
    "languages/javascript-typescript/quality.md",
    "languages/go/setup.md",
    "languages/go/dependencies.md",
    "languages/go/testing.md",
    "languages/go/quality.md",
    "infra/secrets.md",
    "infra/shell.md",
    "infra/docker.md",
    "infra/ci.md",
    "infra/sql-migrations.md",
    "diagnostics/sentry-bug-triage.md",
)

REQUIRED_MARKERS = ("Applies when:", "Do:", "Do not:", "Commands:")

# One-screen rule from the brief is ~50 lines; allow up to 60 for files
# carrying a short fenced code block (DR-002 in the plan).
LINE_CAP = 60


def _path(rel: str) -> pathlib.Path:
    return CONTEXT_ROOT / rel


class TestDirectoryTree(unittest.TestCase):
    def test_every_required_file_exists(self):
        missing = [rel for rel in REQUIRED_FILES if not _path(rel).is_file()]
        self.assertFalse(missing, f"missing required context files: {missing}")

    def test_no_workflows_subdir(self):
        # Workflows belong in .claude/commands/*, not in the context library.
        self.assertFalse(
            (CONTEXT_ROOT / "workflows").exists(),
            "context/workflows/ must not exist — workflows live in .claude/commands/",
        )


class TestLeafFileTemplate(unittest.TestCase):
    def test_each_non_readme_has_four_markers(self):
        offenders: list[tuple[str, list[str]]] = []
        for rel in REQUIRED_FILES:
            if rel == "README.md":
                continue
            text = _path(rel).read_text()
            missing = [m for m in REQUIRED_MARKERS if m not in text]
            if missing:
                offenders.append((rel, missing))
        self.assertFalse(
            offenders,
            "files missing required four-marker template: " + repr(offenders),
        )

    def test_each_non_readme_within_line_cap(self):
        offenders: list[tuple[str, int]] = []
        for rel in REQUIRED_FILES:
            if rel == "README.md":
                continue
            line_count = len(_path(rel).read_text().splitlines())
            if line_count > LINE_CAP:
                offenders.append((rel, line_count))
        self.assertFalse(
            offenders,
            f"files over the {LINE_CAP}-line cap: {offenders}",
        )


class TestReadmeIndex(unittest.TestCase):
    def test_readme_indexes_every_leaf(self):
        readme_text = (CONTEXT_ROOT / "README.md").read_text()
        missing: list[str] = []
        for rel in REQUIRED_FILES:
            if rel == "README.md":
                continue
            # Each leaf should appear as an @context/... import path.
            import_path = f"@context/{rel}"
            if import_path not in readme_text:
                missing.append(import_path)
        self.assertFalse(
            missing,
            f"README.md missing index entries for: {missing}",
        )


if __name__ == "__main__":
    unittest.main()
