"""Unit tests for lib/board/snapshot.py and lib/board/source.py.

Seed fake runs/ trees and assert derived fields, health flags, recent events,
and column grouping. No TTY required.
"""
from __future__ import annotations

import datetime as dt
import json
import pathlib
import textwrap
import unittest

from tests._helpers import make_tmp_workbench, cleanup, reset_caches


def _iso(ts: dt.datetime) -> str:
    return ts.astimezone().replace(microsecond=0).isoformat()


def seed_run(
    root: pathlib.Path,
    run_id: str,
    *,
    status: str,
    repo_name: str = "repo",
    repo_path: str = "/tmp/{repo_name}",
    branch: str = "agent/branch",
    worktree_name: str = "wt",
    worktree_created: bool = True,
    created_at: dt.datetime | None = None,
    updated_at: dt.datetime | None = None,
    review_completed: bool = False,
    qa_completed: bool = False,
    tests_passed: bool | None = None,
    known_issues_count: int = 0,
    build_iterations: int | None = None,
    build_max_iterations: int = 5,
    build_exit_reason: str | None = None,
    build_md: bool = False,
    build_md_body: str | None = None,
    scope_kind: str = "implementation",
    accepted_by: str | None = None,
    completed_at: dt.datetime | None = None,
    abandoned_reason: str | None = None,
    completion_ref: str | None = None,
) -> pathlib.Path:
    """Write metadata.yaml for a fake run. Returns the run dir."""
    rd = root / "runs" / run_id
    rd.mkdir(parents=True)
    now = updated_at or dt.datetime.now().astimezone()
    created = created_at or now

    iters = "null" if build_iterations is None else str(build_iterations)
    exit_reason = "null" if build_exit_reason is None else f'"{build_exit_reason}"'
    tp = "null" if tests_passed is None else ("true" if tests_passed else "false")
    rc = "true" if review_completed else "false"
    qc = "true" if qa_completed else "false"
    wt_created = "true" if worktree_created else "false"
    accepted = "null" if accepted_by is None else f'"{accepted_by}"'
    completed_iso = "null" if completed_at is None else f'"{_iso(completed_at)}"'
    abandoned = "null" if abandoned_reason is None else f'"{abandoned_reason}"'
    cref = "null" if completion_ref is None else f'"{completion_ref}"'
    repo_path_resolved = repo_path.format(repo_name=repo_name)

    body = textwrap.dedent(f"""\
        schema_version: 1
        run_id: "{run_id}"
        status: {status}
        created_at: "{_iso(created)}"
        updated_at: "{_iso(now)}"
        target:
          repo:
            mode: existing
            path: {repo_path_resolved}
            name: {repo_name}
            base_ref: main
            fingerprint: null
            created_by_run: null
          worktree:
            name: {worktree_name}
            path: /tmp/wt-{worktree_name}
            branch_name: {branch}
            created: {wt_created}
            base_ref: main
            initial_commit_sha: null
        scope:
          kind: {scope_kind}
          summary: ""
        artifacts:
          raw_idea: raw-idea.md
          answers: null
          brief: null
          plan: null
          preflight: null
          assumptions: null
          decisions: null
          implementation_summary: null
          diff_summary: null
          review_report: null
          qa_report: null
          audit: null
          handoff: null
          followups: null
        validation:
          required: true
          review_completed: {rc}
          qa_completed: {qc}
          qa_recorded: false
          tests_passed: {tp}
          known_issues_count: {known_issues_count}
        completion:
          accepted_by: {accepted}
          completion_ref: {cref}
          completed_at: {completed_iso}
          abandoned_reason: {abandoned}
        build:
          iterations: {iters}
          exit_reason: {exit_reason}
          max_iterations: {build_max_iterations}
        """)
    (rd / "metadata.yaml").write_text(body)

    if build_md:
        stages = rd / "stages" / "4_building"
        stages.mkdir(parents=True)
        (stages / "build.md").write_text(build_md_body or "# build\n")
    return rd


def append_event(rd: pathlib.Path, ev: dict) -> None:
    p = rd / "events.jsonl"
    with p.open("a") as f:
        f.write(json.dumps(ev) + "\n")


