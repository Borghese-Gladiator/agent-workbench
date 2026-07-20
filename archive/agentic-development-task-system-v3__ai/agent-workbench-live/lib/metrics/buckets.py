"""Input + cache bucket attribution.

Splits each turn's billable tokens into named buckets so a reader can see
where the cost is going. Three independent token streams:

  * ``input_tokens`` — the fresh request bytes the model sees this turn.
    Bucketed via ``raw_user_messages`` + ``raw_tool_results``.
  * ``cache_read_input_tokens`` — the *re-read* prefix billed every turn.
    Bucketed via the session-prefix accumulators on ``CorrelatedTurn``.
  * ``cache_creation_input_tokens`` — bytes written into the cache this turn
    (first time they enter the prefix). Same accumulators; scaled separately.

For each stream we estimate per-bucket character counts via a cheap heuristic
(``_CHARS_PER_TOKEN = 4.0``), then scale so the bucket totals sum to the
authoritative token count. Whatever the heuristic can't explain lands in
``other`` — honest under-attribution > confident mis-attribution.

The output is always a dict with every bucket key present (zero-valued if
absent). Keeps downstream summarization branchless.
"""
from __future__ import annotations

import dataclasses
import re
from typing import Iterable


BUCKET_NAMES = (
    "system_prompt",
    "tool_defs",
    "claude_md_and_agents_md",
    "context_imports",
    "slash_command_body",
    "user_messages",
    "assistant_history",
    "tool_results",
    "repo_files",
    "validation_context",
    "generated_drafts",
    "other",
)

# Roughly 4 chars per token for English + code. Good enough for proportional
# splitting; the scaling step (see ``_scale_to_total()``) lifts the total back
# to the transcript's authoritative number.
_CHARS_PER_TOKEN = 4.0

_CLAUDE_MD_RE = re.compile(
    r"Contents of /Users/[^/]+/(?:\.claude/CLAUDE\.md|.*?CLAUDE\.md|.*?AGENTS\.md)",
    re.IGNORECASE,
)
_CONTEXT_IMPORT_RE = re.compile(r"@context/[^\s]+|@AGENTS\.md|@CLAUDE\.md")
_COMMAND_BLOCK_RE = re.compile(r"<command-name>.*?</command-args>", re.DOTALL)
# Read-tool gutter pattern: ^\s*<digits>\t per line. Match a few rows so a
# stray "1\tfoo" inside narrative text doesn't trip the heuristic.
_READ_GUTTER_RE = re.compile(r"(?:^\s*\d+\t.*\n){3,}", re.MULTILINE)
_MARKDOWN_HEADER_RE = re.compile(r"^##\s+\S", re.MULTILINE)


@dataclasses.dataclass(frozen=True)
class BucketAttribution:
    """Per-stream bucket dicts. Sums to the turn's billable token counts."""

    input_buckets: dict
    cache_read_buckets: dict
    cache_creation_buckets: dict

    def to_dict(self) -> dict:
        return {
            "input_buckets": dict(self.input_buckets),
            "cache_read_buckets": dict(self.cache_read_buckets),
            "cache_creation_buckets": dict(self.cache_creation_buckets),
        }


def _classify_user_text(text: str) -> dict[str, int]:
    """Return per-bucket char counts for one user-role text body."""
    out = {k: 0 for k in BUCKET_NAMES}
    if not text:
        return out

    md_total = 0
    for m in _CLAUDE_MD_RE.finditer(text):
        start = m.start()
        rest = text[start:]
        nxt = re.search(r"\nContents of |\n# [a-z]", rest[1:])
        end = start + (nxt.start() + 1 if nxt else len(rest))
        chunk = text[start:end]
        md_total += len(chunk)
    out["claude_md_and_agents_md"] = md_total

    ci_total = 0
    for m in _CONTEXT_IMPORT_RE.finditer(text):
        ci_total += len(m.group(0))
    out["context_imports"] = ci_total

    cmd_total = 0
    for m in _COMMAND_BLOCK_RE.finditer(text):
        cmd_total += len(m.group(0))
    out["slash_command_body"] = cmd_total

    out["user_messages"] = max(0, len(text) - (md_total + ci_total + cmd_total))
    return out


def _classify_tool_result(text: str) -> dict[str, int]:
    """Tool results split into ``repo_files`` (Read-tool gutter pattern) and
    the generic ``tool_results`` catch-all."""
    out = {k: 0 for k in BUCKET_NAMES}
    if not text:
        return out
    repo_total = 0
    for m in _READ_GUTTER_RE.finditer(text):
        repo_total += len(m.group(0))
    out["repo_files"] = repo_total
    out["tool_results"] = max(0, len(text) - repo_total)
    return out


def _classify_assistant(text: str) -> dict[str, int]:
    """Assistant messages: ``generated_drafts`` for bodies with ``## ``
    headers (a proxy for review/build/handoff drafts), rest into
    ``assistant_history``."""
    out = {k: 0 for k in BUCKET_NAMES}
    if not text:
        return out
    if _MARKDOWN_HEADER_RE.search(text):
        out["generated_drafts"] = len(text)
    else:
        out["assistant_history"] = len(text)
    return out


