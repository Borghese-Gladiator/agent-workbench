"""Render runs/<run_id>/HUMAN_REVIEW.md from metadata + events + artifacts.

This module replaces LLM-authored HUMAN_REVIEW.md content with a code-derived
projection of the run's events and artifacts. Called from cmd_followups right
before the followups -> human_review transition fires.

Public surface:

    render(cfg, run_id) -> pathlib.Path
        Write HUMAN_REVIEW.md at the run root. Idempotent: re-running
        overwrites the file. Returns the path written.

    project_timeline(events, ...) -> list[TimelineRow]
        Pure function: given an iterable of events, return the rows that the
        ## Run timeline section should contain. Exposed for unit testing.

    FILE_TABLE_CANDIDATES
        Ordered list of (label, relpath) tuples the ## Files table iterates
        over. Only rows whose relpath exists on disk are rendered.

Required headings written:
    ## Files
    ## Summary of changes
    ## Manual testing performed
    ## Run timeline

These are exactly the headings that lib.lifecycle.REQUIRED_HUMAN_REVIEW_HEADINGS
gates on.
"""
from __future__ import annotations

import dataclasses
import pathlib
import re
from typing import Iterable

from lib import events as events_mod, metadata as metadata_mod
from lib.config import Config
from lib.metadata import run_dir


# ---------- Files-table catalogue ----------

# Each entry: (label, relpath_from_run_root). Order is render order.
# Only entries whose relpath exists are rendered.
FILE_TABLE_CANDIDATES: tuple[tuple[str, str], ...] = (
    ("Brief", "stages/2_shaping/brief.md"),
    ("Plan", "stages/3_planning/plan.md"),
    ("Build (diffs + AC coverage)", "stages/4_building/build.md"),
    ("QA report", "stages/5_validating/qa/report.md"),
    ("Review decision", "stages/5_validating/review.md"),
    ("Follow-ups", "stages/6_followups/follow-ups.md"),
    ("Audit", "audit.md"),
)


# ---------- timeline projection ----------

# Descriptions that are too templated to surface on their own. A row whose
# description matches one of these literals (after specific-field projection)
# is dropped. The denylist exists to enforce AC4.
TIMELINE_DENYLIST: frozenset[str] = frozenset({
    "template staged",
    "draft created",
    "brief transcribed",
    "plan written",
})


@dataclasses.dataclass(frozen=True)
class TimelineRow:
    at_hhmmss: str
    stage: str
    description: str

    def render(self) -> str:
        return f"[{self.at_hhmmss}] {self.stage} — {self.description}"


def _hhmmss(iso_at: str) -> str:
    """Extract HH:MM:SS from an ISO timestamp like '2026-05-22T05:38:49-04:00'.

    Falls back to the input if the format doesn't match (no error)."""
    m = re.search(r"T(\d{2}:\d{2}:\d{2})", iso_at)
    return m.group(1) if m else iso_at


def _short(s: str | None, limit: int = 160) -> str:
    if not s:
        return ""
    s = s.strip().replace("\n", " ")
    return s if len(s) <= limit else s[: limit - 1] + "…"


