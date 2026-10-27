"""The transition engine.

Single-threaded by construction (per run, via lib/locks). Reads the static
schema from schemas/transitions.yaml. Every status change in the system must
go through transition(...).

Public surface:
    transition(cfg, run_id, to_state, evidence, actor) -> dict event
    is_terminal(state) -> bool
    is_non_terminal(state) -> bool
"""
from __future__ import annotations

import pathlib
from functools import lru_cache
from typing import Any

from lib import yaml_io, events as events_mod, metadata as metadata_mod, lifecycle
from lib.config import Config


class TransitionError(Exception):
    """Raised when a requested transition is invalid. Also emits TransitionRejected."""


@lru_cache(maxsize=1)
def _load_schema(schemas_path: pathlib.Path) -> dict:
    p = schemas_path / "transitions.yaml"
    if not p.exists():
        raise TransitionError(f"transitions schema not found: {p}")
    with open(p) as f:
        data = yaml_io.loads(f.read())
    if not isinstance(data, dict):
        raise TransitionError(f"{p}: top-level must be a mapping")
    return data


def _schema(cfg: Config) -> dict:
    return _load_schema(cfg.schemas_path)


def non_terminal_states(cfg: Config) -> set[str]:
    return set(_schema(cfg)["states"]["non_terminal"])


def terminal_states(cfg: Config) -> set[str]:
    return set(_schema(cfg)["states"]["terminal"])


def is_terminal(cfg: Config, state: str) -> bool:
    return state in terminal_states(cfg)


def is_non_terminal(cfg: Config, state: str) -> bool:
    return state in non_terminal_states(cfg)


def _find_rule(cfg: Config, from_state: str, to_state: str) -> dict | None:
    sch = _schema(cfg)
    for rule in sch.get("transitions", []) or []:
        if rule["from"] == from_state and rule["to"] == to_state:
            return rule
    for rule in sch.get("wildcard_transitions", []) or []:
        if rule["from"] == "any_non_terminal" and rule["to"] == to_state:
            if from_state in non_terminal_states(cfg):
                return rule
    return None


def _check_evidence(rule: dict, evidence: dict) -> list[str]:
    required = (rule.get("evidence") or {}).get("required", []) or []
    missing: list[str] = []
    for k in required:
        v = evidence.get(k)
        if v is None or (isinstance(v, str) and v.strip() == ""):
            missing.append(k)
    return missing


