"""Stop banner for agent-stopping transitions.

Prints a bordered ``STOP.`` banner to stdout when the CLI lands a run in a
state the agent does not drive: ``ready``, ``human_review``, ``done``, or
``abandoned``. The banner is the last thing the command writes so it lands
in the agent's most recent tool output. See ``docs/TODO.md`` §2.

Single public function:
    print_stop_banner(landing_state, run_id, cfg=None) -> None

When ``landing_state == "human_review"`` and ``cfg`` is supplied, the body
renders the five-section structured layout (Review / Summary of changes /
Summary of testing / Diffstat / Next moves) sourced from the run's
HUMAN_REVIEW.md, QA report, ``QACompleted`` event, and a ``git diff
--shortstat`` inside the worktree. With no ``cfg``, the body falls back to
the three slash-form ``Next moves`` lines only (used by unit tests).
"""
from __future__ import annotations

import pathlib
import re
import subprocess
from typing import NamedTuple


BORDER = "=" * 60

SUMMARY_BULLET_CAP = 3
BULLET_COLUMN_CAP = 100


class _BannerSpec(NamedTuple):
    header: str  # second-line annotation after "STOP. State: <state>"
    explanation: str
    next_moves: tuple[tuple[str, str], ...]  # (command, description) pairs
    terminal_line: str  # used in place of next_moves when next_moves is empty


_HUMAN_REVIEW_NEXT_MOVES: tuple[tuple[str, str], ...] = (
    ("complete", "accept; auto-merges worktree branch into parent"),
    ("bounce", "send back to building with structured feedback"),
    ("abandon", "discard the run"),
)


_SPECS: dict[str, _BannerSpec] = {
    "ready": _BannerSpec(
        header="human-owned",
        explanation="The plan is staged and waiting for human approval.",
        next_moves=(
            ("start", "approve the plan and create the worktree"),
        ),
        terminal_line="",
    ),
    "human_review": _BannerSpec(
        header="human-owned",
        explanation="The run is staged for human review and decision.",
        # Slash-form decisions live in _HUMAN_REVIEW_NEXT_MOVES and are
        # rendered directly by the body builder; not used by the
        # _render_static_next_moves path.
        next_moves=(),
        terminal_line="",
    ),
    "done": _BannerSpec(
        header="terminal",
        explanation="The run is accepted and merged.",
        next_moves=(),
        terminal_line="Terminal state. No further action.",
    ),
    "abandoned": _BannerSpec(
        header="terminal",
        explanation="The run is abandoned.",
        next_moves=(),
        terminal_line="Terminal state. No further action.",
    ),
}


def render_stop_banner(landing_state: str, run_id: str, cfg=None) -> str:
    """Return the STOP banner text for ``landing_state`` (no trailing newline).

    Raises ``ValueError`` if ``landing_state`` is not one of the four
    agent-stopping states.
    """
    spec = _SPECS.get(landing_state)
    if spec is None:
        raise ValueError(
            f"unknown landing_state {landing_state!r}; expected one of "
            f"{sorted(_SPECS)!r}"
        )

    lines = [
        BORDER,
        f"STOP. State: {landing_state} ({spec.header}).",
        spec.explanation,
        "",
    ]

    if landing_state == "human_review":
        lines.extend(_build_human_review_body(cfg, run_id))
    elif spec.next_moves:
        lines.append("Next moves (human-triggered, type in a session):")
        pad = max(len(f"/{cmd} {run_id}") for cmd, _ in spec.next_moves)
        for cmd, desc in spec.next_moves:
            cmd_text = f"/{cmd} {run_id}"
            lines.append(f"  {cmd_text:<{pad}}  — {desc}")
    else:
        lines.append(spec.terminal_line)

    lines.append(BORDER)
    return "\n".join(lines)


def print_stop_banner(
    landing_state: str,
    run_id: str,
    cfg=None,
    write_to: pathlib.Path | None = None,
) -> None:
    """Print the STOP banner for ``landing_state`` to stdout.

    When ``write_to`` is supplied, also persist the rendered banner to that
    path (creating parent dirs as needed). The on-disk copy gives the
    slash-command layer a durable artifact to point at, instead of relying
    on Claude to relay stdout verbatim.

    Raises ``ValueError`` if ``landing_state`` is not one of the four
    agent-stopping states.
    """
    text = render_stop_banner(landing_state, run_id, cfg=cfg)
    print(text)
    if write_to is not None:
        try:
            write_to.parent.mkdir(parents=True, exist_ok=True)
            write_to.write_text(text + "\n")
        except OSError:
            # Convenience artifact — never block the transition on a write
            # failure. Mirrors cmd_validate's swallow-on-exception pattern
            # for stage-entry context files.
            pass


# ---------- human_review body builder ----------


