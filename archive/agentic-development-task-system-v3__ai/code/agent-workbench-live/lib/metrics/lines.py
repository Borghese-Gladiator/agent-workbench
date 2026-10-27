"""Line-count capture.

``generated_lines`` = every ``+`` line the agent wrote during the run, across
every draft (including discarded attempts). We approximate this two ways:

  1. Sum of ``+`` lines from ``git log --numstat <branch>`` in the worktree,
     across every commit on the branch since ``base_ref`` (catches code
     changes including those that were later overwritten).
  2. Plus the line count of every ``ArtifactWritten`` payload's
     ``content_length_lines`` if present in ``events.jsonl`` (catches
     run-artifact authoring outside the worktree, e.g. ``stages/*/*.md``).

``accepted_lines`` = ``+`` lines from ``git diff --numstat <base_ref>...<sha>``
where ``sha`` is the merge SHA captured in ``meta.completion.completion_ref``
when it parses as a hex digest. If no merge SHA is recorded, returns
``(0, None)``.
"""
from __future__ import annotations

import json
import pathlib
import re
import subprocess


_HEX_RE = re.compile(r"^[0-9a-f]{7,40}$", re.IGNORECASE)


def count_generated(
    *,
    worktree_path: str | None,
    base_ref: str,
    events_path: pathlib.Path | None,
    base_ref_sha: str | None = None,
) -> int:
    """Total ``+`` lines authored during the run.

    Worktree contribution: sum of ``+`` lines per commit in
    ``git log --numstat <effective_ref>..HEAD``. (Note: this is the dotted
    form, ``base..HEAD``, so commits already in base are excluded.)

    ``effective_ref`` prefers ``base_ref_sha`` (captured at ``/start`` time).
    For runs that predate that field, we lazily resolve ``base_ref`` to a SHA
    via ``git rev-parse`` inside the worktree; if that fails, we fall back to
    the symbolic ``base_ref`` (today's behavior — no regression).

    Artifact contribution: if ``events_path`` is given, sum
    ``ArtifactWritten.payload.content_length_lines`` for events that carry
    it. (Optional — older events.jsonl may not include this field.)
    """
    total = 0
    if worktree_path:
        ref = _effective_ref(worktree_path, base_ref, base_ref_sha)
        total += _worktree_log_added(worktree_path, ref)
    if events_path and events_path.exists():
        total += _events_artifact_lines(events_path)
    return total


def _effective_ref(worktree_path: str, base_ref: str, base_ref_sha: str | None) -> str:
    """Prefer the resolved SHA; lazily resolve in the worktree; else symbolic."""
    if base_ref_sha:
        return base_ref_sha
    try:
        proc = subprocess.run(
            ["git", "-C", worktree_path, "rev-parse", "--verify", base_ref],
            capture_output=True, text=True, check=False,
        )
    except FileNotFoundError:
        return base_ref
    if proc.returncode == 0:
        sha = proc.stdout.strip()
        if sha:
            return sha
    return base_ref


def _worktree_log_added(worktree_path: str, base_ref: str) -> int:
    """Sum of `+` lines across all commits in <base_ref>..HEAD."""
    try:
        proc = subprocess.run(
            ["git", "-C", worktree_path, "log", "--numstat", "--format=", f"{base_ref}..HEAD"],
            capture_output=True, text=True, check=False,
        )
    except FileNotFoundError:
        return 0
    if proc.returncode != 0:
        return 0
    total = 0
    for ln in proc.stdout.splitlines():
        parts = ln.split("\t")
        if len(parts) != 3:
            continue
        added, _removed, _path = parts
        if added == "-":
            # Binary file; skip.
            continue
        try:
            total += int(added)
        except ValueError:
            continue
    return total


def _events_artifact_lines(events_path: pathlib.Path) -> int:
    total = 0
    with events_path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if ev.get("type") != "ArtifactWritten":
                continue
            payload = ev.get("payload") or {}
            n = payload.get("content_length_lines")
            if isinstance(n, int) and n > 0:
                total += n
    return total


def count_accepted(
    *,
    worktree_path: str | None,
    base_ref: str,
    completion_ref: str | None,
    base_ref_sha: str | None = None,
) -> tuple[int, str | None]:
    """Returns ``(accepted_lines, merge_sha_or_None)``.

    ``completion_ref`` is expected to be either a hex SHA, a string of the
    form ``"local-branch:<branch>"`` (no merge — accepted = 0), or any other
    free-form string. We look for a hex pattern; if found, we run
    ``git diff --numstat <effective_ref>...<sha>`` to get the merged ``+`` line
    count. Otherwise return ``(0, None)``.

    ``effective_ref`` follows the same prefer-SHA / lazy-resolve / fall-back
    logic as ``count_generated``; see ``_effective_ref``.
    """
    if not completion_ref or not worktree_path:
        return (0, None)
    sha = _extract_sha(completion_ref)
    if not sha:
        return (0, None)
    ref = _effective_ref(worktree_path, base_ref, base_ref_sha)
    try:
        proc = subprocess.run(
            ["git", "-C", worktree_path, "diff", "--numstat", f"{ref}...{sha}"],
            capture_output=True, text=True, check=False,
        )
    except FileNotFoundError:
        return (0, None)
    if proc.returncode != 0:
        return (0, sha)
    total = 0
    for ln in proc.stdout.splitlines():
        parts = ln.split("\t")
        if len(parts) != 3:
            continue
        added, _removed, _path = parts
        if added == "-":
            continue
        try:
            total += int(added)
        except ValueError:
            continue
    return (total, sha)


def _extract_sha(ref: str) -> str | None:
    """Pull a hex SHA out of a free-form completion_ref string."""
    if _HEX_RE.match(ref.strip()):
        return ref.strip()
    # ``merge:abc1234`` / ``commit:abc1234`` style.
    for sep in (":", " ", "@"):
        if sep in ref:
            tail = ref.rsplit(sep, 1)[1].strip()
            if _HEX_RE.match(tail):
                return tail
    # Otherwise nothing.
    return None