def transition(
    cfg: Config,
    run_id: str,
    to_state: str,
    evidence: dict,
    actor: dict,
    *,
    notes: str | None = None,
) -> dict:
    """Apply a transition. Returns the TransitionApplied event.

    On failure, attempts to emit TransitionRejected (best effort) and raises
    TransitionError.
    """
    meta = metadata_mod.load(cfg, run_id)
    from_state = meta["status"]

    sch = _schema(cfg)
    rules = sch.get("rules") or {}
    if rules.get("terminal_states_cannot_transition", True) and is_terminal(cfg, from_state):
        _try_emit_rejected(
            cfg, run_id, from_state, to_state, actor,
            reason=f"current state {from_state!r} is terminal",
        )
        raise TransitionError(f"cannot transition from terminal state {from_state!r}")

    rule = _find_rule(cfg, from_state, to_state)
    if rule is None:
        _try_emit_rejected(
            cfg, run_id, from_state, to_state, actor,
            reason=f"no rule for {from_state!r} -> {to_state!r}",
        )
        raise TransitionError(f"no transition rule for {from_state!r} -> {to_state!r}")

    missing = _check_evidence(rule, evidence)
    if missing:
        _try_emit_rejected(
            cfg, run_id, from_state, to_state, actor,
            reason="missing required evidence",
            missing_evidence=missing,
        )
        raise TransitionError(
            f"transition {from_state!r} -> {to_state!r} missing evidence: {missing}"
        )

    # Staged-layout pre-checks. The new HUMAN_REVIEW.md must carry the
    # required headings before we let followups -> human_review through.
    # (Pass 3 moved this gate from validating -> human_review; the direct
    # transition no longer exists.)
    if (
        lifecycle.is_staged_run(cfg, run_id)
        and from_state == "followups"
        and to_state == "human_review"
    ):
        section_errs = lifecycle.validate_human_review_sections(cfg, run_id)
        if section_errs:
            _try_emit_rejected(
                cfg, run_id, from_state, to_state, actor,
                reason="HUMAN_REVIEW.md is missing required sections",
                missing_evidence=section_errs,
            )
            raise TransitionError(
                "followups -> human_review rejected: " + "; ".join(section_errs)
            )

    # Apply the transition.
    metadata_mod.set_status(cfg, run_id, to_state)

    # Staged-layout move-on-transition: promote the just-produced stage's
    # outputs into stages/<stage>/, and rewrite evidence paths to match before
    # the TransitionApplied event is recorded.
    if lifecycle.is_staged_run(cfg, run_id):
        rewrites = lifecycle.on_transition(cfg, run_id, from_state, to_state, evidence)
        for k, new_path in rewrites.items():
            if k in evidence:
                evidence[k] = new_path

    applied = events_mod.append(
        cfg,
        run_id,
        "TransitionApplied",
        payload={"evidence": evidence, **({"notes": notes} if notes else {})},
        actor=actor,
        from_state=from_state,
        to_state=to_state,
    )

    # Emit any secondary events declared in the rule.
    emits = rule.get("emits") or []
    for ev_type in emits:
        if ev_type == "TransitionApplied":
            continue
        secondary_payload = _secondary_payload(ev_type, evidence, meta)
        if secondary_payload is None:
            continue
        events_mod.append(
            cfg,
            run_id,
            ev_type,
            payload=secondary_payload,
            actor=actor,
        )

    return applied


def _secondary_payload(event_type: str, evidence: dict, meta: dict) -> dict | None:
    """Map evidence -> payload for the side-effect events the schema declares.

    The schema says e.g. ready->building emits both TransitionApplied and
    WorktreeCreated; the engine fills the WorktreeCreated payload from evidence.
    """
    if event_type == "WorktreeCreated":
        return {
            "repo_path": evidence.get("repo_path"),
            "repo_name": evidence.get("repo_name"),
            "branch_name": evidence.get("branch_name"),
            "worktree_name": evidence.get("worktree_name"),
            "worktree_path": evidence.get("worktree_path"),
            "base_ref": evidence.get("base_ref"),
            "initial_commit_sha": evidence.get("initial_commit_sha"),
            "repo_mode": evidence.get("repo_mode"),
        }
    if event_type == "RunCompleted":
        return {
            "accepted_by": evidence.get("accepted_by"),
            "completion_ref": evidence.get("completion_ref"),
            "audit_path": evidence.get("audit_path"),
            "notes": evidence.get("notes"),
        }
    if event_type == "RunAbandoned":
        return {
            "abandoned_reason": evidence.get("abandoned_reason"),
            "abandoned_by": evidence.get("abandoned_by"),
        }
    if event_type == "BounceRequested":
        return {
            "bounce_reason": evidence.get("bounce_reason"),
            "requested_by": evidence.get("requested_by"),
            "handoff_path": evidence.get("handoff_path"),
            "change_request_path": evidence.get("change_request_path"),
        }
    return None


def _try_emit_rejected(
    cfg: Config,
    run_id: str,
    from_state: str,
    to_state: str,
    actor: dict,
    *,
    reason: str,
    missing_evidence: list[str] | None = None,
) -> None:
    """Best-effort emission of TransitionRejected; never raise from here."""
    try:
        payload: dict[str, Any] = {"reason": reason}
        if missing_evidence:
            payload["missing_evidence"] = missing_evidence
        events_mod.append(
            cfg, run_id, "TransitionRejected",
            payload=payload, actor=actor,
            from_state=from_state, to_state=to_state,
        )
    except Exception:
        # Never mask the underlying TransitionError.
        pass
