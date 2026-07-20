"""plan subcommand.

Two modes:
  --init   : while status=planning, stage templates for plan/preflight/assumptions/decisions.
  default  : verify all four artifacts exist and are non-empty, then transition
             planning -> ready. Emits AssumptionRecorded / DecisionRecorded events
             for each top-level heading in assumptions.md / decisions.md.
"""
from __future__ import annotations

import re

from lib import metadata, events, transitions, locks, lifecycle, stub_llm, plan_context
from lib.cli._common import actor_from_env, fail, load_config
from lib.cli._stop_banner import print_stop_banner


HELP = "Stage planning templates (--init) or finalize the plan (default)."


PLAN_TEMPLATES_FLAT = ("plan.md", "preflight.md", "assumptions.md", "decisions.md")
# Staged layout: one merged plan.md with folded Preflight + Decisions & assumptions sections.
PLAN_TEMPLATES_STAGED = ("plan.md",)


def register(p) -> None:
    p.add_argument("run_id")
    p.add_argument("--init", action="store_true",
                   help="Stage planning templates (single merged plan.md for staged runs).")


def _stage_templates(cfg, rd, staged: bool) -> tuple[str, ...]:
    templates = PLAN_TEMPLATES_STAGED if staged else PLAN_TEMPLATES_FLAT
    for name in templates:
        dest = rd / name
        if not dest.exists():
            src = cfg.root / "templates" / name
            dest.write_text(src.read_text() if src.exists() else f"# {name}\n")
    return templates


def _parse_ids(md_text: str, prefix: str) -> list[str]:
    """Pull `## PREFIX-NNN` or `### PREFIX-NNN` style headings."""
    pattern = re.compile(rf"^#{{2,3}}\s+({prefix}-\d+)\b", re.MULTILINE)
    return pattern.findall(md_text)


def _extract_assumption_blocks(md_text: str) -> list[dict]:
    """Return [{assumption_id, text, reason, impact}, ...]."""
    parts = re.split(r"^#{2,3}\s+(ASM-\d+)\s*$", md_text, flags=re.MULTILINE)
    out: list[dict] = []
    # parts: [preamble, id1, body1, id2, body2, ...]
    for i in range(1, len(parts), 2):
        asm_id = parts[i]
        body = parts[i + 1] if i + 1 < len(parts) else ""
        out.append({
            "assumption_id": asm_id,
            "text": _field(body, "Text"),
            "reason": _field(body, "Reason"),
            "impact": _field(body, "Impact"),
        })
    return out


def _extract_decision_blocks(md_text: str) -> list[dict]:
    parts = re.split(r"^#{2,3}\s+(DR-\d+)\s*$", md_text, flags=re.MULTILINE)
    out: list[dict] = []
    for i in range(1, len(parts), 2):
        dr_id = parts[i]
        body = parts[i + 1] if i + 1 < len(parts) else ""
        out.append({
            "decision_id": dr_id,
            "decision": _field(body, "Decision"),
            "rationale": _field(body, "Rationale"),
            "alternatives_considered": _field(body, "Alternatives considered"),
            "why_not_alternatives": _field(body, "Why not the alternatives"),
        })
    return out


def _field(body: str, label: str) -> str:
    """Capture a `- **Label**: value` body, including continuation lines.

    Continuation lines are any non-empty lines that follow until the next
    `- **Other**:` field, the next `### …` heading, or a blank line that
    precedes a structural marker. Each captured line is rstrip'd and joined
    with a single space so multi-line fields read as one sentence.
    """
    lines = body.splitlines()
    head_re = re.compile(rf"^\s*-\s*\*\*{re.escape(label)}\*\*:\s*(.*)$")
    next_field_re = re.compile(r"^\s*-\s*\*\*[^*]+\*\*:")
    heading_re = re.compile(r"^#{2,4}\s+")
    for i, line in enumerate(lines):
        m = head_re.match(line)
        if not m:
            continue
        parts = [m.group(1).rstrip()]
        for cont in lines[i + 1:]:
            stripped = cont.strip()
            if not stripped:
                # Blank line ends the field; don't peek past.
                break
            if next_field_re.match(cont) or heading_re.match(cont):
                break
            parts.append(stripped)
        joined = " ".join(p for p in parts if p).strip()
        return joined
    return ""


