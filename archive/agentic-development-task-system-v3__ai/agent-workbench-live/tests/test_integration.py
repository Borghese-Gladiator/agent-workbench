"""Integration tests.

Spin up a temp workbench root + a throwaway git repo, drive the CLI end-to-end,
assert filesystem state and event log after each step.
"""
from __future__ import annotations

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


def cli(workbench_root: pathlib.Path, *args, input_text: str | None = None) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["AGENT_WORKBENCH_ROOT"] = str(workbench_root)
    return subprocess.run(
        [sys.executable, str(CLI), "--root", str(workbench_root), *args],
        capture_output=True, text=True, env=env,
        input=input_text,
    )


def make_throwaway_repo() -> pathlib.Path:
    repo = pathlib.Path(tempfile.mkdtemp(prefix="aw-repo-"))
    subprocess.run(["git", "-C", str(repo), "init", "-q", "-b", "main"], check=True)
    (repo / "README.md").write_text("# throwaway\n")
    subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
    subprocess.run([
        "git", "-C", str(repo),
        "-c", "user.name=test", "-c", "user.email=test@x",
        "commit", "-q", "-m", "init",
    ], check=True)
    return repo


class IntegrationCase(unittest.TestCase):
    def setUp(self):
        self.tmp = make_tmp_workbench()
        # Copy bin/ into the temp workbench so AGENT_WORKBENCH_ROOT works for the CLI.
        shutil.copytree(ROOT / "bin", self.tmp / "bin")
        # And lib/, since the CLI imports from sys.path == workbench root.
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