def base_event(
    seq: int,
    run_id: str,
    event_type: str,
    *,
    status: str = "building",
    at: dt.datetime | None = None,
    actor_name: str = "tim",
    payload: dict | None = None,
    extra: dict | None = None,
) -> dict:
    when = at or dt.datetime.now().astimezone()
    ev = {
        "schema_version": 1,
        "seq": seq,
        "event_id": f"evt_test_{seq:04d}",
        "run_id": run_id,
        "at": _iso(when),
        "actor": {"type": "agent", "name": actor_name},
        "type": event_type,
        "status": status,
        "payload": payload or {},
    }
    if extra:
        ev.update(extra)
    return ev


class BoardSnapshotTestBase(unittest.TestCase):
    def setUp(self):
        reset_caches()
        self.tmp = make_tmp_workbench()
        import sys
        if str(self.tmp) not in sys.path:
            sys.path.insert(0, str(self.tmp))
        from lib import config as cfg_mod
        self.cfg = cfg_mod.load(self.tmp)

    def tearDown(self):
        cleanup(self.tmp)


class TestColumnsAndOrdering(BoardSnapshotTestBase):
    def test_canonical_order(self):
        from lib.board import snapshot

        seed_run(self.tmp, "r-building", status="building", repo_name="alpha")
        seed_run(self.tmp, "r-draft", status="draft", repo_name="beta")
        seed_run(self.tmp, "r-planning", status="planning", repo_name="gamma")

        snap = snapshot.build(self.cfg)
        # All canonical columns present.
        statuses = [c.status for c in snap.columns]
        self.assertEqual(statuses, list(snapshot.COLUMN_ORDER))

        # Visible columns drop empties.
        visible = [c.status for c in snap.visible_columns()]
        # canonical order: draft, planning, building
        self.assertEqual(visible, ["draft", "planning", "building"])

    def test_terminal_states_hidden_by_default(self):
        from lib.board import snapshot

        seed_run(self.tmp, "r-active", status="building")
        seed_run(self.tmp, "r-done", status="done")

        snap = snapshot.build(self.cfg)
        ids = {r.run_id for c in snap.visible_columns() for r in c.runs}
        self.assertIn("r-active", ids)
        self.assertNotIn("r-done", ids)

    def test_terminal_states_with_show_all(self):
        from lib.board import snapshot

        seed_run(self.tmp, "r-done", status="done")
        seed_run(self.tmp, "r-abandoned", status="abandoned")

        snap = snapshot.build(self.cfg, show_all=True)
        ids = {r.run_id for c in snap.visible_columns() for r in c.runs}
        self.assertEqual(ids, {"r-done", "r-abandoned"})

    def test_status_filter(self):
        from lib.board import snapshot

        seed_run(self.tmp, "r-build", status="building")
        seed_run(self.tmp, "r-plan", status="planning")

        snap = snapshot.build(self.cfg, only_status="building")
        ids = {r.run_id for c in snap.visible_columns() for r in c.runs}
        self.assertEqual(ids, {"r-build"})

    def test_within_column_oldest_first(self):
        from lib.board import snapshot

        now = dt.datetime.now().astimezone()
        seed_run(self.tmp, "r-fresh", status="building",
                 updated_at=now - dt.timedelta(minutes=2))
        seed_run(self.tmp, "r-old", status="building",
                 updated_at=now - dt.timedelta(hours=3))

        snap = snapshot.build(self.cfg, now=now)
        building = next(c for c in snap.columns if c.status == "building")
        order = [r.run_id for r in building.runs]
        self.assertEqual(order, ["r-old", "r-fresh"])


class TestHealthFlags(BoardSnapshotTestBase):
    def test_stale_human_review(self):
        from lib.board import snapshot

        stale = dt.datetime.now().astimezone() - dt.timedelta(hours=48)
        fresh = dt.datetime.now().astimezone() - dt.timedelta(hours=1)
        seed_run(self.tmp, "r-stale", status="human_review", updated_at=stale)
        seed_run(self.tmp, "r-fresh", status="human_review", updated_at=fresh)

        snap = snapshot.build(self.cfg)
        runs_by_id = {r.run_id: r for c in snap.columns for r in c.runs}
        self.assertTrue(runs_by_id["r-stale"].is_stale_human_review)
        self.assertFalse(runs_by_id["r-fresh"].is_stale_human_review)

    def test_failing_tests_flag(self):
        from lib.board import snapshot

        seed_run(self.tmp, "r-fail", status="validating",
                 tests_passed=False, known_issues_count=2)
        snap = snapshot.build(self.cfg)
        r = next(iter(rr for c in snap.columns for rr in c.runs))
        self.assertTrue(r.failing_tests)
        self.assertTrue(r.has_known_issues)
        self.assertEqual(r.known_issues_count, 2)

    def test_builder_gave_up(self):
        from lib.board import snapshot

        seed_run(self.tmp, "r-stop", status="validating",
                 build_iterations=5, build_exit_reason="max_iterations")
        snap = snapshot.build(self.cfg)
        r = next(iter(rr for c in snap.columns for rr in c.runs))
        self.assertTrue(r.builder_gave_up)


