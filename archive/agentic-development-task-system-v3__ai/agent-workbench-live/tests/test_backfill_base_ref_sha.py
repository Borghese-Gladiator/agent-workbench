"""Unit tests for `tools/backfill_base_ref_sha.py` (TODO §3 / 2c).

Builds a synthetic workbench tree with one stale run (symbolic base_ref, no
base_ref_sha) and one already-populated run, plus a real synthetic source
repo with a worktree branch that diverges from HEAD. Then drives the script
directly and asserts the metadata mutations.
"""
from __future__ import annotations

import pathlib
import runpy
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest

# The backfill script lives at agent-workbench-live/tools/. Tests live at
# agent-workbench-live/tests/. Resolve by walking up from this file.
_WORKBENCH_ROOT = pathlib.Path(__file__).resolve().parent.parent
_SCRIPT = _WORKBENCH_ROOT / "tools" / "backfill_base_ref_sha.py"


def _git(repo: pathlib.Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True, text=True, check=True,
    ).stdout


def _init_source_repo(repo: pathlib.Path) -> tuple[str, str]:
    """Build a tiny source repo. Returns (fork_sha, branch_tip_sha) where
    `feat` branches off fork_sha and has one extra commit."""
    repo.mkdir(parents=True, exist_ok=True)
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "user.email", "t@e.x")
    _git(repo, "config", "user.name", "test")
    (repo / "README.md").write_text("# repo\n")
    _git(repo, "add", "README.md")
    _git(repo, "commit", "-qm", "init")
    fork_sha = _git(repo, "rev-parse", "HEAD").strip()
    _git(repo, "checkout", "-q", "-b", "feat")
    (repo / "feature.py").write_text("def f():\n    return 1\n")
    _git(repo, "add", "feature.py")
    _git(repo, "commit", "-qm", "add feature")
    tip = _git(repo, "rev-parse", "HEAD").strip()
    # Return to main so source-repo HEAD is at fork_sha (the natural state
    # for the backfill — branch diverged from current HEAD).
    _git(repo, "checkout", "-q", "main")
    return fork_sha, tip


def _write_metadata(path: pathlib.Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(body).lstrip())


def _run_script(workbench: pathlib.Path, *extra: str) -> tuple[int, str, str]:
    """Run the backfill script as a subprocess so PYTHONPATH munging doesn't
    leak into the test process. Captures stdout + stderr."""
    proc = subprocess.run(
        [sys.executable, str(_SCRIPT), "--root", str(workbench), *extra],
        capture_output=True, text=True, check=False,
    )
    return proc.returncode, proc.stdout, proc.stderr


def _read_meta(path: pathlib.Path) -> dict:
    """Use the workbench's own yaml_io for parsing so we round-trip the
    exact representation the script writes."""
    sys.path.insert(0, str(_WORKBENCH_ROOT))
    try:
        from lib import yaml_io  # type: ignore
        return yaml_io.loads(path.read_text())
    finally:
        sys.path.remove(str(_WORKBENCH_ROOT))