def _describe(event: dict) -> str | None:
    """Project one event into a one-line description, or None if the event is
    not interesting enough to surface in the timeline."""
    et = event.get("type") or ""
    payload = event.get("payload") or {}

    if et == "TransitionApplied":
        # Use destination stage as the row's stage; describe what closed.
        to_state = (event.get("to") or "").lower()
        from_state = (event.get("from") or "").lower()
        if to_state == "abandoned":
            reason = payload.get("evidence", {}).get("abandoned_reason") or "abandoned"
            return f"abandoned — {_short(reason)}"
        if to_state == "done":
            ev = payload.get("evidence") or {}
            ref = ev.get("completion_ref") or ev.get("accepted_by") or "accepted"
            return f"accepted — {_short(ref)}"
        if to_state == "human_review":
            return "handed off"
        if to_state == "building" and from_state == "human_review":
            reason = (
                payload.get("evidence", {}).get("bounce_reason")
                or payload.get("notes")
                or "changes requested"
            )
            return f"bounced — {_short(reason)}"
        if to_state == "building" and from_state == "ready":
            ev = payload.get("evidence") or {}
            wt = ev.get("worktree_path")
            branch = ev.get("branch_name")
            if wt and branch:
                return f"worktree at `{wt}` on `{branch}`"
            return "worktree created"
        # Default: terse "entered <state>".
        return f"entered {to_state}" if to_state else None

    if et == "ArtifactWritten":
        summary = (payload.get("summary") or "").strip()
        artifact = payload.get("artifact_key") or ""
        # Drop template-staged rows; they're not the real story.
        if summary.lower() == "template staged":
            return None
        if summary:
            label = artifact or pathlib.Path(payload.get("path") or "").name
            return f"{label}.md written: {_short(summary)}" if label else _short(summary)
        return None

    if et == "AssumptionRecorded":
        aid = payload.get("assumption_id") or "?"
        return f"assumption {aid}: {_short(payload.get('text'))}"

    if et == "DecisionRecorded":
        did = payload.get("decision_id") or "?"
        return f"decision {did}: {_short(payload.get('decision'))}"

    if et == "WorktreeCreated":
        branch = payload.get("branch_name")
        wt = payload.get("worktree_path")
        if branch and wt:
            return f"worktree on `{branch}` at `{wt}`"
        return "worktree created"

    if et == "ReviewCompleted":
        d = (payload.get("review_decision") or "").lower()
        return f"review decision: {d or 'unknown'}"

    if et == "QACompleted":
        tp = payload.get("tests_passed")
        ki = payload.get("known_issues_count") or 0
        verdict = "tests_passed=true" if tp else ("tests_passed=false" if tp is False else "tests result unrecorded")
        return f"{verdict}; known_issues={ki}"

    if et == "FollowupsRecorded":
        n = payload.get("entry_count") or 0
        cats = ", ".join(payload.get("categories") or []) or "none"
        return f"{n} follow-up(s) recorded ({cats})"

    if et == "BounceRequested":
        reason = payload.get("bounce_reason") or "no reason given"
        return f"bounce requested — {_short(reason)}"

    if et == "HumanHandoffCreated":
        return "handoff record created"

    if et == "ScopeCreepChecked":
        creep = payload.get("creep") or []
        return f"scope creep: {len(creep)} unexpected file(s)" if creep else "scope creep: none"

    if et == "DocClaimsVerified":
        unverified = payload.get("unverified") or []
        return f"doc claims: {len(unverified)} unverified" if unverified else "doc claims: all verified"

    return None


def project_timeline(events: Iterable[dict]) -> list[TimelineRow]:
    """Project an iterable of events into the rows of the Run timeline section."""
    rows: list[TimelineRow] = []
    for ev in events:
        desc = _describe(ev)
        if not desc:
            continue
        if desc.strip().lower() in TIMELINE_DENYLIST:
            continue
        stage = (ev.get("status") or ev.get("to") or "").upper()
        rows.append(TimelineRow(_hhmmss(ev.get("at") or ""), stage, desc))
    return rows


# ---------- build.md extraction ----------

SUMMARY_INLINE_CAP = 8


def _extract_build_summary(build_path: pathlib.Path) -> list[str]:
    r"""Return markdown lines describing what the build delivered.

    Each list-item is a single top-level ``- ...`` bullet. A list of files
    (e.g. ``## Files changed``, ``## Documentation touched``) renders as one
    bullet with the file names joined inline, e.g.
    ``- 5 file(s) touched: a.py, b.py, c.py, d.py, e.py``. When the count
    exceeds ``SUMMARY_INLINE_CAP``, the bullet appends `` (…+N more)``.

    Falls back to an empty list if the file is missing or has none of the
    expected headers; the caller renders a single "→ Full diff" line in that
    case.
    """
    if not build_path.exists():
        return []
    text = build_path.read_text()
    lines: list[str] = []

    impl = _section(text, "What changed")
    if impl:
        # First paragraph only, single line.
        first_para = impl.strip().split("\n\n", 1)[0].strip().replace("\n", " ")
        if first_para:
            lines.append(f"- {_short(first_para, limit=240)}")

    files = _section(text, "Files changed")
    if files:
        items = _bullet_items(files)
        if items:
            lines.append(f"- {len(items)} file(s) touched: {_inline_path_list(items)}")

    coverage = _section(text, "Acceptance criteria coverage")
    if coverage:
        # Match `| AC-<id> |` data rows; header (`| AC | …`) and separator
        # (`|----|…`) rows fail this pattern and are skipped.
        row_pat = re.compile(r"^\|\s*AC[-\s]\S+\s*\|", re.IGNORECASE)
        covered = 0
        total = 0
        for ln in coverage.splitlines():
            ln = ln.strip()
            if not row_pat.match(ln):
                continue
            total += 1
            if "covered" in ln.lower():
                covered += 1
        if total:
            lines.append(f"- AC coverage: {covered}/{total} covered")

    docs = _section(text, "Documentation touched")
    if docs:
        items = _bullet_items(docs)
        if items and not all(i.strip().lower().startswith("(none") for i in items):
            lines.append(f"- {len(items)} doc(s) touched: {_inline_path_list(items)}")

    return lines