class TestBuildProgress(BoardSnapshotTestBase):
    def test_build_progress_fields(self):
        from lib.board import snapshot

        seed_run(
            self.tmp, "r-build", status="building",
            build_iterations=2, build_max_iterations=5,
            build_md=True,
        )
        snap = snapshot.build(self.cfg)
        r = next(iter(rr for c in snap.columns for rr in c.runs))
        self.assertEqual(r.build_iterations, 2)
        self.assertEqual(r.build_max_iterations, 5)
        self.assertTrue(r.build_md_exists)


class TestRecentEvents(BoardSnapshotTestBase):
    def test_recent_events_newest_first(self):
        from lib.board import snapshot

        rd = seed_run(self.tmp, "r-evt", status="building")
        now = dt.datetime.now().astimezone()
        append_event(rd, base_event(
            1, "r-evt", "TransitionApplied",
            status="building",
            at=now - dt.timedelta(seconds=30),
            extra={"from": "ready", "to": "building"},
        ))
        append_event(rd, base_event(
            2, "r-evt", "ArtifactWritten",
            status="building",
            at=now - dt.timedelta(seconds=10),
            payload={"artifact_key": "implementation_summary",
                     "path": "/tmp/r-evt/build.md"},
        ))
        append_event(rd, base_event(
            3, "r-evt", "CommandRun",
            status="building",
            at=now - dt.timedelta(seconds=5),
            payload={"command": "pytest", "cwd": "/tmp", "exit_code": 0},
        ))

        snap = snapshot.build(self.cfg, now=now)
        r = next(iter(rr for c in snap.columns for rr in c.runs))
        types = [e.type for e in r.recent_events]
        # newest first
        self.assertEqual(types[0], "CommandRun")
        self.assertEqual(types[1], "ArtifactWritten")
        # the ArtifactWritten detail names the file
        self.assertIn("build.md", r.recent_events[1].detail)

    def test_time_in_stage_from_last_transition(self):
        from lib.board import snapshot

        rd = seed_run(self.tmp, "r-stg", status="validating")
        now = dt.datetime.now().astimezone()
        append_event(rd, base_event(
            1, "r-stg", "TransitionApplied",
            status="validating",
            at=now - dt.timedelta(minutes=15),
            extra={"from": "building", "to": "validating"},
        ))
        # Another event later (artifact write) — must not reset time-in-stage.
        append_event(rd, base_event(
            2, "r-stg", "ArtifactWritten",
            status="validating",
            at=now - dt.timedelta(seconds=30),
            payload={"artifact_key": "review_report", "path": "/tmp/r-stg/review.md"},
        ))

        snap = snapshot.build(self.cfg, now=now)
        r = next(iter(rr for c in snap.columns for rr in c.runs))
        self.assertIsNotNone(r.time_in_stage_seconds)
        # ~15 minutes since the transition.
        self.assertGreaterEqual(r.time_in_stage_seconds, 14 * 60)
        self.assertLessEqual(r.time_in_stage_seconds, 16 * 60)

    def test_bounce_count_and_reason(self):
        from lib.board import snapshot

        rd = seed_run(self.tmp, "r-bnc", status="building")
        now = dt.datetime.now().astimezone()
        append_event(rd, base_event(
            1, "r-bnc", "BounceRequested",
            status="human_review",
            at=now - dt.timedelta(hours=2),
            payload={"bounce_reason": "edge cases missing"},
        ))
        append_event(rd, base_event(
            2, "r-bnc", "BounceRequested",
            status="human_review",
            at=now - dt.timedelta(minutes=10),
            payload={"bounce_reason": "tests too thin"},
        ))

        snap = snapshot.build(self.cfg, now=now)
        r = next(iter(rr for c in snap.columns for rr in c.runs))
        self.assertEqual(r.bounce_count, 2)
        self.assertEqual(r.recent_bounce_reason, "tests too thin")

    def test_recent_error_after_transition(self):
        from lib.board import snapshot

        rd = seed_run(self.tmp, "r-err", status="building")
        now = dt.datetime.now().astimezone()
        # Transition then error AFTER the transition: counts as recent.
        append_event(rd, base_event(
            1, "r-err", "TransitionApplied",
            status="building",
            at=now - dt.timedelta(minutes=10),
            extra={"from": "ready", "to": "building"},
        ))
        append_event(rd, base_event(
            2, "r-err", "ErrorRecorded",
            status="building",
            at=now - dt.timedelta(minutes=2),
            payload={"error_kind": "GitError", "message": "merge conflict"},
        ))

        snap = snapshot.build(self.cfg, now=now)
        r = next(iter(rr for c in snap.columns for rr in c.runs))
        self.assertTrue(r.has_recent_error)

    def test_error_before_transition_is_not_recent(self):
        from lib.board import snapshot

        rd = seed_run(self.tmp, "r-err2", status="building")
        now = dt.datetime.now().astimezone()
        # Error first, then transition: the transition clears "recent error".
        append_event(rd, base_event(
            1, "r-err2", "ErrorRecorded",
            status="ready",
            at=now - dt.timedelta(hours=2),
            payload={"error_kind": "X", "message": "y"},
        ))
        append_event(rd, base_event(
            2, "r-err2", "TransitionApplied",
            status="building",
            at=now - dt.timedelta(hours=1),
            extra={"from": "ready", "to": "building"},
        ))

        snap = snapshot.build(self.cfg, now=now)
        r = next(iter(rr for c in snap.columns for rr in c.runs))
        self.assertFalse(r.has_recent_error)