class TestHappyPath(IntegrationCase):
    def test_full_lifecycle(self):
        repo = self._repo()
        idea = self.tmp / "idea.md"
        idea.write_text("Add a hello endpoint to the throwaway repo.\n")

        # new-run. base_ref=main so the §1g scope-creep diff has something
        # to compare the worktree commit against.
        r = cli(self.tmp, "new-run",
                "--repo-path", str(repo),
                "--worktree-name", "hello-endpoint",
                "--base-ref", "main",
                "--idea-file", str(idea))
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        run_id = r.stdout.strip()
        self.assertTrue(run_id)

        # show: confirm draft state
        r = cli(self.tmp, "show", run_id)
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        self.assertIn("status:     draft", r.stdout)

        # draft: draft -> shaping (no clarifications needed for this fixture)
        r = cli(self.tmp, "draft", run_id)
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        self.assertIn("draft -> shaping", r.stdout)

        # shape --init: stages templates/brief.md (status stays at shaping)
        r = cli(self.tmp, "shape", run_id, "--init")
        self.assertEqual(r.returncode, 0, msg=r.stderr)

        # Fill brief (staged layout: file lives at run root until shape closes
        # the stage, then is moved into stages/2_shaping/). Include a
        # "Files likely to change" section so the §1g scope-creep check has
        # something to compare against.
        brief = self.tmp / "runs" / run_id / "brief.md"
        brief.write_text(
            "# Brief\n\n"
            "## Goal\nAdd a hello endpoint.\n\n"
            "## Files likely to change\n\n"
            "- src/hello.py\n"
        )

        # shape finalize: shaping -> planning
        r = cli(self.tmp, "shape", run_id)
        self.assertEqual(r.returncode, 0, msg=r.stderr)

        # plan --init
        r = cli(self.tmp, "plan", run_id, "--init")
        self.assertEqual(r.returncode, 0, msg=r.stderr)

        # Fill planning artifacts. Staged layout merges preflight + decisions/
        # assumptions into plan.md.
        run_dir = self.tmp / "runs" / run_id
        (run_dir / "plan.md").write_text(
            "# Plan\nAdd hello.\n\n"
            "## Preflight\nOK.\n\n"
            "## Decisions & assumptions\n\n"
            "### ASM-001\n- **Text**: We use Go.\n- **Reason**: It's a Go repo.\n- **Impact**: low\n\n"
            "### DR-001\n- **Decision**: Use net/http.\n- **Rationale**: stdlib is enough.\n"
        )

        # plan finalize: planning -> ready
        r = cli(self.tmp, "plan", run_id)
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        self.assertIn("planning -> ready", r.stdout)

        # start: ready -> building (creates worktree)
        r = cli(self.tmp, "start", run_id, "--approved-by", "tester")
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        self.assertIn("ready -> building", r.stdout)

        # The worktree should exist. Read the actual path from metadata so we
        # don't have to second-guess slugification of tempdir names.
        from lib import yaml_io as _yaml_io
        meta = _yaml_io.loads((self.tmp / "runs" / run_id / "metadata.yaml").read_text())
        worktree = pathlib.Path(meta["target"]["worktree"]["path"])
        self.assertTrue(worktree.exists(), f"worktree missing at {worktree}")
        self.assertTrue((worktree / "README.md").exists())
        # TODO §1: worktree basename should be `<YYYYMMDD>__<slug>`.
        import datetime as _dt
        today_compact = _dt.date.today().strftime("%Y%m%d")
        self.assertTrue(
            worktree.name.startswith(f"{today_compact}__"),
            f"expected worktree basename to start with {today_compact}__, got {worktree.name!r}",
        )
        self.assertTrue(worktree.name.endswith("hello-endpoint"))
        # The branch should exist in the source repo.
        branch_check = subprocess.run(
            ["git", "-C", str(repo), "show-ref", "--verify", "--quiet", "refs/heads/agent/hello-endpoint"]
        )
        self.assertEqual(branch_check.returncode, 0)

        # Make a real change in the worktree on an UNEXPECTED file (the brief
        # only anticipated src/hello.py). This drives the §1g scope-creep
        # check to flag src/unexpected.py.
        (worktree / "src").mkdir(exist_ok=True)
        (worktree / "src" / "unexpected.py").write_text("x = 1\n")
        subprocess.run(["git", "-C", str(worktree), "add", "-A"], check=True)
        subprocess.run([
            "git", "-C", str(worktree),
            "-c", "user.name=t", "-c", "user.email=t@x",
            "commit", "-q", "-m", "scope-creep file",
        ], check=True)

        # Builder writes build.md DURING `building` (staged layout: it's the
        # building stage's output and gets moved by the engine on transition).
        # The Documentation touched section claims README.md was updated, but
        # we leave the worktree's README untouched -- the validator must flag
        # this unverified claim in review.md (TODO §1d).
        (run_dir / "build.md").write_text(
            "# Build\nAdded /hello.\n\n"
            "## Documentation touched\n\n"
            "- README.md — claimed update that didn't happen\n"
        )

        # validate --init: building -> validating
        r = cli(self.tmp, "validate", run_id, "--init")
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        self.assertIn("building -> validating", r.stdout)

        # Fill validating-stage artifacts at run root; they'll be moved into
        # stages/5_validating/ on the next transition.
        (run_dir / "review.md").write_text("# Review\n\n## Decision\napprove\n")
        (run_dir / "qa" / "report.md").write_text("# QA\nLooks good.\n")
        (run_dir / "HUMAN_REVIEW.md").write_text(
            "# HUMAN_REVIEW\n\n"
            "## Suggested first checks\n\n"
            "```bash\necho ok\n```\n\n"
            "## Run timeline\n\nstep 1\n"
        )

        # validate finalize: validating -> followups (staged-layout flow)
        r = cli(self.tmp, "validate", run_id, "--tests-passed", "true", "--known-issues", "0")
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        self.assertIn("validating -> followups", r.stdout)
        # audit.md was rendered during validate
        self.assertTrue((run_dir / "audit.md").exists())

        # /followups: write follow-ups.md and transition to human_review.
        (run_dir / "follow-ups.md").write_text(
            "---\n"
            "title: Add property-based tests for the hello endpoint\n"
            "motivation: Current tests cover the happy path only; edge cases unexplored.\n"
            "suggested_scope: Add hypothesis tests for input validation; no behavior change.\n"
            "category: tech_debt\n"
            "---\n\n"
            "More prose if needed.\n\n"
            "---\n"
            "title: Document the /hello endpoint in the README\n"
            "motivation: Reviewer flagged README claim was unverified.\n"
            "suggested_scope: Add a usage section to README.md with a curl example.\n"
            "category: docs\n"
            "---\n"
        )
        r = cli(self.tmp, "followups", run_id)
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        self.assertIn("followups -> human_review", r.stdout)

        # Staged-layout assertions (TODO §1a/§1b/§1c + TODO #1 numbered dirs):
        # the expected files have been promoted into stages/<N>_<stage>/, and
        # HUMAN_REVIEW.md sits at run root with the required sections.
        self.assertTrue((run_dir / "stages" / "2_shaping" / "brief.md").exists())
        self.assertTrue((run_dir / "stages" / "3_planning" / "plan.md").exists())
        self.assertTrue((run_dir / "stages" / "4_building" / "build.md").exists())
        self.assertTrue((run_dir / "stages" / "5_validating" / "review.md").exists())
        self.assertTrue((run_dir / "stages" / "5_validating" / "qa" / "report.md").exists())
        self.assertTrue((run_dir / "stages" / "6_followups" / "follow-ups.md").exists())
        self.assertTrue((run_dir / "HUMAN_REVIEW.md").exists())
        # TODO §1d: the validator detected README.md was claimed but unchanged
        # and appended a Documentation claims section to review.md (now at
        # stages/5_validating/review.md after the human_review transition moved it).
        review = (run_dir / "stages" / "5_validating" / "review.md").read_text()
        self.assertIn("## Documentation claims", review)
        self.assertIn("README.md", review)
        # And a DocClaimsVerified event was emitted.
        r = cli(self.tmp, "events", run_id, "--type", "DocClaimsVerified", "--raw")
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        self.assertIn("DocClaimsVerified", r.stdout)
        self.assertIn("README.md", r.stdout)

        # TODO §1g: the brief expected src/hello.py but the worktree commit
        # added src/unexpected.py. The validator detected the creep and
        # appended a Scope creep check section to review.md.
        self.assertIn("## Scope creep check", review)
        self.assertIn("src/unexpected.py", review)
        # And a ScopeCreepChecked event was emitted.
        r = cli(self.tmp, "events", run_id, "--type", "ScopeCreepChecked", "--raw")
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        self.assertIn("ScopeCreepChecked", r.stdout)
        self.assertIn("src/unexpected.py", r.stdout)

        # TODO §1e: build block populated with defaults during validate --init.
        meta_text = (run_dir / "metadata.yaml").read_text()
        self.assertIn("build:", meta_text)
        self.assertIn("iterations: 1", meta_text)
        self.assertIn("exit_reason: tests_green", meta_text)
        self.assertIn("max_iterations: 5", meta_text)
        # Followup C: `show` renders the build block.
        r = cli(self.tmp, "show", run_id)
        self.assertIn("build:", r.stdout)
        self.assertIn("iterations", r.stdout)
        self.assertIn("tests_green", r.stdout)

        # Run-root pre-staging files are gone (they were moved on transition).
        self.assertFalse((run_dir / "brief.md").exists())
        self.assertFalse((run_dir / "build.md").exists())
        self.assertFalse((run_dir / "review.md").exists())
        self.assertFalse((run_dir / "qa" / "report.md").exists())
        self.assertFalse((run_dir / "follow-ups.md").exists())

        # complete: human_review -> done
        r = cli(self.tmp, "complete", run_id, "--accepted-by", "tester")
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        self.assertIn("human_review -> done", r.stdout)

        # final state
        r = cli(self.tmp, "show", run_id)
        self.assertIn("status:     done", r.stdout)

        # events sanity: TransitionApplied count == 8 for staged runs
        # (draft->shaping->planning->ready->building->validating->followups->human_review->done).
        r = cli(self.tmp, "events", run_id, "--type", "TransitionApplied")
        self.assertEqual(r.stdout.count("TransitionApplied"), 8, msg=r.stdout)