def _inline_path_list(items: list[str]) -> str:
    r"""Render a list of paths as a comma-joined inline string, capped at
    ``SUMMARY_INLINE_CAP`` items with a `` (…+N more)`` overflow suffix."""
    shown = items[:SUMMARY_INLINE_CAP]
    joined = ", ".join(shown)
    if len(items) > SUMMARY_INLINE_CAP:
        joined += f" (…+{len(items) - SUMMARY_INLINE_CAP} more)"
    return joined


def _section(text: str, heading: str) -> str:
    """Return the body under `## {heading}` up to the next `## ` heading.

    Returns the empty string if the heading isn't found. HTML comments are
    stripped so unfilled template hints don't get parsed as real content.
    """
    pat = re.compile(rf"(?ms)^##\s+{re.escape(heading)}\s*\n(.*?)(?=^##\s|\Z)")
    m = pat.search(text)
    if not m:
        return ""
    body = m.group(1)
    body = re.sub(r"<!--.*?-->", "", body, flags=re.DOTALL)
    return body


def _bullet_items(section_text: str) -> list[str]:
    items: list[str] = []
    for ln in section_text.splitlines():
        s = ln.strip()
        if not s.startswith("- "):
            continue
        item = s[2:].strip()
        # Strip surrounding backticks if the bullet uses code form.
        if item.startswith("`") and item.endswith("`"):
            item = item[1:-1]
        if item:
            items.append(item)
    return items


# ---------- Manual testing / QA extraction ----------

def _latest_event(events: list[dict], event_type: str) -> dict | None:
    """Return the most-recent event of the given type, or None."""
    for ev in reversed(events):
        if ev.get("type") == event_type:
            return ev
    return None


QA_INLINE_MAX_LINES = 30
DEFAULT_QA_COMMAND = "python -m pytest tests/ -q"


def _testing_block(
    events: list[dict],
    qa_path: pathlib.Path,
    commands_path: pathlib.Path,
) -> list[str]:
    """Render the body of the ## Testing section.

    Two sub-sections, each bolded as **<Name>**:

      **Unit tests** — command + fenced report excerpt + one-line verdict.
        The excerpt comes from qa/report.md's `## Summary` or `## Results`
        section (preferred), falling back to the whole file minus its title.

      **Manual testing** — body of qa/report.md's `## Manual testing`
        section verbatim. If that section is missing or empty, the body is
        `_None recorded._` so the reviewer sees explicitly that nothing was
        driven by hand.

    A review-decision line and a trailing absolute path follow both
    sub-sections.
    """
    qa_ev = _latest_event(events, "QACompleted")
    review_ev = _latest_event(events, "ReviewCompleted")

    lines: list[str] = []

    # --- Unit tests sub-section ---
    lines.append("**Unit tests**")
    lines.append("")
    cmd = _read_command(commands_path) or DEFAULT_QA_COMMAND
    lines.append(f"`{cmd}`")
    lines.append("")
    report_body = _read_report_body(qa_path)
    if report_body:
        lines.append("```")
        for ln in _truncate(report_body, QA_INLINE_MAX_LINES):
            lines.append(ln)
        lines.append("```")
    else:
        lines.append("_(no qa/report.md recorded)_")
    lines.append("")
    # Verdict line.
    if qa_ev:
        payload = qa_ev.get("payload") or {}
        tests_passed = payload.get("tests_passed")
        known = payload.get("known_issues_count") or 0
        if tests_passed is True and known == 0:
            interp = "✓ all green — 0 known issues."
        elif tests_passed is True:
            interp = f"✓ tests passed — ⚠ {known} known issue(s); see report."
        elif tests_passed is False:
            interp = f"✕ tests failed — {known} known issue(s); see report."
        else:
            interp = "_Outcome unrecorded._"
        lines.append(interp)
    else:
        lines.append("_Pending: no QACompleted event recorded yet._")

    lines.append("")

    # --- Manual testing sub-section ---
    lines.append("**Manual testing**")
    lines.append("")
    manual_body = _read_manual_testing(qa_path)
    if manual_body:
        # Render the body verbatim. If it already contains fenced blocks or
        # bullets, those carry through as-is.
        lines.append(manual_body)
    else:
        lines.append("_None recorded._")
    lines.append("")

    # Decision + deep-dive pointer.
    if review_ev:
        d = ((review_ev.get("payload") or {}).get("review_decision") or "").lower() or "unknown"
        lines.append(f"Review decision: **{d}**.")

    if qa_path.exists():
        lines.append("")
        lines.append("Full QA report:")
        lines.append("")
        lines.append(f"`{qa_path}`")

    return lines