class TestFollowupsCount(BoardSnapshotTestBase):
    def test_followups_count_from_event(self):
        from lib.board import snapshot

        rd = seed_run(self.tmp, "r-fu", status="followups")
        now = dt.datetime.now().astimezone()
        append_event(rd, base_event(
            1, "r-fu", "FollowupsRecorded",
            status="followups",
            at=now - dt.timedelta(minutes=2),
            payload={
                "followups_path": "/tmp/r-fu/follow-ups.md",
                "entry_count": 4,
                "categories": ["bug_risk", "docs"],
            },
        ))

        snap = snapshot.build(self.cfg, now=now)
        r = next(iter(rr for c in snap.columns for rr in c.runs))
        self.assertEqual(r.followups_entry_count, 4)


class TestMalformedRunSkipped(BoardSnapshotTestBase):
    def test_bad_metadata_yaml_skipped(self):
        from lib.board import snapshot

        seed_run(self.tmp, "r-good", status="building")
        bad = self.tmp / "runs" / "r-bad"
        bad.mkdir(parents=True)
        (bad / "metadata.yaml").write_text("not: [valid: yaml")

        snap = snapshot.build(self.cfg)
        ids = {r.run_id for c in snap.columns for r in c.runs}
        self.assertIn("r-good", ids)
        self.assertNotIn("r-bad", ids)


class TestScopeAndIdentity(BoardSnapshotTestBase):
    def test_scope_kind_passthrough(self):
        from lib.board import snapshot

        seed_run(self.tmp, "r-scope", status="building", scope_kind="bootstrap")
        snap = snapshot.build(self.cfg)
        r = next(iter(rr for c in snap.columns for rr in c.runs))
        self.assertEqual(r.scope_kind, "bootstrap")

    def test_repo_path_tail(self):
        from lib.board import snapshot

        seed_run(
            self.tmp, "r-path", status="building",
            repo_path="/Users/tim/code/parent/repo-x", repo_name="repo-x",
        )
        snap = snapshot.build(self.cfg)
        r = next(iter(rr for c in snap.columns for rr in c.runs))
        self.assertEqual(r.repo_path_tail, "parent/repo-x")

    def test_repo_path_tail_short_path(self):
        from lib.board.source import _repo_path_tail
        self.assertEqual(_repo_path_tail(""), "")
        self.assertEqual(_repo_path_tail("/abc"), "abc")
        self.assertEqual(_repo_path_tail("/a/b/c"), "b/c")


