"""Tests for tools/reconcile_master_metadata_after_cmd_complete.py.

Exercises the script in dry-run, write, idempotency, already-terminal, and
manual-override modes. The fixture constructs a synthetic git history with a
real merge commit on `master` that touches `runs/<id>/metadata.yaml` so the
file-path-based merge-SHA discovery query has something to find.

TODO §1 (Y scope, 2026-05-27).
"""
from __future__ import annotations

import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

from tests._helpers import cleanup, reset_caches  # noqa: F401

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from lib import yaml_io  # noqa: E402


SCRIPT_PATH = ROOT / "tools" / "reconcile_master_metadata_after_cmd_complete.py"


def _git(repo: pathlib.Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(repo),
         "-c", "user.name=test", "-c", "user.email=test@x",
         *args],
        capture_output=True, text=True, check=check,
    )


def _seed_metadata(run_dir: pathlib.Path, run_id: str, status: str) -> None:
    run_dir.mkdir(parents=True, exist_ok=True)
    meta = {
        "schema_version": 1,
        "run_id": run_id,
        "status": status,
        "created_at": "2026-05-25T00:00:00-04:00",
        "updated_at": "2026-05-25T00:00:00-04:00",
        "target": {
            "repo": {"mode": "existing", "path": "/tmp/fake-repo", "name": "fake",
                     "base_ref": "main"},
            "worktree": {"name": run_id, "path": "/tmp/wt", "branch_name": f"agent/{run_id}",
                         "created": True, "base_ref": "main"},
        },
        "scope": {"kind": "implementation", "summary": ""},
        "artifacts": {"raw_idea": "raw-idea.md"},
        "validation": {"required": True, "review_completed": False, "qa_completed": False,
                       "qa_recorded": False, "tests_passed": None, "known_issues_count": 0},
        "completion": {"accepted_by": None, "completion_ref": None, "completed_at": None,
                       "abandoned_reason": None},
    }
    (run_dir / "metadata.yaml").write_text(yaml_io.dumps(meta))


class TestReconcileMasterMetadata(unittest.TestCase):
    """One synthetic workbench, one stale run with a real merge commit."""

    def setUp(self) -> None:
        # The script expects a workbench whose subpath under the git toplevel
        # is non-empty (workbench_subpath() returns None when the workbench
        # IS the git root). Layout:
        #   tmp/                      git toplevel
        #     workbench/              workbench root (subpath = "workbench")
        #       agent-workbench.yaml
        #       schemas/
        #       runs/<run-id>/metadata.yaml
        #       tools/reconcile_master_metadata_after_cmd_complete.py
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="aw-reconcile-test-"))
        self.workbench = self.tmp / "workbench"
        self.workbench.mkdir()
        shutil.copy(ROOT / "agent-workbench.yaml", self.workbench / "agent-workbench.yaml")
        shutil.copytree(ROOT / "schemas", self.workbench / "schemas")
        # Symlink lib/ so the script's `from lib import yaml_io` works without
        # duplicating the codebase on every test run.
        (self.workbench / "lib").symlink_to(ROOT / "lib")
        (self.workbench / "runs").mkdir()
        # Copy the script into the synthetic workbench's tools dir so its
        # `--root` default (script-dir/..) resolves correctly.
        (self.workbench / "tools").mkdir()
        shutil.copy(SCRIPT_PATH, self.workbench / "tools" / SCRIPT_PATH.name)

        # Init git repo at toplevel.
        _git(self.tmp, "init", "-q", "-b", "master")
        (self.tmp / "README.md").write_text("test\n")
        _git(self.tmp, "add", "-A")
        _git(self.tmp, "commit", "-q", "-m", "init")

        # Seed the stale run on master (status=human_review).
        self.run_id = "2026-05-27-stale-fixture"
        self.run_dir = self.workbench / "runs" / self.run_id
        _seed_metadata(self.run_dir, self.run_id, status="human_review")
        _git(self.tmp, "add", "-A")
        _git(self.tmp, "commit", "-q", "-m", f"runs: {self.run_id} (initial)")

        # Build a fake branch + merge commit so the script's file-path query
        # finds something.
        _git(self.tmp, "checkout", "-q", "-b", f"agent/{self.run_id}")
        (self.workbench / "runs" / self.run_id / "extra.txt").write_text("agent work\n")
        _git(self.tmp, "add", "-A")
        _git(self.tmp, "commit", "-q", "-m", f"runs: {self.run_id} (work)")
        _git(self.tmp, "checkout", "-q", "master")
        _git(self.tmp, "merge", "--no-ff", "-q",
             "-m", f"Merge branch 'agent/{self.run_id}'", f"agent/{self.run_id}")
        self.merge_sha = _git(self.tmp, "rev-parse", "HEAD").stdout.strip()

        reset_caches()

    def tearDown(self) -> None:
        reset_caches()
        cleanup(self.tmp)

    def _run_script(self, *extra_args: str) -> tuple[int, str, str]:
        """Run the script as a subprocess; return (rc, stdout, stderr)."""
        proc = subprocess.run(
            [sys.executable, str(self.workbench / "tools" / SCRIPT_PATH.name),
             "--root", str(self.workbench),
             "--run-id", self.run_id,
             *extra_args],
            capture_output=True, text=True, check=False,
        )
        return proc.returncode, proc.stdout, proc.stderr

    def test_dry_run_lists_offender_without_modifying(self) -> None:
        original = (self.run_dir / "metadata.yaml").read_text()
        rc, out, _ = self._run_script()
        self.assertIn("human_review -> done", out)
        self.assertIn(self.merge_sha, out)
        self.assertIn("would-apply: 1", out)
        # File not modified.
        self.assertEqual((self.run_dir / "metadata.yaml").read_text(), original)

    def test_write_applies_rewrite(self) -> None:
        rc, out, _ = self._run_script("--write")
        self.assertEqual(rc, 0, f"unexpected rc={rc}\nstdout={out}")
        self.assertIn("applied: 1", out)
        data = yaml_io.loads((self.run_dir / "metadata.yaml").read_text())
        self.assertEqual(data["status"], "done")
        self.assertEqual(data["completion"]["accepted_by"], "reconciliation")
        self.assertEqual(data["completion"]["completion_ref"], f"merge:{self.merge_sha}")
        self.assertIsInstance(data["completion"]["completed_at"], str)
        self.assertTrue(data["completion"]["completed_at"])  # non-empty

    def test_idempotent_re_run_is_no_op(self) -> None:
        rc1, _, _ = self._run_script("--write")
        self.assertEqual(rc1, 0)
        # Second --write should find an already-terminal run and skip.
        rc2, out2, _ = self._run_script("--write")
        self.assertEqual(rc2, 0)
        self.assertIn("already-terminal: 1", out2)
        self.assertIn("applied: 0", out2)

    def test_already_terminal_skipped(self) -> None:
        # Pre-seed master as already done.
        _seed_metadata(self.run_dir, self.run_id, status="done")
        rc, out, _ = self._run_script()
        self.assertIn("OK already-terminal", out)
        self.assertIn("would-apply: 0", out)

    def test_merge_sha_override_bypasses_discovery(self) -> None:
        # Override forces the supplied SHA without running discovery. Use the
        # real merge SHA so _committer_date succeeds; the assertion confirms
        # the override-source label appears in output (proving discovery was
        # NOT called).
        rc, out, _ = self._run_script("--merge-sha", self.merge_sha)
        self.assertIn(f"merge:{self.merge_sha}", out)
        self.assertIn("via override", out)
