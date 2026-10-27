"""End-to-end tempdir-harness tests for the lifecycle scripts and the
front-half slash commands' Python blocks.

These tests shell out to the real scripts in `scripts/` and exercise the
real lib code paths, but against a throwaway product repo and a throwaway
`repos.yaml`. The point is to catch regressions in the bash-Python
interfaces that unit tests can't reach (argv shapes, here-doc quoting,
event-log payloads, evidence trimming).

Each test class shares a tempdir built by setUp/tearDown. Tests inside a
class run in the order they're declared (unittest's
sortTestMethodsUsing override below).

Run from the workbench root:
    PYTHONPATH=. python3 -m unittest tests.test_e2e
"""

from __future__ import annotations

import atexit
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from textwrap import dedent

WORKBENCH_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = WORKBENCH_ROOT / "scripts"
CONFIG_REAL = WORKBENCH_ROOT / "config" / "repos.yaml"

# Process-wide safeguard: if any harness crashes hard (Python killed by OOM,
# Ctrl-C past tearDownClass, etc.), we still want the user's real
# config/repos.yaml restored. Each class registers its backup here; the
# atexit handler replays the EARLIEST (= original) backup once at process
# shutdown. Stored as a tuple (text-or-None, "captured"-flag) so we know
# whether a real file existed before the harness started.
_REPOS_YAML_ORIGINAL: tuple[str | None, bool] = (None, False)


def _capture_repos_backup() -> None:
    global _REPOS_YAML_ORIGINAL
    if _REPOS_YAML_ORIGINAL[1]:
        return  # already captured the original
    if CONFIG_REAL.exists():
        _REPOS_YAML_ORIGINAL = (CONFIG_REAL.read_text(), True)
    else:
        _REPOS_YAML_ORIGINAL = (None, True)


def _restore_repos_backup() -> None:
    text, captured = _REPOS_YAML_ORIGINAL
    if not captured:
        return
    if text is None:
        CONFIG_REAL.unlink(missing_ok=True)
    else:
        CONFIG_REAL.write_text(text)


atexit.register(_restore_repos_backup)


def _run(*args: str, cwd: Path | None = None, check: bool = True,
         env: dict | None = None) -> subprocess.CompletedProcess:
    """Tight wrapper around subprocess.run with the workbench's PYTHONPATH."""
    full_env = os.environ.copy()
    full_env["PYTHONPATH"] = str(WORKBENCH_ROOT)
    if env:
        full_env.update(env)
    return subprocess.run(
        list(args),
        cwd=str(cwd) if cwd else str(WORKBENCH_ROOT),
        env=full_env,
        capture_output=True,
        text=True,
        check=check,
    )


def _read_events(run_dir: Path) -> list[dict]:
    """Load events.jsonl as a list of dicts."""
    path = run_dir / "events.jsonl"
    if not path.exists():
        return []
    out = []
    for line in path.read_text().splitlines():
        if line.strip():
            out.append(json.loads(line))
    return out


def _last_transition(events: list[dict]) -> dict | None:
    for ev in reversed(events):
        if ev.get("event_type") == "TransitionApplied":
            return ev
    return None