def _build_human_review_body(cfg, run_id: str) -> list[str]:
    """Build the body lines for a ``human_review`` landing banner.

    With ``cfg`` supplied, renders the five-section body (Review, Summary of
    changes, Summary of testing, Diffstat, Next moves). With no ``cfg`` (the
    unit-test ergonomic), renders only the Next moves slash-form lines.
    """
    if cfg is None:
        return _render_next_moves_slash_form(run_id)

    # Import inside the function so the no-cfg path stays import-light and
    # this module is safe to import in test contexts that don't have a real
    # workbench root.
    from lib import metadata as metadata_mod, events as events_mod

    try:
        meta = metadata_mod.load(cfg, run_id)
    except Exception:
        meta = {}
    try:
        rd = metadata_mod.run_dir(cfg, run_id)
    except Exception:
        # Without a resolvable run dir we can't build the full body. Fall
        # back to the minimal next-moves shape rather than crash.
        return _render_next_moves_slash_form(run_id)

    body: list[str] = []

    # --- Review ---
    human_review_path = (rd / "HUMAN_REVIEW.md").resolve()
    body.append("Review:")
    # Clickable URL on its own line, no indentation, so terminal emulators
    # that auto-link `file://` schemes pick it up without wrapping.
    body.append(f"file://{human_review_path}")
    body.append("")

    # --- Summary of changes ---
    body.append("Summary of changes (≤3 bullets):")
    body.extend(_render_summary_bullets(human_review_path))
    body.append("")

    # --- Summary of testing ---
    body.append('Summary of testing (≤2 sentences, or "None recorded."):')
    try:
        events_list = list(events_mod.iter_events(cfg, run_id))
    except Exception:
        events_list = []
    body.append("  " + _render_testing_line(events_list, rd))
    body.append("")

    # --- Diffstat ---
    body.append("Diffstat:")
    body.append("  " + _render_diffstat(meta))
    body.append("")

    # --- Next moves ---
    body.extend(_render_next_moves_slash_form(run_id))

    return body


def _render_next_moves_slash_form(run_id: str) -> list[str]:
    """Three slash-form decision lines + their header."""
    lines = ["Next moves (human-triggered, type in a session):"]
    # Pad the command column so descriptions align nicely.
    pad = max(len(f"/{cmd} {run_id}") for cmd, _ in _HUMAN_REVIEW_NEXT_MOVES)
    for cmd, desc in _HUMAN_REVIEW_NEXT_MOVES:
        cmd_text = f"/{cmd} {run_id}"
        lines.append(f"  {cmd_text:<{pad}}  — {desc}")
    return lines


# ---------- Summary of changes extraction ----------


def _render_summary_bullets(human_review_path: pathlib.Path) -> list[str]:
    """Render the ``Summary of changes`` body lines from HUMAN_REVIEW.md.

    Pulls top-level ``- `` bullets (column-0 lines starting with ``- ``)
    from the ``## Summary of changes`` section. Drops nested ``  -`` rows
    and the trailing ``→ Full diff:`` pointer. Caps at SUMMARY_BULLET_CAP
    bullets with a ``…(N more in HUMAN_REVIEW.md)`` tail; truncates each
    bullet at BULLET_COLUMN_CAP columns with a ``…`` suffix.
    """
    if not human_review_path.exists():
        return ["  (none recorded)"]

    text = human_review_path.read_text()
    section = _extract_section(text, "Summary of changes")
    if not section:
        return ["  (none recorded)"]

    bullets: list[str] = []
    for raw in section.splitlines():
        # Top-level bullets only — no leading whitespace before the dash.
        if not raw.startswith("- "):
            continue
        item = raw[2:].strip()
        if not item:
            continue
        bullets.append(_truncate_inline(item, BULLET_COLUMN_CAP))

    if not bullets:
        return ["  (none recorded)"]

    shown = bullets[:SUMMARY_BULLET_CAP]
    out = [f"  - {b}" for b in shown]
    if len(bullets) > SUMMARY_BULLET_CAP:
        more = len(bullets) - SUMMARY_BULLET_CAP
        out.append(f"  …({more} more in HUMAN_REVIEW.md)")
    return out


def _extract_section(text: str, heading: str) -> str:
    """Return the body under ``## {heading}`` up to the next ``## `` heading.

    Returns the empty string if the heading isn't found. HTML comments are
    stripped so unfilled template hints don't get parsed as real content.
    Mirrors ``lib/human_review.py``'s ``_section`` helper.
    """
    pat = re.compile(rf"(?ms)^##\s+{re.escape(heading)}\s*\n(.*?)(?=^##\s|\Z)")
    m = pat.search(text)
    if not m:
        return ""
    body = m.group(1)
    body = re.sub(r"<!--.*?-->", "", body, flags=re.DOTALL)
    return body


def _truncate_inline(s: str, limit: int) -> str:
    """Single-line truncate ``s`` at ``limit`` columns with a ``…`` suffix."""
    s = s.replace("\n", " ").strip()
    if len(s) <= limit:
        return s
    return s[: limit - 1] + "…"


# ---------- Summary of testing ----------


