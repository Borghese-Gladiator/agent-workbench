"""validate subcommand.

Two modes:
  --init : while status=building, stage validating-stage templates (review,
           qa/report, HUMAN_REVIEW for staged runs; implementation-summary +
           diff-summary + handoff for flat). Fill build-loop metadata defaults
           (TODO §1e). Transition building -> validating.
  default: verify post-impl artifacts present and non-empty; verify
           build.md's "Documentation touched" claims against the worktree
           diff (TODO §1d); render audit.md; transition validating ->
           human_review.

For convenience, the default mode allows status in (building, validating) and
will auto-init if invoked from `building`.
"""
from __future__ import annotations

import subprocess
import sys

from lib import metadata, events, transitions, locks, audit, lifecycle, doc_claims, scope_check, stub_llm, validate_context
from lib.cli._common import actor_from_env, fail, load_config
from lib.cli._stop_banner import print_stop_banner
from lib.metrics import summary as metrics_summary
from lib.metrics import writer as metrics_writer


HELP = "Run review + QA + render audit, then transition to human_review."


# Flat-layout templates (legacy runs).
POST_TEMPLATES_FLAT = ("implementation-summary.md", "diff-summary.md", "review.md", "handoff.md")
# Staged-layout templates. The builder writes build.md DURING building (it's
# the stage's output and gets moved into stages/4_building/ on transition),
# so --init only stages validating's templates here.
POST_TEMPLATES_STAGED = ("review.md", "HUMAN_REVIEW.md")
QA_REPORT = "qa/report.md"


def register(p) -> None:
    p.add_argument("run_id")
    p.add_argument("--init", action="store_true", help="Stage post-impl templates and transition building -> validating.")
    p.add_argument("--tests-passed", choices=("true", "false"), help="Recorded on QACompleted.")
    p.add_argument("--known-issues", type=int, default=0)


def _write_validate_context_artifacts(cfg, run_id, rd, staged: bool, meta: dict) -> None:
    """Pass-2 B2 + B4. Write validate-context.md and blast-radius.txt into
    the validating stage dir. Idempotent. Errors are swallowed — these are
    convenience artifacts; their absence shouldn't break the transition."""
    try:
        target_dir = lifecycle.stage_dir(cfg, run_id, "validating") if staged else rd
        worktree = (meta.get("target") or {}).get("worktree") or {}
        worktree_path = worktree.get("path") or ""
        repo = (meta.get("target") or {}).get("repo") or {}
        base_ref = repo.get("base_ref") or "HEAD"
        # TODO §3 item 2a: prefer the resolved SHA captured at /start time.
        # Without this, runs with base_ref="HEAD" produce empty diffs.
        base_ref_sha = repo.get("base_ref_sha")

        if staged:
            brief_path = lifecycle.stage_dir(cfg, run_id, "shaping") / "brief.md"
            plan_path = lifecycle.stage_dir(cfg, run_id, "planning") / "plan.md"
            build_md_path = lifecycle.stage_dir(cfg, run_id, "building") / "build.md"
        else:
            brief_path = rd / "brief.md"
            plan_path = rd / "plan.md"
            build_md_path = rd / "build.md"
        qa_path = rd / "qa" / "report.md"

        body = validate_context.build(
            brief_path=brief_path,
            plan_path=plan_path,
            build_md_path=build_md_path,
            qa_report_path=qa_path,
            worktree_path=worktree_path,
            base_ref=base_ref,
            base_ref_sha=base_ref_sha,
        )
        validate_context.write(target_dir / "validate-context.md", body)

        br_text = validate_context.build_blast_radius(
            worktree_path=worktree_path,
            base_ref=base_ref,
            base_ref_sha=base_ref_sha,
        )
        (target_dir / "blast-radius.txt").write_text(br_text, encoding="utf-8")
    except Exception:
        # Best-effort: never fail the transition over a curation artifact.
        pass


def _session_staleness_threshold(cfg) -> int:
    """Read the configurable threshold from agent-workbench.yaml; default 100."""
    raw = getattr(cfg, "raw", {}) or {}
    val = raw.get("session_staleness_threshold_turns")
    try:
        return int(val) if val is not None else 100
    except (TypeError, ValueError):
        return 100