class TestLiveSignal(BoardSnapshotTestBase):
    def test_live_signal_cases(self):
        """Three is_live branches share the same seed-then-assert shape;
        each case differs only in event age (or absence). Folded into one
        test so a single fixture pass exercises all three."""
        from lib.board import snapshot

        now = dt.datetime.now().astimezone()
        # Each case: (run_id, event_age_or_None, expected_is_live).
        cases = [
            ("r-live", dt.timedelta(seconds=5), True),
            ("r-quiet", dt.timedelta(minutes=10), False),
            ("r-empty", None, False),
        ]
        for run_id, event_age, _expected in cases:
            rd = seed_run(self.tmp, run_id, status="building")
            if event_age is not None:
                append_event(rd, base_event(
                    1, run_id, "ArtifactWritten",
                    status="building",
                    at=now - event_age,
                    payload={"artifact_key": "build", "path": "/tmp/x/build.md"},
                ))

        snap = snapshot.build(self.cfg, now=now)
        runs_by_id = {r.run_id: r for c in snap.columns for r in c.runs}
        for run_id, _event_age, expected in cases:
            self.assertEqual(
                runs_by_id[run_id].is_live, expected, msg=run_id
            )


class TestAcceptanceCoverage(BoardSnapshotTestBase):
    AC_BODY = (
        "# build\n\n"
        "## What changed\nthings\n\n"
        "## Acceptance criteria coverage\n\n"
        "| AC | Test or justification |\n"
        "|----|-----------------------|\n"
        "| 1. foo | `test_foo` |\n"
        "| 2. bar | `test_bar` |\n"
        "| 3. baz | missing |\n\n"
        "## Deviations from plan\nnone\n"
    )

    def test_ac_coverage_cases(self):
        """Three AC-table branches in one fixture pass: full table, missing
        table with build.md present, and no build.md at all."""
        from lib.board import snapshot

        seed_run(self.tmp, "r-ac", status="validating",
                 build_md=True, build_md_body=self.AC_BODY)
        seed_run(self.tmp, "r-noac", status="validating",
                 build_md=True, build_md_body="# build\n\nno table here\n")
        seed_run(self.tmp, "r-no-build", status="validating", build_md=False)

        snap = snapshot.build(self.cfg)
        by_id = {r.run_id: r for c in snap.columns for r in c.runs}

        # Parsed AC table → ac_total/covered set, ac_table_missing False.
        self.assertEqual(by_id["r-ac"].ac_total, 3)
        self.assertEqual(by_id["r-ac"].ac_covered, 2)
        self.assertFalse(by_id["r-ac"].ac_table_missing)

        # build.md exists but lacks the AC table → flag set, totals None.
        self.assertTrue(by_id["r-noac"].ac_table_missing)
        self.assertIsNone(by_id["r-noac"].ac_total)

        # No build.md at all → not "missing" (no signal), totals None.
        self.assertFalse(by_id["r-no-build"].ac_table_missing)
        self.assertIsNone(by_id["r-no-build"].ac_total)


class TestDiffShortstat(BoardSnapshotTestBase):
    def test_diff_caches_per_run_updated_at(self):
        from lib.board import snapshot, source

        # Reset the module-level cache so test isolation is clean.
        source._DIFF_CACHE.clear()

        # Seed two runs but both will pretend to have a worktree at the
        # same path. We monkeypatch _git_shortstat to count calls.
        seed_run(
            self.tmp, "r-diff", status="building",
            worktree_created=True,
        )
        snap = snapshot.build(self.cfg)
        r = next(iter(rr for c in snap.columns for rr in c.runs))
        # /tmp/wt-wt doesn't exist; the shortstat helper short-circuits
        # to (None, None, None) without shelling out. That's fine — what
        # we're really asserting is the field type.
        self.assertIsNone(r.diff_added)
        self.assertIsNone(r.diff_removed)
        self.assertIsNone(r.diff_files)

    def test_parse_shortstat(self):
        from lib.board.source import _parse_shortstat
        self.assertEqual(
            _parse_shortstat(" 11 files changed, 940 insertions(+), 3 deletions(-)"),
            (940, 3, 11),
        )
        self.assertEqual(_parse_shortstat(""), (0, 0, 0))
        # No deletions reported (delete-only diffs report 0 too).
        self.assertEqual(
            _parse_shortstat(" 1 file changed, 2 insertions(+)"),
            (2, 0, 1),
        )


