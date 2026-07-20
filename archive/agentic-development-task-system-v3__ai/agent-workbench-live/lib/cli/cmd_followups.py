"""followups subcommand (TODO §1f).

Two modes:
  --init : while status=followups (wait — we enter followups via validate's
           default mode, so --init transitions validating -> followups). On
           --init we stage templates/follow-ups.md at the run root and apply
           the transition.
  default: while status=followups, validate the YAML-frontmatter entries in
           follow-ups.md, emit FollowupsRecorded + HumanHandoffCreated, and
           transition followups -> human_review (engine validates the
           HUMAN_REVIEW.md sections at that point).

Note: --init here is a convenience shortcut equivalent to running
`agent-workbench validate <run_id>` (which transitions validating ->
followups on staged runs). BOTH paths write `followups-context.md` into
`stages/6_followups/` via `_write_followups_context_artifacts()` — the
helper is called from both `cmd_followups._init` and (since the §5
rebuild) `cmd_validate.run`'s staged default-mode path. Most callers
won't need --init; they'll come in via /validate. We expose it anyway
so /followups is symmetric with the other stage commands.
"""
from __future__ import annotations

from lib import (
    metadata, events, transitions, locks, lifecycle, stub_llm,
    followups as followups_mod, human_review, followups_context,
)
from lib.cli._common import actor_from_env, fail, load_config
from lib.cli._stop_banner import print_stop_banner
from lib.metrics import summary as metrics_summary
from lib.metrics import writer as metrics_writer


HELP = "Author follow-ups.md (--init stages template; default validates + transitions to human_review)."


def register(p) -> None:
    p.add_argument("run_id")
    p.add_argument("--init", action="store_true",
                   help="Stage follow-ups.md template and transition validating -> followups.")