def _print_fresh_session_handoff(cfg, run_id, rd, meta) -> None:
    """Pass-2 B5. When the run's largest session crossed the threshold,
    print a copy-pasteable handoff block ahead of the existing transition
    line. Silent when no metrics yet, or when the threshold isn't crossed.
    """
    try:
        # If metrics.jsonl exists but is fresh from a prior run, summarize();
        # otherwise we don't have a turn count to compare yet.
        if not (rd / "metrics.jsonl").exists():
            return
        s = metrics_summary.summarize(cfg, run_id)
    except Exception:
        return
    threshold = _session_staleness_threshold(cfg)
    if (s.largest_session_turns or 0) <= threshold:
        return
    worktree = (meta.get("target") or {}).get("worktree") or {}
    branch = worktree.get("branch_name") or "?"
    worktree_path = worktree.get("path") or "?"
    bar = "=" * 60
    print(bar)
    print(f"This run is ready for validation in a fresh Claude Code session.")
    print(f"  run_id:    {run_id}")
    print(f"  worktree:  {worktree_path}")
    print(f"  branch:    {branch}")
    print(f"")
    print(f"Exit Claude Code, then:")
    print(f"  cd {worktree_path}")
    print(f"  claude")
    print(f"  /validate {run_id}")
    print(f"")
    print(f"The new session bootstraps from validate-context.md — no other context needed.")
    print(f"(Building session reached {s.largest_session_turns} turns; threshold {threshold}.)")
    print(bar)


def _check_scope_creep_staged(cfg, run_id, rd, meta, actor) -> None:
    """TODO §1g. Parse brief.md for expected-file claims, compare against the
    worktree diff, append findings to review.md (run root), emit a
    ScopeCreepChecked event. Skips silently if the brief makes no claim."""
    brief_path = lifecycle.stage_dir(cfg, run_id, "shaping") / "brief.md"
    if not brief_path.exists():
        return
    expected = scope_check.extract_expected_files(brief_path.read_text())
    if expected is None:
        # Brief didn't make a claim; nothing to compare against.
        return

    worktree_path = meta["target"]["worktree"]["path"]
    base_ref = meta["target"]["repo"]["base_ref"]
    base_ref_sha = meta["target"]["repo"].get("base_ref_sha")
    effective_ref = base_ref_sha or base_ref
    try:
        proc = subprocess.run(
            ["git", "-C", str(worktree_path), "diff", "--name-only", f"{effective_ref}...HEAD"],
            capture_output=True, text=True, check=False,
        )
    except FileNotFoundError:
        return
    if proc.returncode != 0:
        return
    actual = [ln.strip() for ln in proc.stdout.splitlines() if ln.strip()]
    creep = scope_check.detect_creep(expected, actual)

    if creep:
        review = rd / "review.md"
        with open(review, "a") as f:
            f.write("\n## Scope creep check\n\n")
            f.write(
                "Validating compared `brief.md`'s expected file list against "
                "`git diff` in the worktree. The following files were changed "
                "but NOT anticipated by the brief:\n\n"
            )
            for p in creep:
                f.write(f"- `{p}`\n")
            f.write(
                "\nEither these are legitimate ripple effects (and the brief "
                "should be updated), or the scope expanded mid-run. Reviewer: "
                "confirm or push back.\n"
            )
    events.append(
        cfg, run_id, "ScopeCreepChecked",
        payload={
            "expected": expected,
            "actual": actual,
            "creep": creep,
            "base_ref": base_ref,
            "base_ref_sha": base_ref_sha,
            "effective_ref": effective_ref,
            "worktree_path": worktree_path,
        },
        actor=actor,
    )


def _verify_doc_claims_staged(cfg, run_id, rd, meta, actor) -> None:
    """TODO §1d. Read the building stage's build.md, extract claimed doc
    paths, diff the worktree, append findings to review.md (at run root)
    and emit a DocClaimsVerified event."""
    build_path = lifecycle.stage_dir(cfg, run_id, "building") / "build.md"
    if not build_path.exists():
        return
    claimed = doc_claims.extract(build_path.read_text())
    if claimed is doc_claims.NONE_NEEDED:
        events.append(
            cfg, run_id, "DocClaimsVerified",
            payload={"claimed": [], "unverified": [], "note": "none needed"},
            actor=actor,
        )
        return
    if not claimed:
        # No section, no findings, no event.
        return
    worktree_path = meta["target"]["worktree"]["path"]
    base_ref = meta["target"]["repo"]["base_ref"]
    base_ref_sha = meta["target"]["repo"].get("base_ref_sha")
    unverified = doc_claims.verify(claimed, worktree_path, base_ref, base_ref_sha=base_ref_sha)
    if unverified:
        review = rd / "review.md"
        with open(review, "a") as f:
            f.write("\n## Documentation claims\n\n")
            f.write(
                "Validating compared `build.md`'s **Documentation touched** "
                "section against `git diff` in the worktree. The following "
                "claimed paths were NOT changed in the diff:\n\n"
            )
            for p in unverified:
                f.write(f"- `{p}`\n")
            f.write(
                "\nEither the claim is wrong, the change is unstaged, or the "
                "base ref is misconfigured. Reviewer: confirm or push back.\n"
            )
    events.append(
        cfg, run_id, "DocClaimsVerified",
        payload={
            "claimed": claimed,
            "unverified": unverified,
            "base_ref": base_ref,
            "worktree_path": worktree_path,
        },
        actor=actor,
    )


