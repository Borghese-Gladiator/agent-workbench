"""Detect scope creep by comparing brief.md's expected file list to the diff.

Used by lib/cli/cmd_validate.py (TODO §1g). The CLI calls extract_expected_files
on brief.md, then detect_creep on the result vs. `git diff --name-only`. Any
diff files not anticipated by the brief are appended as a `## Scope creep check`
section to review.md.

The deep blast-radius traversal (depth-2/3 caller graph) is authored by the
LLM during /validate — this module covers the mechanical, deterministic half.
"""
from __future__ import annotations

import fnmatch
import re


EXPECTED_FILE_SECTION_HEADINGS = (
    "Files likely to change",
    "Files to change",
    "Scope",
)


_BULLET_RE = re.compile(r"^\s*-\s+(?P<path>\S+)", re.MULTILINE)


def extract_expected_files(brief_md_text: str) -> list[str] | None:
    """Return the list of expected paths under a recognised brief heading.

    Returns:
        None if no matching heading exists (caller: skip the check — the
            brief didn't make a claim).
        []   if the heading exists but the section body has no bullets
            (treated as "brief expected zero files"; every diff file is creep).
        list of stripped path strings otherwise.
    """
    for heading in EXPECTED_FILE_SECTION_HEADINGS:
        body = _section_body(brief_md_text, heading)
        if body is None:
            continue
        # Strip HTML comments so template placeholders don't count.
        body = re.sub(r"<!--.*?-->", "", body, flags=re.DOTALL)
        paths: list[str] = []
        for m in _BULLET_RE.finditer(body):
            p = m.group("path").strip().rstrip(":,;")
            if p and not p.startswith("<") and not p.startswith("("):
                paths.append(p)
        return paths
    return None


def _section_body(md_text: str, heading: str) -> str | None:
    pat = re.compile(
        rf"^##\s+{re.escape(heading)}\s*$(?P<body>.*?)(?=^##\s|\Z)",
        re.IGNORECASE | re.MULTILINE | re.DOTALL,
    )
    m = pat.search(md_text)
    return m.group("body") if m else None


def detect_creep(expected: list[str], actual: list[str]) -> list[str]:
    """Return the subset of `actual` paths not anticipated by `expected`.

    Matching rules (in order, first wins):
      - exact path equality
      - prefix match if an expected entry ends with `/`
      - fnmatch.fnmatch glob (so "*.md" and "src/**/*.py" work)
      - suffix path match in either direction. The brief author may write
        a workbench-relative path (`lib/run_ids.py`) while `git diff`
        emits a worktree-root-relative path
        (`agentic-development-task-system-v2__ai/agent-workbench-live/lib/run_ids.py`);
        we accept either form. Match boundary is the `/` separator so
        `foo.py` does not match `barfoo.py`.
    """
    creep: list[str] = []
    for path in actual:
        if not _matches_any(path, expected):
            creep.append(path)
    return creep


def _matches_any(path: str, expected: list[str]) -> bool:
    for exp in expected:
        if path == exp:
            return True
        if exp.endswith("/") and path.startswith(exp):
            return True
        if fnmatch.fnmatch(path, exp):
            return True
        if _suffix_match(path, exp):
            return True
    return False


def _suffix_match(a: str, b: str) -> bool:
    """True iff one path is a `/`-separated tail of the other."""
    if a == b:
        return True
    if a.endswith("/" + b):
        return True
    if b.endswith("/" + a):
        return True
    return False