def run(args) -> int:
    cfg = load_config(args)
    actor = actor_from_env("agent")
    run_id = args.run_id

    try:
        meta = metadata.load(cfg, run_id)
    except metadata.MetadataError as e:
        return fail(str(e), 2)

    if not lifecycle.is_staged_run(cfg, run_id):
        return fail(
            f"followups stage exists for staged-layout runs only; {run_id} is flat",
            2,
        )

    rd = metadata.run_dir(cfg, run_id)

    if args.init:
        if meta["status"] != "validating":
            return fail(
                f"--init requires status=validating, got {meta['status']!r}", 2,
            )
        _stage_template(cfg, rd)
        # Stub-LLM mode (TODO §1 E2E): overwrite the template with the
        # fixture's canned follow-ups.md.
        try:
            stub_fix = stub_llm.fixture_dir_from_env()
        except stub_llm.StubLLMError as e:
            return fail(str(e), 2)
        if stub_fix is not None:
            stub_llm.materialize(rd, "followups", stub_fix)
        try:
            with locks.acquire(cfg, run_id):
                transitions.transition(
                    cfg, run_id, "followups",
                    evidence={
                        "review_report_path": str(rd / "stages" / "validating" / "review.md"),
                        "qa_report_path": str(rd / "stages" / "validating" / "qa" / "report.md"),
                        "audit_path": str(rd / "audit.md"),
                    },
                    actor=actor,
                )
        except transitions.TransitionError as e:
            return fail(str(e), 4)
        # Write followups-context.md (TODO §5: curated stage-entry context
        # for the followups stage; mirrors build-context.md / validate-
        # context.md). Convenience artifact — failures must not block --init.
        _write_followups_context_artifacts(cfg, run_id, rd)
        print(f"{run_id}: validating -> followups; staged follow-ups.md at {rd / 'follow-ups.md'}")
        return 0

    # Default: followups -> human_review.
    if meta["status"] != "followups":
        return fail(
            f"default mode requires status=followups, got {meta['status']!r}", 2,
        )

    # Stub-LLM mode (TODO §1 E2E): if the user came in via `validate`
    # (which transitions validating -> followups without staging
    # follow-ups.md), the fixture's follow-ups.md still needs to land.
    try:
        stub_fix = stub_llm.fixture_dir_from_env()
    except stub_llm.StubLLMError as e:
        return fail(str(e), 2)
    if stub_fix is not None:
        stub_llm.materialize(rd, "followups", stub_fix)

    follow_path = rd / "follow-ups.md"
    if not follow_path.exists():
        return fail(f"follow-ups.md missing at {follow_path}", 2)
    text = follow_path.read_text()
    if not text.strip():
        return fail(f"follow-ups.md is empty at {follow_path}", 2)

    errors = followups_mod.validate(text)
    if errors:
        for e in errors:
            print(f"error: {e}")
        return fail(f"follow-ups.md failed validation ({len(errors)} issue(s))", 2)

    entries = followups_mod.extract_entries(text)
    cats = followups_mod.categories(entries)
    events.append(
        cfg, run_id, "FollowupsRecorded",
        payload={
            "followups_path": str(follow_path),
            "entry_count": len(entries),
            "categories": cats,
        },
        actor=actor,
    )

    # HUMAN_REVIEW.md is the reviewer entry point; the engine validates its
    # sections in transitions.transition() below.
    handoff_path = rd / "HUMAN_REVIEW.md"

    # Token-efficiency: refresh metrics.jsonl, then inject a "## Token efficiency"
    # block into HUMAN_REVIEW.md. Best-effort: any failure is swallowed so the
    # handoff still proceeds.
    try:
        metrics_writer.record_run_metrics(cfg, run_id)
        _inject_metrics_block(cfg, run_id, handoff_path)
    except Exception:
        pass

    # Emit HumanHandoffCreated. Mirrors validate's flat-layout path; the
    # transition gate (engine-side) will reject if HUMAN_REVIEW.md is missing
    # or lacks the required headings.
    events.append(
        cfg, run_id, "HumanHandoffCreated",
        payload={
            "handoff_path": str(handoff_path),
            "branch_name": meta["target"]["worktree"]["branch_name"],
            "worktree_path": meta["target"]["worktree"]["path"],
            "review_report_path": str(rd / "stages" / "validating" / "review.md"),
            "qa_report_path": str(rd / "stages" / "validating" / "qa" / "report.md"),
            "audit_path": str(rd / "audit.md"),
        },
        actor=actor,
    )

    # Render HUMAN_REVIEW.md from events + artifacts. This is the sole writer
    # of the file going forward; whatever was authored or stub-copied earlier
    # is overwritten. The transition engine's heading gate runs immediately
    # below, so the render must happen first.
    human_review.render(cfg, run_id)

    try:
        with locks.acquire(cfg, run_id):
            transitions.transition(
                cfg, run_id, "human_review",
                evidence={
                    "followups_path": str(follow_path),
                    "handoff_path": str(handoff_path),
                    "branch_name": meta["target"]["worktree"]["branch_name"],
                    "worktree_path": meta["target"]["worktree"]["path"],
                    "audit_path": str(rd / "audit.md"),
                    "entry_count": len(entries),
                },
                actor=actor,
            )
    except transitions.TransitionError as e:
        return fail(str(e), 4)

    # Reflect the (post-move) followups artifact path in metadata. The engine
    # already moved follow-ups.md into the followups stage dir.
    followups_rel = str(
        (lifecycle.stage_dir(cfg, run_id, "followups") / "follow-ups.md").relative_to(rd)
    )

    def _m(d):
        d["artifacts"]["followups"] = followups_rel
    metadata.update(cfg, run_id, _m)

    print(f"{run_id}: followups -> human_review")
    print(f"entries:  {len(entries)} ({', '.join(cats) or 'none'})")
    print(f"review:   {handoff_path}")
    print(f"file://{handoff_path.resolve()}")
    banner_path = lifecycle.stage_dir(cfg, run_id, "followups") / "stop-banner.txt"
    print_stop_banner("human_review", run_id, cfg=cfg, write_to=banner_path)
    return 0


def _stage_template(cfg, rd) -> None:
    dest = rd / "follow-ups.md"
    if dest.exists():
        return
    src = cfg.root / "templates" / "follow-ups.md"
    dest.write_text(src.read_text() if src.exists() else "# Follow-ups\n")


def _write_followups_context_artifacts(cfg, run_id: str, rd) -> None:
    """Render `followups-context.md` for the followups stage. Idempotent.
    Errors are swallowed — this is a convenience artifact; its absence
    shouldn't block the `validating -> followups` transition. Mirrors
    `cmd_validate._write_validate_context_artifacts`.

    Called AFTER the transition completes, so the prior-stage files
    (brief, plan, build.md, review.md, qa/report.md) have been moved into
    their `stages/N_<stage>/` directories.
    """
    try:
        target_dir = lifecycle.stage_dir(cfg, run_id, "followups")
        brief_path = lifecycle.stage_dir(cfg, run_id, "shaping") / "brief.md"
        plan_path = lifecycle.stage_dir(cfg, run_id, "planning") / "plan.md"
        build_md_path = lifecycle.stage_dir(cfg, run_id, "building") / "build.md"
        review_path = lifecycle.stage_dir(cfg, run_id, "validating") / "review.md"
        qa_report_path = lifecycle.stage_dir(cfg, run_id, "validating") / "qa" / "report.md"
        followups_template_path = cfg.root / "templates" / "follow-ups.md"

        body = followups_context.build(
            brief_path=brief_path,
            plan_path=plan_path,
            build_md_path=build_md_path,
            review_path=review_path,
            qa_report_path=qa_report_path,
            followups_template_path=followups_template_path,
        )
        followups_context.write(target_dir / "followups-context.md", body)
    except Exception:
        pass


