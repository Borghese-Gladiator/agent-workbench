"""End-to-end tests (TODO §1).

Drive a run from `new-run` through to a terminal state using the
`AGENT_WORKBENCH_STUB_LLM` env-var mode. The slash command bodies stay
unchanged; the CLI's `--init` step copies fixture artifacts from
`tests/fixtures/e2e/<scenario>/` in place of an LLM authoring them.

Three scenarios live here:

  TestE2EHappyPath   — new-run → ... → complete, no bounce.
  TestE2EBounceLoop  — happy path, then bounce, then re-validate, complete.
  TestE2EAbandon     — abandon at several non-terminal states.

Adding a new scenario is documented in `tests/README.md`.
"""
from __future__ import annotations

import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

from tests._helpers import make_tmp_workbench, cleanup, reset_caches  # noqa: F401

ROOT = pathlib.Path(__file__).resolve().parent.parent
CLI = ROOT / "bin" / "agent-workbench"
FIXTURES = pathlib.Path(__file__).resolve().parent / "fixtures" / "e2e"


def cli(workbench_root: pathlib.Path, *args, stub_fixture: pathlib.Path | None = None,
        input_text: str | None = None) -> subprocess.CompletedProcess:
    """Run the CLI as a subprocess, optionally with a stub-LLM fixture dir."""
    env = os.environ.copy()
    env["AGENT_WORKBENCH_ROOT"] = str(workbench_root)
    if stub_fixture is not None:
        env["AGENT_WORKBENCH_STUB_LLM"] = str(stub_fixture)
    else:
        env.pop("AGENT_WORKBENCH_STUB_LLM", None)
    return subprocess.run(
        [sys.executable, str(CLI), "--root", str(workbench_root), *args],
        capture_output=True, text=True, env=env,
        input=input_text,
    )


def make_throwaway_repo() -> pathlib.Path:
    repo = pathlib.Path(tempfile.mkdtemp(prefix="aw-e2e-repo-"))
    subprocess.run(["git", "-C", str(repo), "init", "-q", "-b", "main"], check=True)
    # Drop a bin/cli stub so the fixture's `Files likely to change` claim
    # against bin/cli has a target. The committed bin/cli is empty; the
    # building stage's fixture will mutate the file in the worktree.
    (repo / "bin").mkdir()
    (repo / "bin" / "cli").write_text("#!/usr/bin/env bash\n# stub\n")
    (repo / "bin" / "cli").chmod(0o755)
    subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
    subprocess.run([
        "git", "-C", str(repo),
        "-c", "user.name=test", "-c", "user.email=test@x",
        "commit", "-q", "-m", "init",
    ], check=True)
    return repo


def read_events(run_dir: pathlib.Path) -> list[dict]:
    path = run_dir / "events.jsonl"
    if not path.exists():
        return []
    out: list[dict] = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        out.append(json.loads(line))
    return out


def event_types(events_: list[dict]) -> list[str]:
    return [e["type"] for e in events_]


def transitions_seen(events_: list[dict]) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for e in events_:
        if e.get("type") != "TransitionApplied":
            continue
        out.append((e.get("from"), e.get("to")))
    return out


def _meta(run_dir: pathlib.Path) -> dict:
    """Parse runs/<id>/metadata.yaml. Cheap-and-cheerful for test asserts."""
    import sys as _sys
    # Workbench root is two levels up from this file (tests/ -> agent-workbench-live/).
    aw_root = pathlib.Path(__file__).resolve().parent.parent
    if str(aw_root) not in _sys.path:
        _sys.path.insert(0, str(aw_root))
    from lib import yaml_io
    return yaml_io.loads((run_dir / "metadata.yaml").read_text())