class TestBounceLoop(IntegrationCase):
    def _drive_to_human_review(self) -> tuple[str, pathlib.Path]:
        """Drive a fresh run to human_review and return (run_id, run_dir)."""
        repo = self._repo()
        idea = self.tmp / f"idea-{repo.name}.md"
        idea.write_text("bounce test\n")

        r = cli(self.tmp, "new-run", "--repo-path", str(repo),
                "--worktree-name", f"bounce-test-{repo.name}",
                "--idea-file", str(idea))
        run_id = r.stdout.strip()
        run_dir = self.tmp / "runs" / run_id

        cli(self.tmp, "draft", run_id)
        cli(self.tmp, "shape", run_id, "--init")
        (run_dir / "brief.md").write_text("# Brief\nB.\n")
        cli(self.tmp, "shape", run_id)
        cli(self.tmp, "plan", run_id, "--init")
        (run_dir / "plan.md").write_text(
            "# Plan\nx\n\n## Preflight\nx\n\n## Decisions & assumptions\n\n"
            "### ASM-001\n- **Text**: x\n\n### DR-001\n- **Decision**: x\n"
        )
        cli(self.tmp, "plan", run_id)
        cli(self.tmp, "start", run_id, "--approved-by", "t")
        (run_dir / "build.md").write_text("# Build\nx\n")
        cli(self.tmp, "validate", run_id, "--init")
        (run_dir / "review.md").write_text("# Review\nx\n")
        (run_dir / "HUMAN_REVIEW.md").write_text(
            "# HR\n\n## Suggested first checks\n\n```bash\nok\n```\n\n## Run timeline\nx\n"
        )
        (run_dir / "qa" / "report.md").write_text("# QA\nx\n")
        cli(self.tmp, "validate", run_id)
        # validate now lands in `followups`; author + finalize follow-ups.md
        # to advance to human_review (TODO §1f).
        (run_dir / "follow-ups.md").write_text(
            "---\n"
            "title: smoke\n"
            "motivation: keep the test minimal\n"
            "suggested_scope: trivial\n"
            "category: no_followups\n"
            "---\n"
        )
        cli(self.tmp, "followups", run_id)
        return run_id, run_dir

    def test_bounce_back_to_building(self):
        run_id, run_dir = self._drive_to_human_review()

        # Backwards-compat: bounce with no --change-request-path still works.
        r = cli(self.tmp, "bounce", run_id,
                "--reason", "needs tests",
                "--requested-by", "tester")
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        self.assertIn("human_review -> building", r.stdout)
        self.assertNotIn("change-request:", r.stdout)

        # The prior stages/4_building/ and stages/5_validating/ outputs
        # should be archived as -v1 (TODO §1a supersession rule).
        self.assertTrue((run_dir / "archive" / "4_building" / "build-v1.md").exists())
        self.assertTrue((run_dir / "archive" / "5_validating" / "review-v1.md").exists())
        # And stages/ has been re-emptied for the rebuild.
        self.assertEqual(list((run_dir / "stages" / "4_building").iterdir()), [])

        # Re-validate. Build a v2 build.md / review.md / HUMAN_REVIEW.md.
        (run_dir / "build.md").write_text("# Build v2\n")
        cli(self.tmp, "validate", run_id, "--init")
        (run_dir / "review.md").write_text("# Review v2\n")
        (run_dir / "HUMAN_REVIEW.md").write_text(
            "# HR\n\n## Suggested first checks\n\n```bash\nok\n```\n\n## Run timeline\nx\n"
        )
        cli(self.tmp, "validate", run_id)
        # Re-author follow-ups.md (the prior one was archived) and finalize.
        (run_dir / "follow-ups.md").write_text(
            "---\ntitle: smoke v2\nmotivation: post-bounce minimal\n"
            "suggested_scope: trivial\ncategory: no_followups\n---\n"
        )
        cli(self.tmp, "followups", run_id)

        r = cli(self.tmp, "show", run_id)
        self.assertIn("status:     human_review", r.stdout)

    def test_bounce_with_change_request_path(self):
        run_id, run_dir = self._drive_to_human_review()

        cr_path = run_dir / "change-request.md"
        cr_path.write_text(
            "# Change Request — " + run_id + "\n\n"
            "## Bounce 1 — 2026-05-18T00:00:00Z — tester\n\n"
            "**Scope:** Implementation\n"
        )

        r = cli(self.tmp, "bounce", run_id,
                "--reason", "rework hand evaluator",
                "--requested-by", "tester",
                "--change-request-path", str(cr_path))
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        self.assertIn("human_review -> building", r.stdout)
        self.assertIn("change-request:", r.stdout)

        # The BounceRequested event should carry change_request_path in its payload.
        r = cli(self.tmp, "events", run_id, "--type", "BounceRequested", "--raw")
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        self.assertIn("change_request_path", r.stdout)

    def test_bounce_with_missing_change_request_file_fails(self):
        run_id, run_dir = self._drive_to_human_review()

        missing = run_dir / "change-request.md"  # not created
        r = cli(self.tmp, "bounce", run_id,
                "--reason", "x",
                "--requested-by", "tester",
                "--change-request-path", str(missing))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("change-request file not found", r.stderr + r.stdout)

        # State should not have advanced.
        r = cli(self.tmp, "show", run_id)
        self.assertIn("status:     human_review", r.stdout)

    def test_bounce_with_empty_change_request_file_fails(self):
        run_id, run_dir = self._drive_to_human_review()

        empty = run_dir / "change-request.md"
        empty.write_text("")

        r = cli(self.tmp, "bounce", run_id,
                "--reason", "x",
                "--requested-by", "tester",
                "--change-request-path", str(empty))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("empty", r.stderr + r.stdout)

        r = cli(self.tmp, "show", run_id)
        self.assertIn("status:     human_review", r.stdout)