class TestIterationTiming(BoardSnapshotTestBase):
    def test_avg_iteration_seconds(self):
        from lib.board import snapshot

        rd = seed_run(self.tmp, "r-iter", status="building")
        now = dt.datetime.now().astimezone()
        append_event(rd, base_event(
            1, "r-iter", "TransitionApplied",
            status="building",
            at=now - dt.timedelta(minutes=30),
            extra={"from": "ready", "to": "building"},
        ))
        append_event(rd, base_event(
            2, "r-iter", "TransitionApplied",
            status="building",
            at=now - dt.timedelta(minutes=20),
            extra={"from": "human_review", "to": "building"},
        ))
        append_event(rd, base_event(
            3, "r-iter", "TransitionApplied",
            status="building",
            at=now - dt.timedelta(minutes=5),
            extra={"from": "human_review", "to": "building"},
        ))
        snap = snapshot.build(self.cfg, now=now)
        r = next(iter(rr for c in snap.columns for rr in c.runs))
        # Two gaps: 10 min and 15 min → 12.5 min avg.
        self.assertIsNotNone(r.avg_iteration_seconds)
        self.assertGreaterEqual(r.avg_iteration_seconds, 12 * 60)
        self.assertLessEqual(r.avg_iteration_seconds, 13 * 60)

    def test_avg_iteration_none_with_single_start(self):
        from lib.board import snapshot

        rd = seed_run(self.tmp, "r-once", status="building")
        now = dt.datetime.now().astimezone()
        append_event(rd, base_event(
            1, "r-once", "TransitionApplied",
            status="building",
            at=now - dt.timedelta(minutes=10),
            extra={"from": "ready", "to": "building"},
        ))
        snap = snapshot.build(self.cfg, now=now)
        r = next(iter(rr for c in snap.columns for rr in c.runs))
        self.assertIsNone(r.avg_iteration_seconds)


class TestBounceOrigin(BoardSnapshotTestBase):
    def test_bounced_from_when_latest_transition_is_bounce(self):
        from lib.board import snapshot

        rd = seed_run(self.tmp, "r-bnc", status="building")
        now = dt.datetime.now().astimezone()
        append_event(rd, base_event(
            1, "r-bnc", "TransitionApplied",
            status="building",
            at=now - dt.timedelta(hours=2),
            extra={"from": "ready", "to": "building"},
        ))
        append_event(rd, base_event(
            2, "r-bnc", "TransitionApplied",
            status="building",
            at=now - dt.timedelta(minutes=12),
            extra={"from": "human_review", "to": "building"},
        ))
        snap = snapshot.build(self.cfg, now=now)
        r = next(iter(rr for c in snap.columns for rr in c.runs))
        self.assertEqual(r.bounced_from, "human_review")
        self.assertIsNotNone(r.bounced_at_age_seconds)
        self.assertGreaterEqual(r.bounced_at_age_seconds, 11 * 60)

    def test_no_bounce_when_initial_entry(self):
        from lib.board import snapshot

        rd = seed_run(self.tmp, "r-fresh", status="building")
        now = dt.datetime.now().astimezone()
        append_event(rd, base_event(
            1, "r-fresh", "TransitionApplied",
            status="building",
            at=now - dt.timedelta(minutes=5),
            extra={"from": "ready", "to": "building"},
        ))
        snap = snapshot.build(self.cfg, now=now)
        r = next(iter(rr for c in snap.columns for rr in c.runs))
        self.assertIsNone(r.bounced_from)


class TestFollowupsCategories(BoardSnapshotTestBase):
    def test_followups_categories_counts(self):
        from lib.board import snapshot

        rd = seed_run(self.tmp, "r-cats", status="followups")
        now = dt.datetime.now().astimezone()
        append_event(rd, base_event(
            1, "r-cats", "FollowupsRecorded",
            status="followups",
            at=now - dt.timedelta(minutes=1),
            payload={
                "followups_path": "/tmp/x/follow-ups.md",
                "entry_count": 5,
                "categories": [
                    "scope_extension", "scope_extension",
                    "bug_risk", "tech_debt", "tech_debt",
                ],
            },
        ))
        snap = snapshot.build(self.cfg, now=now)
        r = next(iter(rr for c in snap.columns for rr in c.runs))
        # Highest count first, alphabetical tiebreak.
        self.assertEqual(
            r.followups_categories,
            (
                ("scope_extension", 2),
                ("tech_debt", 2),
                ("bug_risk", 1),
            ),
        )

    def test_followups_categories_empty_when_no_event(self):
        from lib.board import snapshot

        seed_run(self.tmp, "r-noflw", status="followups")
        snap = snapshot.build(self.cfg)
        r = next(iter(rr for c in snap.columns for rr in c.runs))
        self.assertEqual(r.followups_categories, ())