def _render_testing_line(events_list: list[dict], rd: pathlib.Path) -> str:
    """One-line testing summary (1-2 sentences) or the literal ``None recorded.``"""
    qa_ev = _latest_event(events_list, "QACompleted")
    if qa_ev is None:
        return "None recorded."

    payload = qa_ev.get("payload") or {}
    tests_passed = payload.get("tests_passed")
    known = payload.get("known_issues_count")
    if not isinstance(known, int):
        known = 0

    if tests_passed is True and known == 0:
        first = "Unit tests passed; no known issues."
    elif tests_passed is True:
        first = f"Unit tests passed ({known} known issue(s))."
    elif tests_passed is False:
        first = "Unit tests failed (see HUMAN_REVIEW.md)."
    else:
        first = "Test outcome unrecorded."

    # Detect a recorded dogfood/manual run by reading the QA report's
    # `## Manual testing` section.
    qa_report = _resolve_qa_report_path(rd)
    if qa_report is not None and _manual_testing_recorded(qa_report):
        return f"{first} A dogfood/manual run was recorded."
    return first


def _latest_event(events_list: list[dict], event_type: str) -> dict | None:
    """Return the most-recent event of the given type, or None."""
    for ev in reversed(events_list):
        if ev.get("type") == event_type:
            return ev
    return None


def _resolve_qa_report_path(rd: pathlib.Path) -> pathlib.Path | None:
    """Return the QA report path for staged or flat runs, or None."""
    staged = rd / "stages" / "5_validating" / "qa" / "report.md"
    if staged.exists():
        return staged
    flat = rd / "qa" / "report.md"
    if flat.exists():
        return flat
    return None


_MANUAL_PLACEHOLDERS = frozenset({
    "_none._", "_none recorded._", "none.", "none recorded.", "",
})


def _manual_testing_recorded(qa_report_path: pathlib.Path) -> bool:
    """True if qa/report.md has a non-placeholder ``## Manual testing`` body."""
    try:
        body = _extract_section(qa_report_path.read_text(), "Manual testing").strip()
    except OSError:
        return False
    if not body:
        return False
    return body.lower() not in _MANUAL_PLACEHOLDERS


# ---------- Diffstat ----------


_SHORTSTAT_FILES = re.compile(r"(\d+)\s+files?\s+changed")
_SHORTSTAT_INSERT = re.compile(r"(\d+)\s+insertions?\(\+\)")
_SHORTSTAT_DELETE = re.compile(r"(\d+)\s+deletions?\(-\)")


def _render_diffstat(meta: dict) -> str:
    """Return ``N files changed, +X / −Y lines`` or the unavailable fallback."""
    target = meta.get("target") or {}
    repo = target.get("repo") or {}
    worktree = target.get("worktree") or {}

    worktree_path = worktree.get("path")
    base_ref = repo.get("base_ref")
    base_ref_sha = repo.get("base_ref_sha")

    if not worktree_path or not base_ref:
        return "unavailable (base_ref unresolved)."

    ref = _resolve_effective_ref(worktree_path, base_ref, base_ref_sha)
    if ref is None:
        return "unavailable (base_ref unresolved)."

    try:
        proc = subprocess.run(
            ["git", "-C", str(worktree_path), "diff", "--shortstat", f"{ref}..HEAD"],
            capture_output=True, text=True, check=False,
        )
    except FileNotFoundError:
        return "unavailable (base_ref unresolved)."
    if proc.returncode != 0:
        return "unavailable (base_ref unresolved)."

    raw = proc.stdout.strip()
    if not raw:
        # Resolvable base ref, no diff — distinguished from the unavailable case.
        return "0 files changed, +0 / −0 lines"

    files_m = _SHORTSTAT_FILES.search(raw)
    insert_m = _SHORTSTAT_INSERT.search(raw)
    delete_m = _SHORTSTAT_DELETE.search(raw)
    files = int(files_m.group(1)) if files_m else 0
    insertions = int(insert_m.group(1)) if insert_m else 0
    deletions = int(delete_m.group(1)) if delete_m else 0
    return f"{files} files changed, +{insertions} / −{deletions} lines"


def _resolve_effective_ref(
    worktree_path: str, base_ref: str, base_ref_sha: str | None,
) -> str | None:
    """Prefer ``base_ref_sha``; else resolve ``base_ref`` via ``git rev-parse``.

    Returns ``None`` if neither resolves (i.e. unavailable fallback applies).
    Mirrors ``lib/metrics/lines.py:_effective_ref``, but returns ``None`` for
    the unresolved case rather than the symbolic name — the banner needs to
    distinguish ``resolved-but-empty`` from ``unresolved``.
    """
    if base_ref_sha:
        return base_ref_sha
    try:
        proc = subprocess.run(
            ["git", "-C", str(worktree_path), "rev-parse", "--verify", base_ref],
            capture_output=True, text=True, check=False,
        )
    except FileNotFoundError:
        return None
    if proc.returncode == 0:
        sha = proc.stdout.strip()
        if sha:
            return sha
    return None