class TestAbandon(IntegrationCase):
    def test_abandon_at_various_states(self):
        def _to_shaping(rid, rd):
            cli(self.tmp, "draft", rid)
            cli(self.tmp, "shape", rid, "--init")

        for label, prepare in [
            ("draft", lambda rid, rd: None),
            ("shaping", _to_shaping),
        ]:
            repo = self._repo()
            idea = self.tmp / f"idea-{label}.md"
            idea.write_text(f"abandon at {label}\n")
            r = cli(self.tmp, "new-run", "--repo-path", str(repo),
                    "--worktree-name", f"abandon-{label}",
                    "--idea-file", str(idea))
            self.assertEqual(r.returncode, 0, msg=r.stderr)
            rid = r.stdout.strip()
            prepare(rid, self.tmp / "runs" / rid)

            r = cli(self.tmp, "abandon", rid,
                    "--reason", "test", "--abandoned-by", "t")
            self.assertEqual(r.returncode, 0, msg=r.stderr)
            r = cli(self.tmp, "show", rid)
            self.assertIn("status:     abandoned", r.stdout)


class TestFlatLayoutBackCompat(IntegrationCase):
    """A run created before TODO §1 (no stages/ directory) must still be
    readable by show/events without the renovate code paths kicking in."""

    def test_flat_run_loads_and_show_works(self):
        run_id = "2025-12-01-legacy"
        rd = self.tmp / "runs" / run_id
        rd.mkdir(parents=True)
        # Hand-write a flat-layout metadata.yaml in the post-V1 shape.
        (rd / "metadata.yaml").write_text(f"""schema_version: 1
run_id: {run_id}
status: human_review
created_at: 2025-12-01T00:00:00
updated_at: 2025-12-01T00:00:00
target:
  repo:
    mode: existing
    path: /tmp/legacy
    name: legacy
    base_ref: main
    fingerprint: null
    created_by_run: null
  worktree:
    name: legacy
    path: /tmp/wt
    branch_name: agent/legacy
    created: true
    base_ref: main
    initial_commit_sha: null
scope:
  kind: implementation
  summary: ''
artifacts:
  raw_idea: raw-idea.md
  answers: null
  brief: brief.md
  plan: plan.md
  preflight: preflight.md
  assumptions: assumptions.md
  decisions: decisions.md
  implementation_summary: implementation-summary.md
  diff_summary: diff-summary.md
  review_report: review.md
  qa_report: qa/report.md
  audit: audit.md
  handoff: handoff.md
validation:
  required: true
  review_completed: true
  qa_completed: true
  qa_recorded: true
  tests_passed: true
  known_issues_count: 0
completion:
  accepted_by: null
  completion_ref: null
  completed_at: null
  abandoned_reason: null
""")
        # Flat: handoff.md at run root, no stages/.
        (rd / "handoff.md").write_text("# Handoff (legacy)\nDone.\n")

        # show should print status without exploding.
        r = cli(self.tmp, "show", run_id)
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        self.assertIn("status:     human_review", r.stdout)

        # handoff command should find the legacy handoff.md, not look for HUMAN_REVIEW.md.
        r = cli(self.tmp, "handoff", run_id)
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        self.assertIn("Handoff (legacy)", r.stdout)

        # And nothing has materialized a stages/ directory as a side effect.
        self.assertFalse((rd / "stages").exists())