class E2ECase(unittest.TestCase):
    """Base class: spins up a workbench root + a throwaway repo per test."""

    def setUp(self):
        self.tmp = make_tmp_workbench()
        # Copy bin/ + lib/ so the CLI can import from sys.path.
        shutil.copytree(ROOT / "bin", self.tmp / "bin")
        shutil.copytree(ROOT / "lib", self.tmp / "lib")
        self.repos: list[pathlib.Path] = []

    def tearDown(self):
        cleanup(self.tmp)
        for r in self.repos:
            cleanup(r)

    def _repo(self) -> pathlib.Path:
        r = make_throwaway_repo()
        self.repos.append(r)
        return r

    def _new_run(self, fixture: pathlib.Path, slug: str = "e2e-smoke") -> tuple[str, pathlib.Path, pathlib.Path]:
        """Create a run from `fixture/raw-idea.md`. Returns (run_id, run_dir, repo)."""
        repo = self._repo()
        idea = fixture / "raw-idea.md"
        self.assertTrue(idea.exists(), f"fixture missing raw-idea.md: {idea}")
        r = cli(
            self.tmp, "new-run",
            "--repo-path", str(repo),
            "--worktree-name", slug,
            "--base-ref", "main",
            "--idea-file", str(idea),
        )
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        run_id = r.stdout.strip()
        return run_id, self.tmp / "runs" / run_id, repo