class TestTestsRecordedAge(BoardSnapshotTestBase):
    def test_tests_age_from_qa_completed(self):
        from lib.board import snapshot

        rd = seed_run(self.tmp, "r-qa", status="validating", tests_passed=True)
        now = dt.datetime.now().astimezone()
        append_event(rd, base_event(
            1, "r-qa", "QACompleted",
            status="validating",
            at=now - dt.timedelta(minutes=2),
            payload={"tests_passed": True, "known_issues_count": 0,
                     "qa_report_path": "/tmp/x/qa/report.md"},
        ))
        snap = snapshot.build(self.cfg, now=now)
        r = next(iter(rr for c in snap.columns for rr in c.runs))
        self.assertIsNotNone(r.tests_recorded_age_seconds)
        self.assertGreaterEqual(r.tests_recorded_age_seconds, 110)
        self.assertLessEqual(r.tests_recorded_age_seconds, 130)


class TestWorktreeMissingFlag(BoardSnapshotTestBase):
    def test_worktree_missing_by_status(self):
        """Flag fires for `building` runs without a worktree; stays off for
        pre-`building` runs (which haven't created one yet)."""
        from lib.board import snapshot

        seed_run(self.tmp, "r-wt", status="building", worktree_created=False)
        seed_run(self.tmp, "r-draft", status="draft", worktree_created=False)

        snap = snapshot.build(self.cfg)
        by_id = {r.run_id: r for c in snap.columns for r in c.runs}

        self.assertTrue(by_id["r-wt"].worktree_missing)
        self.assertFalse(by_id["r-draft"].worktree_missing)


class TestCompletionPassthrough(BoardSnapshotTestBase):
    def test_done_card_completion_fields(self):
        from lib.board import snapshot

        when = dt.datetime.now().astimezone() - dt.timedelta(hours=1)
        seed_run(
            self.tmp, "r-done", status="done",
            accepted_by="tim", completed_at=when,
        )
        snap = snapshot.build(self.cfg, show_all=True)
        r = next(iter(rr for c in snap.columns for rr in c.runs))
        self.assertEqual(r.accepted_by, "tim")
        self.assertIsNotNone(r.completed_at)

    def test_abandoned_reason(self):
        from lib.board import snapshot

        seed_run(
            self.tmp, "r-aban", status="abandoned",
            abandoned_reason="scope creep",
        )
        snap = snapshot.build(self.cfg, show_all=True)
        r = next(iter(rr for c in snap.columns for rr in c.runs))
        self.assertEqual(r.abandoned_reason, "scope creep")

    def test_completion_ref_passthrough(self):
        """RunSnapshot.completion_ref carries the raw label from metadata."""
        from lib.board import snapshot

        when = dt.datetime.now().astimezone() - dt.timedelta(hours=1)
        seed_run(
            self.tmp, "r-merged", status="done",
            accepted_by="tim", completed_at=when,
            completion_ref="merge:c6357454fb79562e504071ef59503f768af1283c",
        )
        snap = snapshot.build(self.cfg, show_all=True)
        r = next(iter(rr for c in snap.columns for rr in c.runs))
        self.assertEqual(
            r.completion_ref,
            "merge:c6357454fb79562e504071ef59503f768af1283c",
        )


class TestUnmergedBadge(BoardSnapshotTestBase):
    """`done` runs with `local-branch:` completion_refs get a warning badge."""

    def _render_details(self, run_id: str):
        from lib.board import app as board_app
        from lib.board import snapshot

        snap = snapshot.build(self.cfg, show_all=True)
        run = next(
            r for c in snap.columns for r in c.runs if r.run_id == run_id
        )
        return list(board_app._status_body(run))

    def test_local_branch_completion_ref_renders_warning(self):
        when = dt.datetime.now().astimezone() - dt.timedelta(hours=2)
        seed_run(
            self.tmp, "r-legacy", status="done",
            accepted_by="tim", completed_at=when,
            completion_ref="local-branch:agent/legacy-run",
        )
        details = self._render_details("r-legacy")
        # The accepted_by line is still present...
        self.assertTrue(any("accepted_by tim" in d for d in details), details)
        # ... and the unmerged warning is appended.
        self.assertTrue(
            any("unmerged" in d for d in details),
            f"expected unmerged warning in {details}",
        )

    def test_merge_completion_ref_does_not_warn(self):
        when = dt.datetime.now().astimezone() - dt.timedelta(hours=2)
        seed_run(
            self.tmp, "r-merged", status="done",
            accepted_by="tim", completed_at=when,
            completion_ref="merge:c6357454fb79562e504071ef59503f768af1283c",
        )
        details = self._render_details("r-merged")
        self.assertFalse(
            any("unmerged" in d for d in details),
            f"merge: completion_ref should not warn; got {details}",
        )

    def test_null_completion_ref_does_not_warn(self):
        """Legacy fixture without completion_ref should not crash or warn."""
        when = dt.datetime.now().astimezone() - dt.timedelta(hours=2)
        seed_run(
            self.tmp, "r-null", status="done",
            accepted_by="tim", completed_at=when,
            completion_ref=None,
        )
        details = self._render_details("r-null")
        self.assertFalse(any("unmerged" in d for d in details), details)