def run(args) -> int:
    cfg = load_config(args)
    actor = actor_from_env("agent")
    run_id = args.run_id

    try:
        meta = metadata.load(cfg, run_id)
    except metadata.MetadataError as e:
        return fail(str(e), 2)

    rd = metadata.run_dir(cfg, run_id)
    staged = lifecycle.is_staged_run(cfg, run_id)

    if args.init:
        if meta["status"] != "planning":
            return fail(f"--init requires status=planning, got {meta['status']!r}", 2)
        templates = _stage_templates(cfg, rd, staged)
        if staged:
            def _m(d):
                d["artifacts"]["plan"] = "plan.md"
                d["artifacts"]["preflight"] = "plan.md#preflight"
                d["artifacts"]["assumptions"] = "plan.md#decisions--assumptions"
                d["artifacts"]["decisions"] = "plan.md#decisions--assumptions"
        else:
            def _m(d):
                d["artifacts"]["plan"] = "plan.md"
                d["artifacts"]["preflight"] = "preflight.md"
                d["artifacts"]["assumptions"] = "assumptions.md"
                d["artifacts"]["decisions"] = "decisions.md"
        metadata.update(cfg, run_id, _m)
        for name in templates:
            events.append(
                cfg, run_id, "ArtifactWritten",
                payload={"artifact_key": name.replace(".md",""), "path": str(rd / name), "summary": "template staged"},
                actor=actor,
            )
        # Stub-LLM mode (TODO §1 E2E).
        try:
            fix = stub_llm.fixture_dir_from_env()
        except stub_llm.StubLLMError as e:
            return fail(str(e), 2)
        if fix is not None:
            stub_llm.materialize(rd, "planning", fix)
        # Write plan-context.md (TODO §5: curated stage-entry context for
        # the planning stage; mirrors build-context.md / validate-context.md).
        # Convenience artifact — failures must not block --init.
        _write_plan_context_artifacts(cfg, run_id, rd, staged, meta)
        print(f"{run_id}: staged {', '.join(templates)}")
        return 0

    # Default: planning -> ready.
    if meta["status"] != "planning":
        return fail(f"default mode requires status=planning, got {meta['status']!r}", 2)

    # Verify required artifacts (location depends on layout).
    if staged:
        required = ("plan.md",)
    else:
        required = PLAN_TEMPLATES_FLAT
    for name in required:
        p = rd / name
        if not p.exists() or not p.read_text().strip():
            return fail(f"{name} missing or empty at {p}", 2)

    # Emit AssumptionRecorded / DecisionRecorded for any ID found.
    # For staged runs, scan the merged plan.md; for flat, the separate files.
    if staged:
        asm_text = dr_text = (rd / "plan.md").read_text()
        asm_source = dr_source = "plan.md"
    else:
        asm_text = (rd / "assumptions.md").read_text()
        dr_text = (rd / "decisions.md").read_text()
        asm_source = "assumptions.md"
        dr_source = "decisions.md"
    for asm in _extract_assumption_blocks(asm_text):
        if not asm["text"]:
            continue
        events.append(
            cfg, run_id, "AssumptionRecorded",
            payload={
                "assumption_id": asm["assumption_id"],
                "text": asm["text"],
                "reason": asm["reason"] or "(not recorded)",
                "impact": asm["impact"] or "(not recorded)",
                "source_artifact": asm_source,
            },
            actor=actor,
        )
    for dr in _extract_decision_blocks(dr_text):
        if not dr["decision"]:
            continue
        events.append(
            cfg, run_id, "DecisionRecorded",
            payload={
                "decision_id": dr["decision_id"],
                "decision": dr["decision"],
                "rationale": dr["rationale"] or "(not recorded)",
                "alternatives_considered": dr["alternatives_considered"],
                "why_not_alternatives": dr["why_not_alternatives"],
                "source_artifact": dr_source,
            },
            actor=actor,
        )

    # Emit PreflightCompleted.
    preflight_artifact = "plan.md" if staged else "preflight.md"
    events.append(
        cfg, run_id, "PreflightCompleted",
        payload={
            "preflight_path": str(rd / preflight_artifact),
            "repo_path": meta["target"]["repo"]["path"],
            "repo_name": meta["target"]["repo"]["name"],
            "base_ref": meta["target"]["repo"]["base_ref"],
            "branch_name": meta["target"]["worktree"]["branch_name"],
            "worktree_name": meta["target"]["worktree"]["name"],
        },
        actor=actor,
    )

    # Apply the transition. For staged runs every planning-evidence path is
    # plan.md (with an anchor for non-plan keys). The engine's move-on-
    # transition will rewrite plan_path to stages/3_planning/plan.md and the
    # anchored keys to stages/3_planning/plan.md#<anchor>.
    if staged:
        plan_src = str(rd / "plan.md")
        evidence = {
            "plan_path": plan_src,
            "assumptions_path": plan_src,
            "decisions_path": plan_src,
            "preflight_path": plan_src,
            "repo_path": meta["target"]["repo"]["path"],
            "repo_name": meta["target"]["repo"]["name"],
            "worktree_name": meta["target"]["worktree"]["name"],
            "branch_name": meta["target"]["worktree"]["branch_name"],
            "base_ref": meta["target"]["repo"]["base_ref"],
        }
    else:
        evidence = {
            "plan_path": str(rd / "plan.md"),
            "assumptions_path": str(rd / "assumptions.md"),
            "decisions_path": str(rd / "decisions.md"),
            "preflight_path": str(rd / "preflight.md"),
            "repo_path": meta["target"]["repo"]["path"],
            "repo_name": meta["target"]["repo"]["name"],
            "worktree_name": meta["target"]["worktree"]["name"],
            "branch_name": meta["target"]["worktree"]["branch_name"],
            "base_ref": meta["target"]["repo"]["base_ref"],
        }
    try:
        with locks.acquire(cfg, run_id):
            transitions.transition(
                cfg, run_id, "ready",
                evidence=evidence,
                actor=actor,
            )
    except transitions.TransitionError as e:
        return fail(str(e), 4)

    print(f"{run_id}: planning -> ready")
    banner_path = lifecycle.stage_dir(cfg, run_id, "planning") / "stop-banner.txt"
    print_stop_banner("ready", run_id, write_to=banner_path)
    return 0


def _write_plan_context_artifacts(cfg, run_id: str, rd, staged: bool, meta: dict) -> None:
    """Render `plan-context.md` for the planning stage. Idempotent. Errors
    are swallowed — this is a convenience artifact; its absence shouldn't
    block `plan --init`. Mirrors `cmd_start._write_build_context_artifacts`.
    """
    try:
        target_dir = lifecycle.stage_dir(cfg, run_id, "planning") if staged else rd
        brief_path = rd / "brief.md"
        plan_template_path = cfg.root / "templates" / "plan.md"
        worktree = (meta.get("target") or {}).get("worktree") or {}
        worktree_path = worktree.get("path")
        body = plan_context.build(
            brief_path=brief_path,
            plan_template_path=plan_template_path,
            worktree_path=worktree_path,
            meta=meta,
        )
        plan_context.write(target_dir / "plan-context.md", body)
    except Exception:
        pass