class TestE2EHappyPath(E2ECase):
    """new-run → shape → plan → start → validate → followups → complete."""

    def test_happy_path(self):
        fixture = FIXTURES / "happy"
        run_id, run_dir, repo = self._new_run(fixture, slug="happy-smoke")

        # draft (no clarifications), then shape --init + finalize with stub-LLM on.
        r = cli(self.tmp, "draft", run_id, stub_fixture=fixture)
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        r = cli(self.tmp, "shape", run_id, "--init", stub_fixture=fixture)
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        self.assertTrue((run_dir / "brief.md").exists())
        # Confirm the fixture's content actually landed (not the template).
        self.assertIn("Hello command", (run_dir / "brief.md").read_text())

        r = cli(self.tmp, "shape", run_id, stub_fixture=fixture)
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        self.assertIn("shaping -> planning", r.stdout)
        # TODO §2: shape lands at planning, an agent-driven state. No banner.
        self.assertNotIn("STOP.", r.stdout)

        # plan --init + finalize.
        r = cli(self.tmp, "plan", run_id, "--init", stub_fixture=fixture)
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        self.assertIn("Hello command", (run_dir / "plan.md").read_text())
        # plan --init does not transition; no banner.
        self.assertNotIn("STOP.", r.stdout)

        # Pre-condition: no banner file yet at the planning stage dir.
        planning_banner = run_dir / "stages" / "3_planning" / "stop-banner.txt"
        self.assertFalse(planning_banner.exists())

        r = cli(self.tmp, "plan", run_id, stub_fixture=fixture)
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        self.assertIn("planning -> ready", r.stdout)
        # TODO §2: planning -> ready is agent-stopping. STOP banner expected.
        self.assertIn("STOP. State: ready (human-owned).", r.stdout)
        # Durable on-disk copy of the banner lives in the producing stage's dir.
        self.assertTrue(planning_banner.exists(),
                        msg=f"expected banner file at {planning_banner}")
        banner_text = planning_banner.read_text()
        self.assertIn("STOP. State: ready (human-owned).", banner_text)
        self.assertIn(f"/start {run_id}", banner_text)

        # start (no LLM).
        r = cli(self.tmp, "start", run_id, "--approved-by", "e2e-tester",
                stub_fixture=fixture)
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        self.assertIn("ready -> building", r.stdout)
        # start lands at building, agent-driven. No banner.
        self.assertNotIn("STOP.", r.stdout)
        # TODO §1: /start writes build-context.md to stages/4_building/ as the
        # curated entry point for the building agent. The file must exist and
        # carry the load-bearing section headings; absent or empty is a regression.
        build_ctx = run_dir / "stages" / "4_building" / "build-context.md"
        self.assertTrue(build_ctx.exists(),
                        f"build-context.md not written at {build_ctx}")
        ctx_body = build_ctx.read_text()
        for header in (
            "# build-context.md",
            "## Acceptance criteria",
            "## Non-goals",
            "## Worktree",
            "## Rules",
        ):
            self.assertIn(header, ctx_body,
                          f"build-context.md missing section: {header}")

        # 2d: /start should have emitted exactly one BaseRefResolved event,
        # with the SHA matching the value just written to metadata, and it
        # should sit before the ready->building transition in the audit log.
        evs = read_events(run_dir)
        base_ref_events = [e for e in evs if e["type"] == "BaseRefResolved"]
        self.assertEqual(len(base_ref_events), 1, [e["type"] for e in evs])
        meta = _meta(run_dir)
        recorded_sha = meta["target"]["repo"]["base_ref_sha"]
        recorded_symbolic = meta["target"]["repo"]["base_ref"]
        self.assertEqual(base_ref_events[0]["payload"]["base_ref_sha"], recorded_sha)
        self.assertEqual(base_ref_events[0]["payload"]["symbolic_ref"], recorded_symbolic)
        # Sequence ordering: BaseRefResolved comes before ready->building.
        trans = [e for e in evs if e["type"] == "TransitionApplied"
                 and e.get("from") == "ready" and e.get("to") == "building"]
        self.assertTrue(trans, "expected ready->building transition event")
        self.assertLess(base_ref_events[0]["seq"], trans[0]["seq"])

        # validate --init: materializes build.md + validating fixtures.
        r = cli(self.tmp, "validate", run_id, "--init", stub_fixture=fixture)
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        self.assertIn("building -> validating", r.stdout)
        # validate --init lands at validating, agent-driven. No banner.
        self.assertNotIn("STOP.", r.stdout)
        # build.md got moved into stages/4_building/ by the transition engine.
        self.assertTrue((run_dir / "stages" / "4_building" / "build.md").exists())
        # TODO §1 cross-stage contract: build-context.md written by /start
        # must survive the building -> validating transition, AND validate
        # --init must write validate-context.md as the next stage's curated
        # entry. Both curated files must coexist in their respective stage dirs.
        self.assertTrue(
            (run_dir / "stages" / "4_building" / "build-context.md").exists(),
            "build-context.md disappeared from stages/4_building/ across the "
            "building -> validating transition",
        )
        self.assertTrue(
            (run_dir / "stages" / "5_validating" / "validate-context.md").exists(),
            "validate-context.md not written to stages/5_validating/ by "
            "validate --init",
        )
        # validating-stage templates were overwritten by the fixtures.
        self.assertIn("approve", (run_dir / "review.md").read_text().lower())

        # validate finalize: validating -> followups.
        r = cli(self.tmp, "validate", run_id,
                "--tests-passed", "true", "--known-issues", "0",
                stub_fixture=fixture)
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        self.assertIn("validating -> followups", r.stdout)
        # validate (staged) lands at followups, still agent-driven. No banner.
        self.assertNotIn("STOP.", r.stdout)
        self.assertTrue((run_dir / "audit.md").exists())
        # 2d: audit.md should surface the BaseRefResolved event so line counts
        # can be re-derived from the audit log alone.
        audit_text = (run_dir / "audit.md").read_text()
        self.assertIn("BaseRefResolved", audit_text)
        # The summary line includes the symbolic ref → 12-char sha prefix.
        recorded_sha_prefix = _meta(run_dir)["target"]["repo"]["base_ref_sha"][:12]
        self.assertIn(recorded_sha_prefix, audit_text)

        # followups default mode: materializes follow-ups.md + transitions.
        followups_banner = run_dir / "stages" / "6_followups" / "stop-banner.txt"
        self.assertFalse(followups_banner.exists())

        r = cli(self.tmp, "followups", run_id, stub_fixture=fixture)
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        self.assertIn("followups -> human_review", r.stdout)
        # Durable on-disk copy of the human_review banner.
        self.assertTrue(followups_banner.exists(),
                        msg=f"expected banner file at {followups_banner}")
        followups_banner_text = followups_banner.read_text()
        self.assertIn("STOP. State: human_review (human-owned).", followups_banner_text)
        self.assertIn(f"/complete {run_id}", followups_banner_text)
        # File content matches stdout (modulo print()'s trailing newline).
        self.assertIn(followups_banner_text.rstrip("\n"), r.stdout)
        # TODO §2 AC2: the absolute path to HUMAN_REVIEW.md must appear in
        # stdout so the reviewer can click it from the terminal.
        self.assertIn(str(run_dir / "HUMAN_REVIEW.md"), r.stdout)
        # TODO §2: followups -> human_review is agent-stopping. STOP banner expected.
        self.assertIn("STOP. State: human_review (human-owned).", r.stdout)
        # TODO §2: structured five-section body must be present and ordered.
        for section in (
            "Review:",
            "Summary of changes",
            "Summary of testing",
            "Diffstat:",
            "Next moves (human-triggered, type in a session):",
        ):
            self.assertIn(section, r.stdout, msg=f"missing section: {section}")
        positions = [r.stdout.index(s) for s in (
            "Review:", "Summary of changes", "Summary of testing",
            "Diffstat:", "Next moves (human-triggered, type in a session):",
        )]
        self.assertEqual(positions, sorted(positions),
                         msg=f"banner sections out of order: {positions}")
        # Three slash-form Next moves lines.
        self.assertIn(f"/complete {run_id}", r.stdout)
        self.assertIn(f"/bounce {run_id}", r.stdout)
        self.assertIn(f"/abandon {run_id}", r.stdout)
        # Shell-form must be gone from the banner.
        self.assertNotIn("agent-workbench complete", r.stdout)
        self.assertNotIn("agent-workbench bounce", r.stdout)
        self.assertNotIn("agent-workbench abandon", r.stdout)

        # Make a real commit on the worktree branch so the merge has something
        # to integrate. The fixture-driven happy path doesn't otherwise touch
        # the worktree's checkout, so the branch would point at the same
        # commit as main and `git merge --no-ff` would still create a merge
        # commit — but a real change makes the assertion meaningful.
        wt_path = pathlib.Path(_meta(run_dir)["target"]["worktree"]["path"])
        (wt_path / "feature.txt").write_text("hello from feature\n")
        subprocess.run(["git", "-C", str(wt_path), "add", "feature.txt"], check=True)
        subprocess.run(
            ["git", "-C", str(wt_path),
             "-c", "user.email=feat@x", "-c", "user.name=feat",
             "commit", "-q", "-m", "add feature.txt"],
            check=True,
        )

        # complete — now also performs the merge.
        done_banner = run_dir / "stop-banner.txt"
        self.assertFalse(done_banner.exists())

        r = cli(self.tmp, "complete", run_id, "--accepted-by", "e2e-tester")
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        self.assertIn("human_review -> done", r.stdout)
        # TODO §2: human_review -> done is terminal. STOP banner expected.
        self.assertIn("STOP. State: done (terminal).", r.stdout)
        # Terminal banner lives at the run root (no producing stage dir).
        self.assertTrue(done_banner.exists(),
                        msg=f"expected banner file at {done_banner}")
        self.assertIn("STOP. State: done (terminal).", done_banner.read_text())
        # Auto-merge: completion_ref is now a real SHA, not a label.
        import re
        m = re.search(r"completion_ref:\s+merge:([0-9a-f]{40})", r.stdout)
        self.assertIsNotNone(m, msg=f"expected merge:<sha> in stdout: {r.stdout}")
        merge_sha = m.group(1)
        # The merge SHA lives on main now.
        log_merges = subprocess.run(
            ["git", "-C", str(repo), "log", "--merges", "--pretty=%H", "main"],
            capture_output=True, text=True, check=True,
        ).stdout.split()
        self.assertIn(merge_sha, log_merges)
        # feature.txt is reachable from main.
        in_main = subprocess.run(
            ["git", "-C", str(repo), "cat-file", "-e", f"main:feature.txt"],
            capture_output=True,
        )
        self.assertEqual(in_main.returncode, 0)

        # Worktree + branch cleaned up by /complete after successful merge.
        self.assertFalse(wt_path.exists(),
                         msg=f"worktree still exists at {wt_path}")
        branch_name = _meta(run_dir)["target"]["worktree"]["branch_name"]
        branch_ref = subprocess.run(
            ["git", "-C", str(repo),
             "show-ref", "--verify", "--quiet", f"refs/heads/{branch_name}"],
            capture_output=True,
        )
        self.assertNotEqual(branch_ref.returncode, 0,
                            msg=f"branch {branch_name} still exists after complete")
        # `git worktree list` should not mention the removed path.
        wt_listing = subprocess.run(
            ["git", "-C", str(repo), "worktree", "list", "--porcelain"],
            capture_output=True, text=True, check=True,
        ).stdout
        self.assertNotIn(str(wt_path), wt_listing)
        # Confirmation line shows up in stdout.
        self.assertIn(f"removed worktree {wt_path} and branch {branch_name}",
                      r.stdout)

        # Final state: every stage-promoted artifact is in place.
        self.assertTrue((run_dir / "stages" / "2_shaping" / "brief.md").exists())
        self.assertTrue((run_dir / "stages" / "3_planning" / "plan.md").exists())
        self.assertTrue((run_dir / "stages" / "4_building" / "build.md").exists())
        self.assertTrue((run_dir / "stages" / "5_validating" / "review.md").exists())
        self.assertTrue((run_dir / "stages" / "5_validating" / "qa" / "report.md").exists())
        self.assertTrue((run_dir / "stages" / "6_followups" / "follow-ups.md").exists())
        self.assertTrue((run_dir / "HUMAN_REVIEW.md").exists())

        # Event ordering: every staged transition fired in order.
        evs = read_events(run_dir)
        self.assertEqual(
            transitions_seen(evs),
            [
                ("draft", "shaping"),
                ("shaping", "planning"),
                ("planning", "ready"),
                ("ready", "building"),
                ("building", "validating"),
                ("validating", "followups"),
                ("followups", "human_review"),
                ("human_review", "done"),
            ],
        )
        # Key non-transition events all show up — including WorktreeMerged.
        types = event_types(evs)
        for required in ("RunCreated", "PreflightCompleted", "ReviewCompleted",
                         "QACompleted", "AuditRendered", "FollowupsRecorded",
                         "HumanHandoffCreated", "WorktreeMerged"):
            self.assertIn(required, types, msg=f"missing event: {required}")
        # The WorktreeMerged payload carries the merge SHA.
        merged_evs = [e for e in evs if e["type"] == "WorktreeMerged"]
        self.assertEqual(len(merged_evs), 1)
        self.assertEqual(merged_evs[0]["payload"]["merge_sha"], merge_sha)
        self.assertEqual(merged_evs[0]["payload"]["merge_strategy"], "no-ff")