class TestFormatAge(unittest.TestCase):
    def test_buckets(self):
        from lib.board.snapshot import format_age
        self.assertEqual(format_age(0), "0m")
        self.assertEqual(format_age(59), "0m")
        self.assertEqual(format_age(90), "1m")
        self.assertEqual(format_age(60 * 60), "1h")
        self.assertEqual(format_age(2 * 60 * 60), "2h")
        self.assertEqual(format_age(25 * 60 * 60), "1d")
        self.assertEqual(format_age(48 * 60 * 60), "2d")


class TestGitShortstatPrefersSha(unittest.TestCase):
    """2b regression: _git_shortstat must prefer base_ref_sha over the
    symbolic base_ref so the shortstat numbers reflect the real diff range,
    not a HEAD-vs-HEAD null."""

    def setUp(self):
        import subprocess
        import tempfile
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="aw-shortstat-"))
        # Build a tiny repo: initial commit, capture SHA, then add two
        # commits with measurable line changes.

        def _git(*args):
            return subprocess.run(
                ["git", "-C", str(self.tmp), *args],
                capture_output=True, text=True, check=True,
            ).stdout

        _git("init", "-q")
        _git("config", "user.email", "t@e.x")
        _git("config", "user.name", "test")
        (self.tmp / "README.md").write_text("# repo\n")
        _git("add", "README.md")
        _git("commit", "-qm", "init")
        self.fork_sha = _git("rev-parse", "HEAD").strip()
        # Two real commits: 3 lines added in file_a, 2 lines in file_b.
        (self.tmp / "file_a.py").write_text("a = 1\nb = 2\nc = 3\n")
        _git("add", "file_a.py")
        _git("commit", "-qm", "add a")
        (self.tmp / "file_b.py").write_text("x = 9\ny = 8\n")
        _git("add", "file_b.py")
        _git("commit", "-qm", "add b")
        # Reset the module-level cache so back-to-back calls don't see stale
        # results.
        from lib.board import source
        source._DIFF_CACHE.clear()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)
        from lib.board import source
        source._DIFF_CACHE.clear()

    def test_with_sha_reports_real_counts(self):
        from lib.board import source
        added, removed, files = source._git_shortstat(
            str(self.tmp), "HEAD",
            cache_key=("test-with-sha", "0"),
            base_ref_sha=self.fork_sha,
        )
        # 5 added lines across 2 new files; 0 removed.
        self.assertEqual(added, 5)
        self.assertEqual(removed, 0)
        self.assertEqual(files, 2)

    def test_without_sha_is_empty(self):
        """With base_ref='HEAD' alone the diff is HEAD...HEAD → zero counts."""
        from lib.board import source
        added, removed, files = source._git_shortstat(
            str(self.tmp), "HEAD",
            cache_key=("test-no-sha", "0"),
        )
        # All zero (or None — `_parse_shortstat` returns 0/0/0 for empty
        # stdout per its first branch).
        self.assertEqual((added, removed, files), (0, 0, 0))

    def test_sha_takes_precedence_over_symbolic_branch(self):
        """Even when base_ref points to a real ref ('HEAD'), the SHA wins."""
        from lib.board import source
        added_a, _, _ = source._git_shortstat(
            str(self.tmp), "HEAD",
            cache_key=("test-precedence", "0"),
            base_ref_sha=self.fork_sha,
        )
        # Same range exercised in test_with_sha — must produce identical count.
        self.assertEqual(added_a, 5)


if __name__ == "__main__":
    unittest.main()