class _HarnessBase(unittest.TestCase):
    """Shared scaffolding: throwaway product repo + temp repos.yaml.

    Each subclass sets `subpath` to "" for top-level or a subdir name for
    a subdirectory-project scenario.
    """

    subpath: str = ""

    # Keep tests in declaration order — the lifecycle is sequential.
    sortTestMethodsUsing = None  # type: ignore[assignment]

    @classmethod
    def setUpClass(cls):
        # Capture the original config BEFORE we mutate anything. This is what
        # the process-wide atexit handler will restore if the harness dies
        # hard. _capture_repos_backup is idempotent across classes.
        _capture_repos_backup()

        cls.tmpdir = Path(tempfile.mkdtemp(prefix="wb-e2e-"))
        cls.addClassCleanup(shutil.rmtree, cls.tmpdir, ignore_errors=True)

        cls.product_root = cls.tmpdir / "product"
        if cls.subpath:
            (cls.product_root / cls.subpath).mkdir(parents=True)
        else:
            cls.product_root.mkdir()
        subprocess.run(["git", "init", "-b", "main", str(cls.product_root)],
                       check=True, capture_output=True)
        subprocess.run(["git", "-C", str(cls.product_root), "commit",
                        "--allow-empty", "-m", "seed"],
                       check=True, capture_output=True)

        # Snapshot the real config and stub in our test config. Register the
        # restore as a class cleanup so it fires even if a test raises.
        cls.repos_backup: str | None = (
            CONFIG_REAL.read_text() if CONFIG_REAL.exists() else None
        )
        cls.addClassCleanup(cls._restore_repos_yaml)

        body = f"""\
repos:
  testrepo:
    path: {cls.product_root}
"""
        if cls.subpath:
            body += f"    project_subpath: {cls.subpath}\n"
        body += "    github: throwaway/repo\n"
        body += "    default_branch: main\n"
        CONFIG_REAL.write_text(body)

        cls.created_runs: list[str] = []
        cls.addClassCleanup(cls._cleanup_runs)

    @classmethod
    def _restore_repos_yaml(cls):
        if cls.repos_backup is not None:
            CONFIG_REAL.write_text(cls.repos_backup)
        else:
            CONFIG_REAL.unlink(missing_ok=True)

    @classmethod
    def _cleanup_runs(cls):
        for run_id in cls.created_runs:
            run_dir = WORKBENCH_ROOT / "runs" / run_id
            wt_dir = WORKBENCH_ROOT / "worktrees" / run_id
            if wt_dir.exists():
                subprocess.run(
                    ["git", "-C", str(cls.product_root), "worktree", "remove",
                     "--force", str(wt_dir)],
                    capture_output=True,
                )
            if run_dir.exists():
                shutil.rmtree(run_dir)

    def _new_feature(self, slug: str, idea: str = "test idea") -> Path:
        proc = _run(str(SCRIPTS / "new-feature.sh"), "testrepo", slug, idea)
        # Parse run_id from stdout.
        run_id = ""
        for line in proc.stdout.splitlines():
            if line.startswith("created run: "):
                run_id = line[len("created run: "):].strip()
                break
        self.assertTrue(run_id, f"could not parse run_id from: {proc.stdout!r}")
        type(self).created_runs.append(run_id)
        return WORKBENCH_ROOT / "runs" / run_id