class TestE2EBounceLoop(E2ECase):
    """Drive the happy path, then bounce back to building, then complete."""

    def test_bounce_loop(self):
        fix1 = FIXTURES / "bounce_pass1"
        fix2 = FIXTURES / "bounce_pass2"
        run_id, run_dir, repo = self._new_run(fix1, slug="bounce-smoke")

        # Drive pass 1 with the pass-1 fixture set (review.md says
        # request_changes; reviewer would normally bounce after, but our
        # CLI doesn't fail validate on a request_changes review — that's
        # an upstream policy question, not a state-machine gate). We
        # finalize through to human_review so we can then exercise bounce.
        cli(self.tmp, "draft", run_id, stub_fixture=fix1)
        cli(self.tmp, "shape", run_id, "--init", stub_fixture=fix1)
        cli(self.tmp, "shape", run_id, stub_fixture=fix1)
        cli(self.tmp, "plan", run_id, "--init", stub_fixture=fix1)
        cli(self.tmp, "plan", run_id, stub_fixture=fix1)
        cli(self.tmp, "start", run_id, "--approved-by", "tester")
        cli(self.tmp, "validate", run_id, "--init", stub_fixture=fix1)
        # known-issues=1 so the validation block records the v1 gap.
        cli(self.tmp, "validate", run_id, "--tests-passed", "false",
            "--known-issues", "1", stub_fixture=fix1)
        cli(self.tmp, "followups", run_id, stub_fixture=fix1)

        # Now bounce back to building.
        r = cli(self.tmp, "bounce", run_id,
                "--reason", "AC-1 not covered",
                "--requested-by", "tester")
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        self.assertIn("human_review -> building", r.stdout)

        # Pass-1 building/validating outputs should be archived as -v1.
        self.assertTrue((run_dir / "archive" / "4_building" / "build-v1.md").exists())
        self.assertTrue((run_dir / "archive" / "5_validating" / "review-v1.md").exists())

        # Drive pass 2 with the pass-2 fixture set.
        cli(self.tmp, "validate", run_id, "--init", stub_fixture=fix2)
        cli(self.tmp, "validate", run_id, "--tests-passed", "true",
            "--known-issues", "0", stub_fixture=fix2)
        r = cli(self.tmp, "followups", run_id, stub_fixture=fix2)
        # TODO §2 AC2: stdout from the post-bounce followups call carries
        # the absolute HUMAN_REVIEW.md path too.
        self.assertIn(str(run_dir / "HUMAN_REVIEW.md"), r.stdout)
        # TODO §2: structured five-section body present on the bounce-pass2
        # landing too — the banner builder is shared across both call sites.
        for section in (
            "Review:",
            "Summary of changes",
            "Summary of testing",
            "Diffstat:",
            "Next moves (human-triggered, type in a session):",
        ):
            self.assertIn(section, r.stdout, msg=f"missing section: {section}")
        # Three slash-form Next moves lines.
        self.assertIn(f"/complete {run_id}", r.stdout)
        self.assertIn(f"/bounce {run_id}", r.stdout)
        self.assertIn(f"/abandon {run_id}", r.stdout)
        # Shell-form must be gone.
        self.assertNotIn("agent-workbench complete", r.stdout)
        self.assertNotIn("agent-workbench bounce", r.stdout)
        self.assertNotIn("agent-workbench abandon", r.stdout)

        # human_review -> done.
        r = cli(self.tmp, "complete", run_id, "--accepted-by", "tester")
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        self.assertIn("human_review -> done", r.stdout)

        evs = read_events(run_dir)
        # The bounce loop produces two passes through building/validating.
        ts = transitions_seen(evs)
        self.assertEqual(ts.count(("ready", "building")), 1)  # only one initial start
        self.assertEqual(ts.count(("building", "validating")), 2)
        self.assertEqual(ts.count(("validating", "followups")), 2)
        self.assertEqual(ts.count(("followups", "human_review")), 2)
        self.assertEqual(ts.count(("human_review", "building")), 1)
        self.assertEqual(ts.count(("human_review", "done")), 1)
        # BounceRequested with the reason is present.
        bounces = [e for e in evs if e["type"] == "BounceRequested"]
        self.assertEqual(len(bounces), 1)
        self.assertIn("AC-1", bounces[0]["payload"]["bounce_reason"])