def _read_manual_testing(qa_path: pathlib.Path) -> str:
    """Return the body of qa/report.md's `## Manual testing` section, or empty
    string if the section is missing or contains only whitespace / a `_None_`
    placeholder."""
    if not qa_path.exists():
        return ""
    body = _section(qa_path.read_text(), "Manual testing")
    body = body.strip() if body else ""
    if not body:
        return ""
    # Treat explicit "no manual testing" placeholders as empty.
    stripped = body.strip().lower()
    if stripped in ("_none._", "_none recorded._", "none.", "none recorded."):
        return ""
    return body


def _read_command(commands_path: pathlib.Path) -> str | None:
    if not commands_path.exists():
        return None
    text = commands_path.read_text().strip()
    if not text:
        return None
    # If multiple commands were logged, pick the first non-comment line.
    for ln in text.splitlines():
        s = ln.strip()
        if s and not s.startswith("#"):
            return s
    return None


def _read_report_body(qa_path: pathlib.Path) -> str:
    """Return the inline-able content of qa/report.md.

    If the report has a `## Summary` or `## Results` heading, prefer its body
    (skipping any boilerplate above). Otherwise return the whole file minus
    its leading `# Title` line.
    """
    if not qa_path.exists():
        return ""
    text = qa_path.read_text().strip()
    if not text:
        return ""
    for heading in ("Summary", "Results"):
        body = _section(text, heading)
        if body and body.strip():
            return body.strip()
    # Strip a leading `# Title` line; keep the rest as-is.
    lines = text.splitlines()
    if lines and lines[0].lstrip().startswith("# "):
        lines = lines[1:]
    return "\n".join(lines).strip()


def _truncate(text: str, max_lines: int) -> list[str]:
    lines = text.splitlines()
    if len(lines) <= max_lines:
        return lines
    return lines[: max_lines - 1] + ["…"]


# ---------- main render ----------

def render(cfg: Config, run_id: str) -> pathlib.Path:
    """Write HUMAN_REVIEW.md at the run root. Returns the path written."""
    meta = metadata_mod.load(cfg, run_id)
    rd = run_dir(cfg, run_id)
    out_path = rd / "HUMAN_REVIEW.md"

    events_list = list(events_mod.iter_events(cfg, run_id))

    # Header.
    title_summary = (meta.get("scope") or {}).get("summary") or run_id
    lines: list[str] = [f"# Human review — {run_id}", ""]

    # ## Files — one-line-per-artifact list. The link text is the bare file
    # name (e.g. `brief.md`); the link target is the absolute path so a reader
    # can click through. The self-reference row is omitted.
    lines.append("## Files")
    lines.append("")
    for label, relpath in FILE_TABLE_CANDIDATES:
        abspath = rd / relpath
        if not abspath.exists():
            continue
        lines.append(f"- **{label}** — [{abspath.name}]({abspath})")
    lines.append("")

    # ## Summary of changes — pre-formatted markdown lines from the extractor.
    lines.append("## Summary of changes")
    lines.append("")
    if (meta.get("build") or {}).get("template_fallback_fired"):
        lines.append(
            "- ⚠ **Template fallback fired** — the builder produced no "
            "build.md; the staged content below is from the template."
        )
        lines.append("")
    build_path = rd / "stages" / "4_building" / "build.md"
    summary_lines = _extract_build_summary(build_path)
    if summary_lines:
        lines.extend(summary_lines)
    else:
        lines.append("- _Build summary unavailable — see the full diff below._")
    lines.append("")
    if build_path.exists():
        lines.append(f"→ Full diff: `{build_path}`")
    else:
        lines.append("→ Full diff: _build.md not produced_")
    lines.append("")

    # ## Testing — Unit tests + Manual testing sub-sections, sourced from
    # qa/commands.txt and qa/report.md (including its `## Manual testing`
    # section when present).
    lines.append("## Testing")
    lines.append("")
    qa_path = rd / "stages" / "5_validating" / "qa" / "report.md"
    commands_path = rd / "stages" / "5_validating" / "qa" / "commands.txt"
    for ln in _testing_block(events_list, qa_path, commands_path):
        lines.append(ln)
    lines.append("")

    # ## Run timeline.
    lines.append("## Run timeline")
    lines.append("")
    rows = project_timeline(events_list)
    if rows:
        for row in rows:
            lines.append(f"- {row.render()}")
    else:
        lines.append("_No timeline events recorded._")
    lines.append("")

    # The scope summary (from raw idea) — append a small footer so reviewers
    # have one-line context without having to chase the brief.
    if title_summary and title_summary != run_id:
        lines.append("---")
        lines.append("")
        lines.append(f"_Scope:_ {title_summary}")
        lines.append("")

    out_path.write_text("\n".join(lines))
    return out_path