METRICS_BLOCK_START = "<!-- metrics:start -->"
METRICS_BLOCK_END = "<!-- metrics:end -->"


def _inject_metrics_block(cfg, run_id: str, handoff_path) -> None:
    """Append (or replace) a ``## Token efficiency`` block in HUMAN_REVIEW.md.

    Idempotent: the block is delimited by HTML comment markers so a re-run
    replaces the old block in place rather than appending a duplicate.
    """
    if not handoff_path.exists():
        return
    metrics_path = handoff_path.parent / "metrics.jsonl"
    if not metrics_path.exists():
        return
    try:
        s = metrics_summary.summarize(cfg, run_id)
    except Exception:
        return

    block_lines = [
        METRICS_BLOCK_START,
        "",
        "## Token efficiency",
        "",
        "_Acceptance pending — this is what we spent to get to `human_review`._",
        "_Numbers update again on `complete` / `abandon`; only `accepted_*` fields_",
        "_are gated on the human's decision._",
        "",
        "### Token spend",
        "",
        f"- **total**: {s.total_tokens:,} tokens",
        f"  - `input` (fresh, this turn): {s.total_input:,} tokens",
        f"  - `output` (generated by model): {s.total_output:,} tokens",
        f"  - `cache_read` (re-read of cached prefix across N turns): {s.total_cache_read:,} tokens",
        f"  - `cache_creation` (first-time prefix writes to cache): {s.total_cache_creation:,} tokens",
        "",
        "_`cache_read` dominates long sessions: the same system prompt + tool defs +_",
        "_conversation history get re-shown to the model every turn. Anthropic charges_",
        "_~10× less for cache reads than for fresh input, but the token count is still recorded._",
        "",
        "### Build progress (not acceptance)",
        "",
    ]
    if s.tokens_per_passing_build is not None:
        block_lines.append(
            f"- agent-approved validates: {s.approves} of {s.validate_attempts} "
            f"(`tokens / agent-approved validate` = {int(s.tokens_per_passing_build):,} tokens)"
        )
    else:
        block_lines.append(
            f"- agent-approved validates: 0 of {s.validate_attempts}"
        )
    block_lines.append(f"- build → validate cycles: {s.attempts_per_success}")
    block_lines.append(f"- repair tokens (after first non-approve): {s.repair_tokens:,} tokens")
    block_lines.append("")
    block_lines.append(
        "_These are **agent-side** signals. A run is not 'successful' until the human accepts_"
    )
    block_lines.append("_and the branch merges — see `accepted_*` below._")
    block_lines.append("")
    block_lines.append("### Acceptance (gated on human + merge)")
    block_lines.append("")
    if s.merge_commit:
        block_lines.append(f"- accepted lines: {s.accepted_lines} (merged at `{s.merge_commit[:8]}`)")
        block_lines.append(f"- accepted cost: ${s.cost_accepted_usd:.4f}")
    else:
        block_lines.append("- accepted lines: 0 _(pending — run is in `human_review` or not yet merged)_")
        block_lines.append("- accepted cost: $0.0000 _(pending — same)_")
    block_lines.append(f"- generated lines (across all drafts): {s.generated_lines}")
    block_lines.append(f"- generated cost (full run-to-here spend): ${s.cost_generated_usd:.4f}")
    block_lines.append("")
    if s.bucket_totals:
        block_lines.append("### Context buckets (input tokens, post-cache-attribution)")
        block_lines.append("")
        for k, v in sorted(s.bucket_totals.items(), key=lambda kv: -kv[1]):
            block_lines.append(f"- {k}: {v:,} tokens")
        block_lines.append("")
        block_lines.append(
            "_Buckets sum to `input` only (not `cache_read` / `cache_creation`)._"
        )
        block_lines.append(
            "_When the cache is hot, `input` is small and bucketing is meaningful;_"
        )
        block_lines.append(
            "_when the cache is cold (first turn), most fresh input lands in `other`._"
        )
        block_lines.append("")
    block_lines.append(METRICS_BLOCK_END)
    block = "\n".join(block_lines) + "\n"

    text = handoff_path.read_text()
    if METRICS_BLOCK_START in text and METRICS_BLOCK_END in text:
        # Replace the existing block.
        start = text.index(METRICS_BLOCK_START)
        end = text.index(METRICS_BLOCK_END) + len(METRICS_BLOCK_END)
        # Eat the trailing newline if present.
        if end < len(text) and text[end] == "\n":
            end += 1
        new_text = text[:start] + block + text[end:]
    else:
        if not text.endswith("\n"):
            text += "\n"
        new_text = text + "\n" + block
    handoff_path.write_text(new_text)