class TestE2EAbandon(E2ECase):
    """Abandon at three non-terminal states to confirm `*->abandoned` works
    regardless of where the run is."""

    def test_abandon_at_shaping(self):
        fixture = FIXTURES / "happy"
        run_id, run_dir, _ = self._new_run(fixture, slug="abandon-shaping")
        cli(self.tmp, "draft", run_id, stub_fixture=fixture)
        cli(self.tmp, "shape", run_id, "--init", stub_fixture=fixture)

        r = cli(self.tmp, "abandon", run_id,
                "--reason", "scope shrank", "--abandoned-by", "tester")
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        # TODO §2: -> abandoned is terminal. STOP banner expected.
        self.assertIn("STOP. State: abandoned (terminal).", r.stdout)

        r = cli(self.tmp, "show", run_id)
        self.assertIn("status:     abandoned", r.stdout)

        evs = read_events(run_dir)
        ts = transitions_seen(evs)
        self.assertIn(("shaping", "abandoned"), ts)

    def test_abandon_at_building(self):
        fixture = FIXTURES / "happy"
        run_id, run_dir, _ = self._new_run(fixture, slug="abandon-building")
        cli(self.tmp, "draft", run_id, stub_fixture=fixture)
        cli(self.tmp, "shape", run_id, "--init", stub_fixture=fixture)
        cli(self.tmp, "shape", run_id, stub_fixture=fixture)
        cli(self.tmp, "plan", run_id, "--init", stub_fixture=fixture)
        cli(self.tmp, "plan", run_id, stub_fixture=fixture)
        cli(self.tmp, "start", run_id, "--approved-by", "tester")

        r = cli(self.tmp, "abandon", run_id,
                "--reason", "blocked on dep", "--abandoned-by", "tester")
        self.assertEqual(r.returncode, 0, msg=r.stderr)

        r = cli(self.tmp, "show", run_id)
        self.assertIn("status:     abandoned", r.stdout)

        evs = read_events(run_dir)
        ts = transitions_seen(evs)
        self.assertIn(("building", "abandoned"), ts)

    def test_abandon_at_draft(self):
        # No fixture artifacts needed: abandoning a fresh run.
        fixture = FIXTURES / "happy"
        run_id, run_dir, _ = self._new_run(fixture, slug="abandon-draft")

        r = cli(self.tmp, "abandon", run_id,
                "--reason", "duplicate idea", "--abandoned-by", "tester")
        self.assertEqual(r.returncode, 0, msg=r.stderr)

        r = cli(self.tmp, "show", run_id)
        self.assertIn("status:     abandoned", r.stdout)

        evs = read_events(run_dir)
        ts = transitions_seen(evs)
        self.assertIn(("draft", "abandoned"), ts)