def _classify_for_cache(
    prefix_user: tuple[str, ...],
    prefix_assistant: tuple[str, ...],
    prefix_tool: tuple[str, ...],
    in_validate_span: bool,
) -> dict[str, int]:
    """Walk a session prefix; return per-bucket char counts.

    ``in_validate_span``: when True, tool_results within the span are
    re-classified as ``validation_context``. Coarse but directionally correct
    for the visibility goal.
    """
    chars = {k: 0 for k in BUCKET_NAMES}
    for body in prefix_user:
        sub = _classify_user_text(body)
        for k, v in sub.items():
            chars[k] += v
    for body in prefix_tool:
        sub = _classify_tool_result(body)
        for k, v in sub.items():
            chars[k] += v
    if in_validate_span and chars["tool_results"]:
        chars["validation_context"] = chars["tool_results"]
        chars["tool_results"] = 0
    for body in prefix_assistant:
        sub = _classify_assistant(body)
        for k, v in sub.items():
            chars[k] += v
    return chars


def _scale_to_total(chars: dict[str, int], total: int) -> dict[str, int]:
    """Convert char counts to estimated tokens, then scale to ``total``."""
    if total <= 0:
        return {k: 0 for k in BUCKET_NAMES}
    measured_total = sum(chars[k] for k in BUCKET_NAMES)
    if measured_total <= 0:
        return {**{k: 0 for k in BUCKET_NAMES}, "other": total}

    est = {k: int(chars[k] / _CHARS_PER_TOKEN) for k in BUCKET_NAMES}
    est_total = sum(est.values())
    if est_total >= total:
        scale = total / est_total
        out = {k: int(round(est[k] * scale)) for k in BUCKET_NAMES}
        out["other"] = 0
        delta = total - sum(out.values())
        if delta != 0:
            largest = max(out, key=lambda k: out[k])
            out[largest] += delta
        return out

    other = total - est_total
    out = {k: est[k] for k in BUCKET_NAMES}
    out["other"] = max(0, other)
    return out


def attribute_input(turn) -> dict[str, int]:
    """Attribute one ``CorrelatedTurn``'s ``input_tokens`` into buckets."""
    total_input = int(turn.usage.get("input_tokens", 0) or 0)
    if total_input <= 0:
        return {k: 0 for k in BUCKET_NAMES}

    chars = {k: 0 for k in BUCKET_NAMES}
    for body in (turn.raw_user_messages or ()):
        sub = _classify_user_text(body)
        for k, v in sub.items():
            chars[k] += v
    for body in (turn.raw_tool_results or ()):
        sub = _classify_tool_result(body)
        for k, v in sub.items():
            chars[k] += v
    return _scale_to_total(chars, total_input)


def attribute_cache_read(turn) -> dict[str, int]:
    """Attribute ``cache_read_input_tokens`` against the session prefix."""
    total = int(turn.usage.get("cache_read_input_tokens", 0) or 0)
    if total <= 0:
        return {k: 0 for k in BUCKET_NAMES}
    in_validate = (turn.command or "") == "/validate"
    chars = _classify_for_cache(
        getattr(turn, "prefix_user_messages", ()) or (),
        getattr(turn, "prefix_assistant_messages", ()) or (),
        getattr(turn, "prefix_tool_results", ()) or (),
        in_validate,
    )
    return _scale_to_total(chars, total)


def attribute_cache_creation(turn) -> dict[str, int]:
    """Attribute ``cache_creation_input_tokens`` against the session prefix."""
    total = int(turn.usage.get("cache_creation_input_tokens", 0) or 0)
    if total <= 0:
        return {k: 0 for k in BUCKET_NAMES}
    in_validate = (turn.command or "") == "/validate"
    chars = _classify_for_cache(
        getattr(turn, "prefix_user_messages", ()) or (),
        getattr(turn, "prefix_assistant_messages", ()) or (),
        getattr(turn, "prefix_tool_results", ()) or (),
        in_validate,
    )
    return _scale_to_total(chars, total)


def attribute(turn) -> dict[str, int]:
    """Back-compat shim: returns the input-only bucket dict.

    Pre-existing callers (and v1 metrics.jsonl writers) expect a single dict
    matching the ``input_tokens`` total. New callers should use
    ``attribute_all()`` to get the cache buckets too.
    """
    return attribute_input(turn)


def attribute_all(turn) -> BucketAttribution:
    """Return all three bucket dicts for one turn."""
    return BucketAttribution(
        input_buckets=attribute_input(turn),
        cache_read_buckets=attribute_cache_read(turn),
        cache_creation_buckets=attribute_cache_creation(turn),
    )


def merge(per_turn: Iterable[dict[str, int]]) -> dict[str, int]:
    """Sum a sequence of bucket dicts into one aggregate."""
    out = {k: 0 for k in BUCKET_NAMES}
    for d in per_turn:
        for k in BUCKET_NAMES:
            out[k] += int(d.get(k, 0) or 0)
    return out