class TestTopLevelLifecycle(_HarnessBase):
    """Canonical lifecycle against a top-level project (project == git root)."""

    subpath = ""

    def test_01_new_feature_emits_task_created(self):
        run_dir = self._new_feature("toplevel")
        self.run_dir = run_dir  # cache for sibling tests
        type(self).first_run_dir = run_dir

        events = _read_events(run_dir)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["event_type"], "TaskCreated")
        self.assertEqual(events[0]["to_state"], "draft")
        self.assertEqual(events[0]["payload"]["repo_key"], "testrepo")

    def test_02_create_worktree_transitions_to_in_progress(self):
        run_dir = type(self).first_run_dir
        _run(str(SCRIPTS / "create-worktree.sh"), str(run_dir))

        ev = _last_transition(_read_events(run_dir))
        self.assertEqual(ev["to_state"], "in_progress")
        self.assertEqual(ev["from_state"], "draft")
        self.assertIn("worktree_path", ev["payload"])
        self.assertIn("branch_name", ev["payload"])

    def test_03_qa_pass_refuses_on_in_progress_with_no_commits_is_ok(self):
        # in_progress is a legal from-state for qa-pass; just exercise it.
        run_dir = type(self).first_run_dir
        _run(str(SCRIPTS / "qa-pass.sh"), str(run_dir),
             "-r", "pass", "-t", "harness", "-s", "smoke")
        ev = _last_transition(_read_events(run_dir))
        self.assertEqual(ev["to_state"], "qa")
        self.assertEqual(ev["payload"]["review_decision"], "pass")

    def test_04_complete_run_merge_requires_qa_or_skip(self):
        run_dir = type(self).first_run_dir
        proc = _run(str(SCRIPTS / "complete-run.sh"), str(run_dir),
                    "--remove-worktree", "--delete-branch", "--force")
        ev = _last_transition(_read_events(run_dir))
        self.assertEqual(ev["to_state"], "merged")
        self.assertIn("merge_sha", ev["payload"])

    def test_05_qa_pass_refuses_on_draft(self):
        # Fresh draft run — qa-pass should refuse without writing to qa-log.md.
        run_dir = self._new_feature("refuse")
        qa_log_before = (run_dir / "qa-log.md").read_text()
        proc = _run(str(SCRIPTS / "qa-pass.sh"), str(run_dir),
                    "-r", "pass", "-t", "harness", check=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("refused", proc.stderr.lower())
        # qa-log.md must be untouched.
        qa_log_after = (run_dir / "qa-log.md").read_text()
        self.assertEqual(qa_log_before, qa_log_after)

    def test_06_abandon_without_reason_refuses(self):
        run_dir = self._new_feature("abandon-noreason")
        proc = _run(str(SCRIPTS / "complete-run.sh"), str(run_dir),
                    "--abandon", check=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("--reason", proc.stderr)

    def test_07_abandon_with_reason_succeeds(self):
        run_dir = self._new_feature("abandon-ok")
        _run(str(SCRIPTS / "complete-run.sh"), str(run_dir),
             "--abandon", "--reason", "harness cleanup")
        ev = _last_transition(_read_events(run_dir))
        self.assertEqual(ev["to_state"], "abandoned")
        self.assertEqual(ev["payload"]["abandoned_reason"], "harness cleanup")

    def test_08_skip_qa_merges_with_warning(self):
        run_dir = self._new_feature("hotfix")
        _run(str(SCRIPTS / "create-worktree.sh"), str(run_dir))
        # Make a commit so the merge has a SHA.
        wt = WORKBENCH_ROOT / "worktrees" / run_dir.name
        subprocess.run(["git", "-C", str(wt), "commit", "--allow-empty",
                        "-m", "hotfix"], check=True, capture_output=True)

        # First, confirm the bare merge attempt is refused.
        proc = _run(str(SCRIPTS / "complete-run.sh"), str(run_dir), check=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("--skip-qa", proc.stderr)

        # Now with --skip-qa: succeeds.
        proc = _run(str(SCRIPTS / "complete-run.sh"), str(run_dir),
                    "--skip-qa", "--remove-worktree", "--delete-branch",
                    "--force")
        # Loud warning printed to stderr.
        self.assertIn("--skip-qa bypasses", proc.stderr)
        ev = _last_transition(_read_events(run_dir))
        self.assertEqual(ev["to_state"], "merged")
        self.assertEqual(ev["from_state"], "in_progress")


class TestFrontHalfTransitions(_HarnessBase):
    """Exercise the Python blocks from /normalize and /brainstorm directly.

    These tests don't invoke the slash-command markdown (which needs a Claude
    Code session); they call the same lib functions with the same evidence
    dicts that the slash commands would build.
    """

    subpath = ""

    def test_01_front_half_canonical_path(self):
        run_dir = self._new_feature("fronthalf")

        # Step 1: /normalize Step 2 — draft → normalize (no evidence)
        from lib.metadata import load, save
        from lib.transitions import transition_with_evidence
        from lib.events import Event, append

        md = load(run_dir)
        self.assertEqual(md.status, "draft")
        md, trimmed = transition_with_evidence(md, "normalize", {})
        save(run_dir, md)
        append(run_dir, Event(event_type="TransitionApplied",
                              actor="slash:normalize",
                              from_state="draft", to_state="normalize",
                              payload=trimmed))

        # Step 2: /normalize Step 5 — normalize → brainstorm
        md = load(run_dir)
        spec_path = f"runs/{run_dir.name}/normalized-feature-input.md"
        md, trimmed = transition_with_evidence(
            md, "brainstorm", {"normalized_spec_path": spec_path})
        save(run_dir, md)
        append(run_dir, Event(event_type="Normalized",
                              actor="slash:normalize",
                              payload={"normalized_spec_path": spec_path}))
        append(run_dir, Event(event_type="TransitionApplied",
                              actor="slash:normalize",
                              from_state="normalize", to_state="brainstorm",
                              payload=trimmed))

        # Step 3: /brainstorm Step 7 — brainstorm → ready
        md = load(run_dir)
        md, trimmed = transition_with_evidence(
            md, "ready", {"approved_by": "harness"})
        save(run_dir, md)
        append(run_dir, Event(event_type="Brainstormed",
                              actor="slash:brainstorm",
                              payload={"approved_by": "harness",
                                       "chosen_approach": "approach-A"}))
        append(run_dir, Event(event_type="TransitionApplied",
                              actor="slash:brainstorm",
                              from_state="brainstorm", to_state="ready",
                              payload=trimmed))

        # Step 4: scripts/create-worktree.sh — ready → in_progress
        _run(str(SCRIPTS / "create-worktree.sh"), str(run_dir))

        events = _read_events(run_dir)
        transitions = [e for e in events if e["event_type"] == "TransitionApplied"]
        # Expect: draft→normalize, normalize→brainstorm, brainstorm→ready,
        # ready→in_progress
        edges = [(e["from_state"], e["to_state"]) for e in transitions]
        self.assertEqual(edges, [
            ("draft", "normalize"),
            ("normalize", "brainstorm"),
            ("brainstorm", "ready"),
            ("ready", "in_progress"),
        ])

        # Evidence is trimmed correctly.
        by_edge = {(e["from_state"], e["to_state"]): e["payload"]
                   for e in transitions}
        self.assertEqual(by_edge[("draft", "normalize")], {})
        self.assertEqual(
            by_edge[("normalize", "brainstorm")]["normalized_spec_path"],
            spec_path)
        self.assertEqual(
            by_edge[("brainstorm", "ready")]["approved_by"], "harness")
        # ready → in_progress payload includes the trimmed evidence plus the
        # script's extra context (base_sha, default_branch).
        ip = by_edge[("ready", "in_progress")]
        self.assertIn("worktree_path", ip)
        self.assertIn("branch_name", ip)

        # Clean up the worktree so tearDownClass can succeed.
        _run(str(SCRIPTS / "complete-run.sh"), str(run_dir),
             "--abandon", "--reason", "fronthalf test cleanup",
             "--remove-worktree", "--delete-branch", "--force")


class TestSubdirectoryProject(_HarnessBase):
    """Same lifecycle but with project_subpath set."""

    subpath = "myproj"

    def test_01_new_feature_records_subpath(self):
        run_dir = self._new_feature("subdir")
        type(self).first_run_dir = run_dir

        from lib.metadata import load
        md = load(run_dir)
        self.assertEqual(md.project_subpath, "myproj")
        self.assertEqual(md.repo_path, str(self.product_root))
        self.assertEqual(
            md.project_dir(),
            f"{self.product_root}/myproj",
        )

    def test_02_create_worktree_summary_points_at_subdir(self):
        run_dir = type(self).first_run_dir
        proc = _run(str(SCRIPTS / "create-worktree.sh"), str(run_dir))
        # The summary should print a cd target inside the worktree at the
        # subpath, not the worktree root.
        expected_subdir = str(
            WORKBENCH_ROOT / "worktrees" / run_dir.name / "myproj"
        )
        self.assertIn(f"cd {expected_subdir}", proc.stdout)

        # worktree_project_dir() should resolve to that same path.
        from lib.metadata import load
        md = load(run_dir)
        self.assertEqual(md.worktree_project_dir(), expected_subdir)

        # Clean up.
        _run(str(SCRIPTS / "complete-run.sh"), str(run_dir),
             "--abandon", "--reason", "subdir test cleanup",
             "--remove-worktree", "--delete-branch", "--force")


if __name__ == "__main__":
    unittest.main()