class TestE2ECompleteMerge(E2ECase):
    """`complete` auto-merges; verify the failure modes (dirty / conflict)."""

    def _drive_to_human_review(self, slug: str) -> tuple[str, pathlib.Path, pathlib.Path]:
        fixture = FIXTURES / "happy"
        run_id, run_dir, repo = self._new_run(fixture, slug=slug)
        cli(self.tmp, "draft", run_id, stub_fixture=fixture)
        cli(self.tmp, "shape", run_id, "--init", stub_fixture=fixture)
        cli(self.tmp, "shape", run_id, stub_fixture=fixture)
        cli(self.tmp, "plan", run_id, "--init", stub_fixture=fixture)
        cli(self.tmp, "plan", run_id, stub_fixture=fixture)
        cli(self.tmp, "start", run_id, "--approved-by", "e2e-tester")
        cli(self.tmp, "validate", run_id, "--init", stub_fixture=fixture)
        cli(
            self.tmp, "validate", run_id,
            "--tests-passed", "true", "--known-issues", "0",
            stub_fixture=fixture,
        )
        cli(self.tmp, "followups", run_id, stub_fixture=fixture)
        return run_id, run_dir, repo

    def test_dirty_worktree_refuses(self) -> None:
        """`complete` with uncommitted changes in the worktree stays in human_review."""
        run_id, run_dir, _repo = self._drive_to_human_review("dirty-wt")
        wt_path = pathlib.Path(_meta(run_dir)["target"]["worktree"]["path"])
        # Leave an unstaged file in the worktree.
        (wt_path / "uncommitted.txt").write_text("oops\n")

        r = cli(self.tmp, "complete", run_id, "--accepted-by", "e2e-tester")
        self.assertNotEqual(r.returncode, 0, msg=r.stdout + r.stderr)
        self.assertIn("uncommitted", (r.stderr + r.stdout).lower())
        # Status still human_review.
        self.assertEqual(_meta(run_dir)["status"], "human_review")
        # No `human_review -> done` transition got recorded.
        evs = read_events(run_dir)
        self.assertNotIn(("human_review", "done"), transitions_seen(evs))

    def test_merge_conflict_aborts_and_stays_in_human_review(self) -> None:
        """A conflicting commit on main forces `git merge --abort` + MergeConflict."""
        run_id, run_dir, repo = self._drive_to_human_review("conflict")

        # Commit on the worktree branch FIRST so the merge has content.
        wt_path = pathlib.Path(_meta(run_dir)["target"]["worktree"]["path"])
        (wt_path / "shared.txt").write_text("worktree side\n")
        subprocess.run(["git", "-C", str(wt_path), "add", "shared.txt"], check=True)
        subprocess.run(
            ["git", "-C", str(wt_path),
             "-c", "user.email=w@x", "-c", "user.name=w",
             "commit", "-q", "-m", "worktree commit"],
            check=True,
        )

        # Now make a conflicting commit on main in the target repo.
        (repo / "shared.txt").write_text("main side\n")
        subprocess.run(["git", "-C", str(repo), "add", "shared.txt"], check=True)
        subprocess.run(
            ["git", "-C", str(repo),
             "-c", "user.email=m@x", "-c", "user.name=m",
             "commit", "-q", "-m", "main commit"],
            check=True,
        )

        r = cli(self.tmp, "complete", run_id, "--accepted-by", "e2e-tester")
        self.assertNotEqual(r.returncode, 0, msg=r.stdout + r.stderr)
        self.assertIn("conflict", (r.stderr + r.stdout).lower())

        # Status stays at human_review.
        self.assertEqual(_meta(run_dir)["status"], "human_review")

        evs = read_events(run_dir)
        # No completion transition.
        self.assertNotIn(("human_review", "done"), transitions_seen(evs))
        # But a MergeConflict event was emitted.
        conflicts = [e for e in evs if e["type"] == "MergeConflict"]
        self.assertEqual(len(conflicts), 1, msg=event_types(evs))
        self.assertIn("shared.txt", conflicts[0]["payload"]["conflicted_files"])
        self.assertEqual(conflicts[0]["payload"]["worktree_branch"], _meta(run_dir)["target"]["worktree"]["branch_name"])

        # `git merge --abort` ran: working tree is clean.
        st = subprocess.run(
            ["git", "-C", str(repo), "status", "--porcelain"],
            capture_output=True, text=True, check=True,
        )
        self.assertEqual(st.stdout.strip(), "")

    def test_no_merge_flag_records_local_branch_label(self) -> None:
        """`--no-merge` keeps the old behavior so legacy/edge paths stay open."""
        run_id, run_dir, repo = self._drive_to_human_review("no-merge")
        wt_path = pathlib.Path(_meta(run_dir)["target"]["worktree"]["path"])
        branch_name = _meta(run_dir)["target"]["worktree"]["branch_name"]

        r = cli(
            self.tmp, "complete", run_id,
            "--accepted-by", "e2e-tester",
            "--no-merge",
        )
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        self.assertIn("human_review -> done", r.stdout)
        self.assertIn("completion_ref: local-branch:", r.stdout)
        # Status flipped to done, but no merge commit on main.
        self.assertEqual(_meta(run_dir)["status"], "done")
        merges = subprocess.run(
            ["git", "-C", str(repo), "log", "--merges", "--pretty=%H", "main"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        self.assertEqual(merges, "")
        evs = read_events(run_dir)
        # No WorktreeMerged event when --no-merge was used.
        self.assertNotIn("WorktreeMerged", event_types(evs))

        # --no-merge must preserve the worktree + branch — the human is opting
        # out of the merge precisely so they can do something manual with them.
        self.assertTrue(wt_path.exists(),
                        msg=f"--no-merge unexpectedly removed worktree {wt_path}")
        branch_ref = subprocess.run(
            ["git", "-C", str(repo),
             "show-ref", "--verify", "--quiet", f"refs/heads/{branch_name}"],
            capture_output=True,
        )
        self.assertEqual(branch_ref.returncode, 0,
                         msg=f"--no-merge unexpectedly deleted branch {branch_name}")
        # No removal confirmation in stdout.
        self.assertNotIn("removed worktree", r.stdout)


if __name__ == "__main__":
    unittest.main()
