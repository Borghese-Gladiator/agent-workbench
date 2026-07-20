"""Parse and verify the "Documentation touched" section in build.md.

Used by lib/cli/cmd_validate.py (TODO §1d). The validator extracts repo-doc
paths the builder claims to have touched, then diffs the target worktree to
flag any unverified claims. Findings are appended to review.md so they reach
the human; they don't fail the transition.

Public surface:
    NONE_NEEDED                       sentinel returned by extract() when the
                                      section explicitly opts out
    extract(build_md_text) -> list | NONE_NEEDED
                                      list of repo-relative claimed paths, OR
                                      the sentinel if the section reads
                                      "none needed — ..."
    verify(claimed, worktree_path, base_ref, *, base_ref_sha=None) -> list[str]
                                      returns the subset of claimed paths NOT
                                      present in the worktree's diff. Prefers
                                      ``base_ref_sha`` over the symbolic
                                      ``base_ref`` when provided.
"""
from __future__ import annotations

import pathlib
import re
import subprocess


NONE_NEEDED = object()


# Match the "## Documentation touched" section up to the next "## " heading
# or end-of-file. (?m) so ^ matches line starts; non-greedy on the body.
_SECTION_RE = re.compile(
    r"^##\s+Documentation\s+touched\s*$(?P<body>.*?)(?=^##\s|\Z)",
    re.IGNORECASE | re.MULTILINE | re.DOTALL,
)

_NONE_NEEDED_RE = re.compile(r"^\s*none\s+needed\b", re.IGNORECASE | re.MULTILINE)

# Bulleted line: "- <path> — <description>" or "- <path>: ..." etc.
# Treat the first whitespace-bounded token (or token followed by " —", " -", ":")
# as the path. Skip empty bullets and HTML comments.
_BULLET_RE = re.compile(r"^\s*-\s+(?P<path>\S+)", re.MULTILINE)


def extract(build_md_text: str):
    """Return [paths] or NONE_NEEDED or [] (section absent / empty)."""
    m = _SECTION_RE.search(build_md_text)
    if not m:
        return []
    body = m.group("body")
    # Strip HTML comments so we don't pick up template hints.
    body = re.sub(r"<!--.*?-->", "", body, flags=re.DOTALL)
    if _NONE_NEEDED_RE.search(body):
        return NONE_NEEDED
    paths: list[str] = []
    for bm in _BULLET_RE.finditer(body):
        p = bm.group("path").strip().rstrip(":,;")
        if p and not p.startswith("<") and not p.startswith("("):
            paths.append(p)
    return paths


def verify(
    claimed: list[str],
    worktree_path: pathlib.Path | str,
    base_ref: str,
    *,
    base_ref_sha: str | None = None,
) -> list[str]:
    """Return the subset of `claimed` paths NOT changed in the worktree.

    Runs `git diff --name-only <effective_ref>...HEAD` in the worktree, where
    ``effective_ref`` is the resolved SHA when present, otherwise the symbolic
    ``base_ref``. If git fails (no such ref, not a repo) we treat the
    verification as inconclusive and return an empty list — the reviewer still
    sees the claim in build.md.
    """
    if not claimed:
        return []
    effective_ref = base_ref_sha or base_ref
    try:
        proc = subprocess.run(
            ["git", "-C", str(worktree_path), "diff", "--name-only", f"{effective_ref}...HEAD"],
            capture_output=True, text=True, check=False,
        )
    except FileNotFoundError:
        return []
    if proc.returncode != 0:
        return []
    changed = {ln.strip() for ln in proc.stdout.splitlines() if ln.strip()}
    return [p for p in claimed if p not in changed]
