"""Deterministic state-machine transitions with required evidence.

`lib.metadata.transition()` validates the `(from, to)` status pair plus the
investigation-only and terminal-state guards. That is enough to reject *bad
shapes*, but not enough to reject *unfounded* transitions: today a script
can flip a run from `qa` straight to `merged` with no evidence that tests
passed, no PR URL, no merge SHA.

This module adds the missing piece. Each documented edge in the lifecycle
declares the evidence keys that must be present (and non-empty) for the
transition to be valid. Callers pass an `evidence: dict[str, str]` along
with the new status; mismatched edges or missing keys raise `TransitionError`.

Design notes
------------
- Evidence is `dict[str, str]` (flat, scalar). That matches `metadata.yaml`'s
  shape and the event-log payload shape, so callers can serialize the same
  dict into both places.
- Empty strings count as missing. `metadata.yaml` represents "unset" as `""`,
  not as a missing key, so this rule keeps the two layers consistent.
- The `("*", "abandoned")` wildcard edge lets any non-terminal status
  transition to `abandoned` with a reason. It is encoded as a special-case
  lookup, not a literal tuple key.
- This module does NOT mutate `Metadata` directly. It returns the validated
  evidence dict; callers feed the resulting `(new_status, evidence)` pair to
  both `lib.metadata.transition()` (or `save()`) and `lib.events.append()`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from .metadata import (
    Metadata,
    MetadataError,
    TERMINAL_STATUSES,
    VALID_STATUSES,
    transition,
)


class TransitionError(ValueError):
    """Raised when an evidence-bearing transition is rejected."""


@dataclass(frozen=True)
class TransitionEvidence:
    """Required evidence keys for one transition edge.

    `keys` is a tuple of dict keys that must be present in the supplied
    evidence dict and have a non-empty value.
    """
    keys: tuple[str, ...]


# The wildcard sentinel for "any non-terminal `from` state". Used as the
# `from_state` key in `EVIDENCE` for the `abandoned` edge.
ANY_NON_TERMINAL = "*"


EVIDENCE: dict[tuple[str, str], TransitionEvidence] = {
    # Feature path (the canonical lifecycle from the README).
    ("draft", "normalize"):       TransitionEvidence(keys=()),
    ("normalize", "brainstorm"):  TransitionEvidence(keys=("normalized_spec_path",)),
    ("brainstorm", "ready"):      TransitionEvidence(keys=("approved_by",)),
    ("ready", "in_progress"):     TransitionEvidence(keys=("worktree_path", "branch_name")),
    ("in_progress", "in_review"): TransitionEvidence(keys=("pr_url",)),
    ("in_review", "qa"):          TransitionEvidence(keys=("review_decision",)),
    # Pre-PR review path: /review-run flips in_progress → qa before any PR
    # exists. Reviewer's verdict is the evidence.
    ("in_progress", "qa"):        TransitionEvidence(keys=("review_decision",)),
    # After a passing pre-PR review, open-pr.sh moves the run forward into
    # in_review. Same evidence as in_progress → in_review.
    ("qa", "in_review"):          TransitionEvidence(keys=("pr_url",)),
    ("qa", "merged"):             TransitionEvidence(keys=("tests_passed", "pr_url", "merge_sha")),
    # --skip-qa hotfix edges. complete-run.sh prints a loud warning when these
    # fire; the evidence requirements are identical to the canonical path so
    # the audit trail still records merge_sha + pr_url for retrospective
    # investigation.
    ("in_progress", "merged"):    TransitionEvidence(keys=("tests_passed", "pr_url", "merge_sha")),
    ("in_review", "merged"):      TransitionEvidence(keys=("tests_passed", "pr_url", "merge_sha")),

    # Legacy alias for `ready` while existing scripts migrate.
    ("draft", "planned"):         TransitionEvidence(keys=("spec_path",)),
    ("planned", "in_progress"):   TransitionEvidence(keys=("worktree_path", "branch_name")),

    # Direct draft → in_progress edge for runs that skip the front half.
    # This is the path create-worktree.sh has always taken when called on a
    # draft run; declaring it here lets the script use transition_with_evidence
    # without introducing a new shape. Deprecate once /normalize + /brainstorm
    # are the default entry into in_progress.
    ("draft", "in_progress"):     TransitionEvidence(keys=("worktree_path", "branch_name")),

    # Investigation branch.
    ("planned", "investigating"):       TransitionEvidence(keys=("worktree_path",)),
    ("investigating", "investigated"):  TransitionEvidence(keys=("wbs_children",)),
    ("investigated", "merged"):         TransitionEvidence(keys=("children_complete",)),

    # Review bounce-back: in_review → in_progress with a reason.
    ("in_review", "in_progress"): TransitionEvidence(keys=("bounce_reason",)),

    # Wildcard abandonment edge.
    (ANY_NON_TERMINAL, "abandoned"): TransitionEvidence(keys=("abandoned_reason",)),
}


def _lookup_evidence(from_state: str, to_state: str) -> TransitionEvidence:
    explicit = EVIDENCE.get((from_state, to_state))
    if explicit is not None:
        return explicit
    if to_state == "abandoned":
        # Wildcard edge applies from any non-terminal state.
        if from_state in TERMINAL_STATUSES:
            raise TransitionError(
                f"cannot abandon from terminal status {from_state!r}"
            )
        return EVIDENCE[(ANY_NON_TERMINAL, "abandoned")]
    raise TransitionError(
        f"no transition defined for {from_state!r} → {to_state!r}"
    )


def _validate_evidence(
    from_state: str,
    to_state: str,
    requirement: TransitionEvidence,
    evidence: dict,
) -> dict:
    """Check every required key is present and non-empty; return the trimmed dict."""
    if not isinstance(evidence, dict):
        raise TransitionError(
            f"{from_state!r} → {to_state!r}: evidence must be a dict, "
            f"got {type(evidence).__name__}"
        )
    missing: list[str] = []
    empty: list[str] = []
    for key in requirement.keys:
        if key not in evidence:
            missing.append(key)
            continue
        value = evidence[key]
        if value is None or (isinstance(value, str) and value.strip() == ""):
            empty.append(key)
    problems: list[str] = []
    if missing:
        problems.append(f"missing: {', '.join(sorted(missing))}")
    if empty:
        problems.append(f"empty: {', '.join(sorted(empty))}")
    if problems:
        raise TransitionError(
            f"{from_state!r} → {to_state!r} requires evidence — "
            + "; ".join(problems)
        )
    # Return a fresh dict containing only the documented keys, so callers
    # can serialize it directly without leaking unrelated fields.
    return {key: evidence[key] for key in requirement.keys}


def transition_with_evidence(
    md: Metadata,
    new_status: str,
    evidence: dict,
) -> tuple[Metadata, dict]:
    """Validate a transition and its evidence; return (new metadata, trimmed evidence).

    Raises:
      TransitionError — edge not defined, or evidence missing/empty.
      MetadataError    — propagated from `lib.metadata.transition` for status-pair
                         issues (terminal-state protection, run-type guard, etc.).
    """
    if new_status not in VALID_STATUSES:
        raise TransitionError(
            f"invalid target status {new_status!r}; must be one of: "
            f"{', '.join(VALID_STATUSES)}"
        )
    requirement = _lookup_evidence(md.status, new_status)
    trimmed = _validate_evidence(md.status, new_status, requirement, evidence)
    # Defer to lib.metadata for run-type / terminal-state guards. It raises
    # MetadataError; we let that surface unchanged so callers can distinguish
    # evidence problems (TransitionError) from shape problems (MetadataError).
    new_md = transition(md, new_status)
    return new_md, trimmed


def documented_edges() -> Iterable[tuple[str, str]]:
    """Return every documented (from, to) edge. Useful for validators and docs."""
    return tuple(EVIDENCE.keys())