class TestNewRepo(IntegrationCase):
    def test_new_repo_flow(self):
        new_repo_dir = pathlib.Path(tempfile.mkdtemp(prefix="aw-newrepo-"))
        # Make it empty (mkdtemp creates dir but empty).
        self.repos.append(new_repo_dir)
        idea = self.tmp / "idea.md"
        idea.write_text("bootstrap a thing\n")

        r = cli(self.tmp, "new-run",
                "--new-repo-path", str(new_repo_dir),
                "--worktree-name", "bootstrap",
                "--idea-file", str(idea),
                "--scope-kind", "bootstrap")
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        run_id = r.stdout.strip()

        # Repo was created with monorepo scaffold + initial commit.
        self.assertTrue((new_repo_dir / "README.md").exists())
        self.assertTrue((new_repo_dir / "docs").exists())
        self.assertTrue((new_repo_dir / "backend").exists())
        self.assertTrue((new_repo_dir / "frontend").exists())
        # And it is a git repo.
        proc = subprocess.run(["git", "-C", str(new_repo_dir), "log", "--oneline"], capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0)
        self.assertIn("agent-workbench initial scaffold", proc.stdout)

        # Metadata records mode=new and a fingerprint (initial SHA).
        r = cli(self.tmp, "show", run_id)
        self.assertIn("repo.mode:      new", r.stdout)


if __name__ == "__main__":
    unittest.main()