class TestBackfillBaseRefSha(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="aw-backfill-"))
        # Synthetic workbench root.
        self.workbench = self.tmp / "agent-workbench-live"
        (self.workbench / "runs").mkdir(parents=True)
        # Synthetic source repo with one branch off init.
        self.source_repo = self.tmp / "source-repo"
        self.fork_sha, self.tip_sha = _init_source_repo(self.source_repo)

        # Stale run: symbolic base_ref, missing base_ref_sha.
        _write_metadata(self.workbench / "runs" / "stale-run" / "metadata.yaml", f"""
            schema_version: 1
            run_id: stale-run
            status: done
            target:
              repo:
                mode: existing
                path: "{self.source_repo}"
                name: source-repo
                base_ref: HEAD
              worktree:
                name: feat
                branch_name: feat
                path: ""
                base_ref: HEAD
                created: true
        """)

        # Populated run: should be skipped (idempotency).
        _write_metadata(self.workbench / "runs" / "populated-run" / "metadata.yaml", f"""
            schema_version: 1
            run_id: populated-run
            status: done
            target:
              repo:
                mode: existing
                path: "{self.source_repo}"
                name: source-repo
                base_ref: HEAD
                base_ref_sha: "{self.fork_sha}"
              worktree:
                name: feat
                branch_name: feat
                path: ""
                base_ref: HEAD
                created: true
        """)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    # --- dry-run -------------------------------------------------------------

    def test_dry_run_reports_change_but_writes_nothing(self):
        before_stale = (self.workbench / "runs" / "stale-run" / "metadata.yaml").read_text()
        before_pop = (self.workbench / "runs" / "populated-run" / "metadata.yaml").read_text()

        rc, stdout, stderr = _run_script(self.workbench, "--dry-run")

        # Stale run is reported as would-be-changed; populated run is skipped.
        self.assertIn("stale-run", stdout)
        self.assertIn(self.fork_sha, stdout)
        self.assertIn("(dry-run)", stdout)

        # Both files unchanged byte-for-byte.
        self.assertEqual(
            (self.workbench / "runs" / "stale-run" / "metadata.yaml").read_text(),
            before_stale,
        )
        self.assertEqual(
            (self.workbench / "runs" / "populated-run" / "metadata.yaml").read_text(),
            before_pop,
        )

    # --- write path ----------------------------------------------------------

    def test_write_populates_sha_and_summarizes(self):
        rc, stdout, _ = _run_script(self.workbench)
        self.assertEqual(rc, 0, stdout)
        self.assertIn("changed: 1", stdout)
        self.assertIn("already-backfilled: 1", stdout)

        meta = _read_meta(self.workbench / "runs" / "stale-run" / "metadata.yaml")
        self.assertEqual(meta["target"]["repo"]["base_ref_sha"], self.fork_sha)

        # Populated run is byte-identical except for write-induced reformat —
        # check the SHA didn't change.
        meta_pop = _read_meta(self.workbench / "runs" / "populated-run" / "metadata.yaml")
        self.assertEqual(meta_pop["target"]["repo"]["base_ref_sha"], self.fork_sha)

    # --- idempotency ---------------------------------------------------------

    def test_second_run_is_noop(self):
        rc1, _, _ = _run_script(self.workbench)
        self.assertEqual(rc1, 0)
        rc2, stdout2, _ = _run_script(self.workbench)
        self.assertEqual(rc2, 0)
        self.assertIn("changed: 0", stdout2)
        self.assertIn("already-backfilled: 2", stdout2)

    # --- missing source repo skipped -----------------------------------------

    def test_missing_source_repo_skipped_not_failed(self):
        # Stale run pointing at a non-existent source repo path.
        _write_metadata(self.workbench / "runs" / "gone-run" / "metadata.yaml", f"""
            schema_version: 1
            run_id: gone-run
            status: done
            target:
              repo:
                mode: existing
                path: "{self.tmp}/does-not-exist"
                name: ghost
                base_ref: HEAD
              worktree:
                name: feat
                branch_name: feat
                path: ""
                base_ref: HEAD
                created: true
        """)
        rc, stdout, stderr = _run_script(self.workbench)
        # Exit code is 0 because the missing repo is a *skip*, not a failure
        # to resolve a present branch.
        self.assertEqual(rc, 0, stderr)
        self.assertIn("gone-run", stderr)
        self.assertIn("source repo not found", stderr)
        self.assertIn("skipped: 1", stdout)

    # --- missing branch falls through to root commit -------------------------

    def test_orphan_branch_uses_root_commit(self):
        # Build a separate repo with a true orphan branch — no merge-base
        # with main, so the script must fall through to rev-list root.
        orphan_repo = self.tmp / "orphan-repo"
        orphan_repo.mkdir()
        _git(orphan_repo, "init", "-q", "-b", "main")
        _git(orphan_repo, "config", "user.email", "t@e.x")
        _git(orphan_repo, "config", "user.name", "test")
        (orphan_repo / "f.txt").write_text("hi\n")
        _git(orphan_repo, "add", "f.txt")
        _git(orphan_repo, "commit", "-qm", "main-init")
        # Make an orphan branch with its own root.
        _git(orphan_repo, "checkout", "--orphan", "orphan-branch")
        _git(orphan_repo, "rm", "-rf", ".")
        (orphan_repo / "g.txt").write_text("orphan\n")
        _git(orphan_repo, "add", "g.txt")
        _git(orphan_repo, "commit", "-qm", "orphan-init")
        orphan_root = _git(orphan_repo, "rev-parse", "HEAD").strip()
        _git(orphan_repo, "checkout", "-q", "main")

        _write_metadata(self.workbench / "runs" / "orphan-run" / "metadata.yaml", f"""
            schema_version: 1
            run_id: orphan-run
            status: done
            target:
              repo:
                mode: existing
                path: "{orphan_repo}"
                name: orphan-repo
                base_ref: HEAD
              worktree:
                name: orphan-branch
                branch_name: orphan-branch
                path: ""
                base_ref: HEAD
                created: true
        """)
        rc, stdout, _ = _run_script(self.workbench)
        self.assertEqual(rc, 0)
        self.assertIn("via root-commit", stdout)
        meta = _read_meta(self.workbench / "runs" / "orphan-run" / "metadata.yaml")
        self.assertEqual(meta["target"]["repo"]["base_ref_sha"], orphan_root)


if __name__ == "__main__":
    unittest.main()