def _stage(cfg, rd, staged: bool) -> None:
    templates = POST_TEMPLATES_STAGED if staged else POST_TEMPLATES_FLAT
    for name in templates:
        dest = rd / name
        if not dest.exists():
            src = cfg.root / "templates" / name
            dest.write_text(src.read_text() if src.exists() else f"# {name}\n")
    qa_dir = rd / "qa"
    qa_dir.mkdir(exist_ok=True)
    for sub in ("artifacts", "recordings", "traces"):
        (qa_dir / sub).mkdir(exist_ok=True)
    report = qa_dir / "report.md"
    if not report.exists():
        src = cfg.root / "templates" / "qa" / "report.md"
        report.write_text(src.read_text() if src.exists() else "# QA report\n")
    commands = qa_dir / "commands.txt"
    if not commands.exists():
        commands.write_text("")


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
        if meta["status"] != "building":
            return fail(f"--init requires status=building, got {meta['status']!r}", 2)
        # Stub-LLM mode (TODO §1 E2E): materialize build.md from the fixture
        # BEFORE the missing-file check so the run gets real content (not the
        # template fallback that init writes when no builder ran). The
        # validating fixtures get materialized after templates are staged below.
        try:
            stub_fix = stub_llm.fixture_dir_from_env()
        except stub_llm.StubLLMError as e:
            return fail(str(e), 2)
        if stub_fix is not None:
            stub_llm.materialize(rd, "building", stub_fix)
        # Staged runs require build.md to already exist (builder writes it
        # during building). Stage it from the template only if absent, but
        # warn loudly: the fallback exists for smoke tests, and a real run
        # hitting it means the builder produced nothing reviewable.
        template_fallback_fired = False
        if staged and not (rd / "build.md").exists():
            # Smoke-test tolerance: stage the template so the transition
            # engine has something to move into stages/4_building/build.md.
            tpl = cfg.root / "templates" / "build.md"
            build_path = rd / "build.md"
            build_path.write_text(tpl.read_text() if tpl.exists() else "# Build\n")
            template_fallback_fired = True
            print(
                f"WARNING: builder wrote no build.md for {run_id}; "
                f"staged templates/build.md as fallback. The handoff will "
                f"contain phantom-template content unless the builder runs.",
                file=sys.stderr,
            )
            events.append(
                cfg, run_id, "ArtifactWritten",
                payload={
                    "artifact_key": "build",
                    "path": str(build_path),
                    "summary": "template fallback fired — builder wrote no build.md",
                },
                actor=actor,
            )
        _stage(cfg, rd, staged)
        # Stub-LLM mode (TODO §1 E2E): overwrite the just-staged validating
        # templates (review.md, qa/report.md, HUMAN_REVIEW.md) with the
        # fixture's canned content.
        if stub_fix is not None:
            stub_llm.materialize(rd, "validating", stub_fix)
        # Build-loop metadata (TODO §1e). Fill defaults if the builder didn't
        # set them, then carry them into the transition evidence. The
        # transitions schema now requires these on building -> validating.
        build_block = meta.get("build") or {}
        iterations = build_block.get("iterations")
        exit_reason = build_block.get("exit_reason")
        if iterations is None:
            iterations = 1
        if exit_reason is None:
            exit_reason = "tests_green"

        def _fill_build(d):
            d.setdefault("build", {})
            d["build"]["iterations"] = iterations
            d["build"]["exit_reason"] = exit_reason
            d["build"].setdefault("max_iterations", 5)
            if template_fallback_fired:
                d["build"]["template_fallback_fired"] = True
        metadata.update(cfg, run_id, _fill_build)

        # For staged runs, build.md is the single merged artifact; both
        # implementation_summary_path and diff_summary_path evidence keys point
        # at it (their values get rewritten to stages/4_building/build.md by
        # the transition engine's move-on-transition hook).
        if staged:
            build_src = str(rd / "build.md")
            evidence = {
                "implementation_summary_path": build_src,
                "diff_summary_path": build_src,
                "build_iterations": iterations,
                "build_exit_reason": exit_reason,
            }
        else:
            evidence = {
                "implementation_summary_path": str(rd / "implementation-summary.md"),
                "diff_summary_path": str(rd / "diff-summary.md"),
                "build_iterations": iterations,
                "build_exit_reason": exit_reason,
            }
        try:
            with locks.acquire(cfg, run_id):
                transitions.transition(
                    cfg, run_id, "validating",
                    evidence=evidence,
                    actor=actor,
                )
        except transitions.TransitionError as e:
            return fail(str(e), 4)
        if staged:
            build_rel = str(
                (lifecycle.stage_dir(cfg, run_id, "building") / "build.md").relative_to(rd)
            )

            def _m(d):
                d["artifacts"]["implementation_summary"] = build_rel
                d["artifacts"]["diff_summary"] = f"{build_rel}#files-changed"
                d["artifacts"]["review_report"] = "review.md"
                d["artifacts"]["qa_report"] = "qa/report.md"
                d["artifacts"]["handoff"] = "HUMAN_REVIEW.md"
        else:
            def _m(d):
                d["artifacts"]["implementation_summary"] = "implementation-summary.md"
                d["artifacts"]["diff_summary"] = "diff-summary.md"
                d["artifacts"]["review_report"] = "review.md"
                d["artifacts"]["qa_report"] = "qa/report.md"
                d["artifacts"]["handoff"] = "handoff.md"
        metadata.update(cfg, run_id, _m)

        # Pass-2 (B2 + B4): write deterministic validate-context.md and
        # blast-radius.txt into the validating stage dir. Pure Python — no
        # LLM call. The validator reads these instead of brief/plan/build/qa
        # separately.
        _write_validate_context_artifacts(cfg, run_id, rd, staged, meta)

        # Pass-2 (B5): refresh metrics now so the handoff check sees the
        # building session's turn count.
        try:
            metrics_writer.record_run_metrics(cfg, run_id)
        except Exception:
            pass

        # Pass-2 (B5): fresh-session handoff block. When the build session
        # crossed the staleness threshold, print a copy-pasteable block at
        # the top so the operator restarts Claude Code in a fresh session
        # before driving /validate.
        _print_fresh_session_handoff(cfg, run_id, rd, meta)

        print(f"{run_id}: building -> validating; staged post-impl templates")
        return 0

    # Default: validating -> followups (TODO §1f). The handoff/HUMAN_REVIEW.md
    # gate has moved to `agent-workbench followups`.
    if meta["status"] != "validating":
        return fail(f"default mode requires status=validating, got {meta['status']!r}", 2)

    # Verify required artifacts (location depends on layout). HUMAN_REVIEW.md
    # is NOT required here for staged runs — it's required by followups.
    if staged:
        build_rel = str(
            (lifecycle.stage_dir(cfg, run_id, "building") / "build.md").relative_to(rd)
        )
        required = [
            (build_rel, "implementation_summary_path"),
            ("review.md", "review_report_path"),
            ("qa/report.md", "qa_report_path"),
        ]
    else:
        required = [
            ("implementation-summary.md", "implementation_summary_path"),
            ("diff-summary.md", "diff_summary_path"),
            ("review.md", "review_report_path"),
            ("qa/report.md", "qa_report_path"),
            ("handoff.md", "handoff_path"),
        ]
    for name, _label in required:
        p = rd / name
        if not p.exists() or not p.read_text().strip():
            return fail(f"required artifact missing or empty: {p}", 2)

    # TODO §1d: verify the "Documentation touched" claims in build.md against
    # the worktree diff. Findings are appended to review.md so the reviewer
    # sees them; the transition still proceeds.
    # TODO §1g: compare brief.md's expected file list to the actual diff.
    # Unexpected files surface as a "Scope creep check" section in review.md.
    if staged:
        _verify_doc_claims_staged(cfg, run_id, rd, meta, actor)
        _check_scope_creep_staged(cfg, run_id, rd, meta, actor)

    # Emit ReviewCompleted (best-effort decision parsing).
    review_text = (rd / "review.md").read_text()
    decision = "request_changes"
    for line in review_text.splitlines():
        s = line.strip().lower()
        if s.startswith("## decision"):
            continue
        if s in ("approve", "request_changes", "block"):
            decision = s
            break
    events.append(
        cfg, run_id, "ReviewCompleted",
        payload={
            "review_report_path": str(rd / "review.md"),
            "review_decision": decision,
        },
        actor=actor,
    )

    # Emit QACompleted. tests_passed is required by the schema; default False
    # (no claim) when the caller didn't pass --tests-passed.
    if args.tests_passed is None:
        tests_passed = False
    else:
        tests_passed = args.tests_passed == "true"
    events.append(
        cfg, run_id, "QACompleted",
        payload={
            "qa_report_path": str(rd / "qa" / "report.md"),
            "commands_path": str(rd / "qa" / "commands.txt"),
            "tests_passed": tests_passed,
            "known_issues_count": int(args.known_issues),
            "artifacts_dir": str(rd / "qa" / "artifacts"),
            "recordings_dir": str(rd / "qa" / "recordings"),
            "traces_dir": str(rd / "qa" / "traces"),
        },
        actor=actor,
    )

    # Update metadata validation block.
    def _m(d):
        d["validation"]["review_completed"] = True
        d["validation"]["qa_completed"] = True
        d["validation"]["qa_recorded"] = True
        if tests_passed is not None:
            d["validation"]["tests_passed"] = tests_passed
        d["validation"]["known_issues_count"] = int(args.known_issues)
    metadata.update(cfg, run_id, _m)

    # Render audit.md.
    audit_path = audit.render(cfg, run_id)
    events.append(
        cfg, run_id, "AuditRendered",
        payload={"audit_path": str(audit_path)},
        actor=actor,
    )
    def _m2(d):
        d["artifacts"]["audit"] = "audit.md"
    metadata.update(cfg, run_id, _m2)

    if staged:
        # Staged runs route through the new `followups` stage (TODO §1f).
        # HumanHandoffCreated + the HUMAN_REVIEW.md gate now fire in
        # `agent-workbench followups`; we only transition into followups here.
        try:
            with locks.acquire(cfg, run_id):
                transitions.transition(
                    cfg, run_id, "followups",
                    evidence={
                        "review_report_path": str(rd / "review.md"),
                        "qa_report_path": str(rd / "qa" / "report.md"),
                        "audit_path": str(audit_path),
                        "tests_passed": tests_passed,
                        "known_issues_count": int(args.known_issues),
                    },
                    actor=actor,
                )
        except transitions.TransitionError as e:
            return fail(str(e), 4)
        # Write followups-context.md now that the prior-stage outputs have
        # been moved into their stage dirs by the transition. The canonical
        # user path (`agent-workbench validate <run_id>`) lands here; the
        # rarer `cmd_followups --init` shortcut writes it too. Both paths
        # must produce the curated file for the §5 contract to hold.
        from lib.cli.cmd_followups import _write_followups_context_artifacts
        _write_followups_context_artifacts(cfg, run_id, rd)
        # Token-efficiency tracking: write metrics.jsonl now so it's available
        # to the followups stage's HUMAN_REVIEW rendering.
        try:
            metrics_writer.record_run_metrics(cfg, run_id)
        except Exception:
            pass
        print(f"{run_id}: validating -> followups")
        followups_rel = lifecycle.stage_dir(cfg, run_id, "followups").relative_to(rd)
        print(f"  next: author {followups_rel}/follow-ups.md, then run "
              f"`agent-workbench followups {run_id}`")
        return 0

    # Flat-layout legacy path: validating -> human_review directly.
    handoff_file = "handoff.md"
    events.append(
        cfg, run_id, "HumanHandoffCreated",
        payload={
            "handoff_path": str(rd / handoff_file),
            "branch_name": meta["target"]["worktree"]["branch_name"],
            "worktree_path": meta["target"]["worktree"]["path"],
            "review_report_path": str(rd / "review.md"),
            "qa_report_path": str(rd / "qa" / "report.md"),
            "audit_path": str(audit_path),
        },
        actor=actor,
    )
    try:
        with locks.acquire(cfg, run_id):
            transitions.transition(
                cfg, run_id, "human_review",
                evidence={
                    "review_report_path": str(rd / "review.md"),
                    "qa_report_path": str(rd / "qa" / "report.md"),
                    "audit_path": str(audit_path),
                    "handoff_path": str(rd / handoff_file),
                    "branch_name": meta["target"]["worktree"]["branch_name"],
                    "worktree_path": meta["target"]["worktree"]["path"],
                    "tests_passed": tests_passed,
                    "known_issues_count": int(args.known_issues),
                },
                actor=actor,
            )
    except transitions.TransitionError as e:
        return fail(str(e), 4)

    # Token-efficiency tracking (flat layout path).
    try:
        metrics_writer.record_run_metrics(cfg, run_id)
    except Exception:
        pass

    print(f"{run_id}: validating -> human_review")
    print(f"branch:   {meta['target']['worktree']['branch_name']}")
    print(f"worktree: {meta['target']['worktree']['path']}")
    print(f"audit:    {audit_path}")
    banner_path = lifecycle.stage_dir(cfg, run_id, "validating") / "stop-banner.txt"
    print_stop_banner("human_review", run_id, cfg=cfg, write_to=banner_path)
    return 0
