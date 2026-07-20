"""Tests for lib.runs: find_run, iter_all_runs, is_self_modifying.

TODO §1A2 + §1C2.
"""
from __future__ import annotations

import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

from tests._helpers import make_tmp_workbench, cleanup, reset_caches  # noqa: F401

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from lib import config, metadata, runs as runs_mod, yaml_io  # noqa: E402


def _init_repo(repo_path: pathlib.Path) -> None:
    subprocess.run(["git", "-C", str(repo_path), "init", "-q", "-b", "main"], check=True)
    (repo_path / "README.md").write_text("test\n")
    subprocess.run(["git", "-C", str(repo_path), "add", "-A"], check=True)
    subprocess.run([
        "git", "-C", str(repo_path),
        "-c", "user.name=test", "-c", "user.email=test@x",
        "commit", "-q", "-m", "init",
    ], check=True)


def _add_worktree(repo_path: pathlib.Path, branch: str, wt_path: pathlib.Path) -> None:
    subprocess.run(
        ["git", "-C", str(repo_path), "worktree", "add", "-b", branch, str(wt_path), "main"],
        check=True,
    )


def _seed_run(run_dir: pathlib.Path, run_id: str, *,
              worktree_path: str | None, status: str = "building") -> None:
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
            "worktree": {"name": run_id, "path": worktree_path, "branch_name": f"agent/{run_id}",
                         "created": bool(worktree_path), "base_ref": "main"},
        },
        "scope": {"kind": "implementation", "summary": ""},
        "artifacts": {"raw_idea": "raw-idea.md"},
        "validation": {"required": True, "review_completed": False, "qa_completed": False,
                       "qa_recorded": False, "tests_passed": None, "known_issues_count": 0},
        "completion": {"accepted_by": None, "completion_ref": None, "completed_at": None,
                       "abandoned_reason": None},
    }
    (run_dir / "metadata.yaml").write_text(yaml_io.dumps(meta))


class TestRunsEnumeration(unittest.TestCase):
    """Exercise find_run + iter_all_runs against synthetic worktrees."""

    def setUp(self) -> None:
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="aw-runs-test-"))
        # Layout: tmp is the workbench's main git repo. workbench root = tmp.
        _init_repo(self.tmp)
        # Copy the workbench config + schemas into tmp so cfg.load works.
        shutil.copy(ROOT / "agent-workbench.yaml", self.tmp / "agent-workbench.yaml")
        shutil.copytree(ROOT / "schemas", self.tmp / "schemas")
        # Worktrees under tmp/wt/<name>.
        self.wt1 = self.tmp / "wt" / "wt1"
        self.wt2 = self.tmp / "wt" / "wt2"
        self.wt1.parent.mkdir(parents=True, exist_ok=True)
        _add_worktree(self.tmp, "agent/wt1", self.wt1)
        _add_worktree(self.tmp, "agent/wt2", self.wt2)
        self.cfg = config.load(self.tmp)
        reset_caches()

    def tearDown(self) -> None:
        reset_caches()
        cleanup(self.tmp)

    def test_find_run_resolves_master(self) -> None:
        _seed_run(self.cfg.runs_path / "r-master", "r-master",
                  worktree_path=None, status="done")
        run = runs_mod.find_run(self.cfg, "r-master")
        self.assertEqual(run.run_id, "r-master")
        self.assertEqual(run.source, runs_mod.SOURCE_MASTER)
        self.assertEqual(run.run_dir, (self.cfg.runs_path / "r-master").resolve())

    def test_find_run_resolves_worktree(self) -> None:
        sub = runs_mod.workbench_subpath(self.cfg)
        self.assertIsNotNone(sub)
        wt_run_dir = self.wt1 / sub / "runs" / "r-wt1"
        _seed_run(wt_run_dir, "r-wt1",
                  worktree_path=str(self.wt1), status="building")
        run = runs_mod.find_run(self.cfg, "r-wt1")
        self.assertEqual(run.run_id, "r-wt1")
        self.assertEqual(run.source, runs_mod.SOURCE_WORKTREE)
        self.assertEqual(run.run_dir, wt_run_dir.resolve())

    def test_find_run_raises_not_found(self) -> None:
        with self.assertRaises(runs_mod.RunNotFound):
            runs_mod.find_run(self.cfg, "nope")

    def test_find_run_raises_collision_with_both_paths(self) -> None:
        sub = runs_mod.workbench_subpath(self.cfg)
        wt_run_dir = self.wt1 / sub / "runs" / "r-dup"
        master_run_dir = self.cfg.runs_path / "r-dup"
        # On master: pretend it's been merged in but ALSO still on the
        # worktree (the bug we tolerate). To trigger collision we need both
        # to surface in the walk — i.e. the worktree copy must NOT be
        # status=done/abandoned (those get skipped).
        _seed_run(master_run_dir, "r-dup", worktree_path=str(self.wt1),
                  status="building")
        _seed_run(wt_run_dir, "r-dup", worktree_path=str(self.wt1),
                  status="building")
        with self.assertRaises(runs_mod.RunCollision) as cm:
            runs_mod.find_run(self.cfg, "r-dup")
        self.assertIn(str(master_run_dir), str(cm.exception))
        self.assertIn(str(wt_run_dir), str(cm.exception))

    def test_removed_worktree_invisible(self) -> None:
        sub = runs_mod.workbench_subpath(self.cfg)
        wt_run_dir = self.wt1 / sub / "runs" / "r-removed"
        _seed_run(wt_run_dir, "r-removed", worktree_path=str(self.wt1),
                  status="building")
        runs_mod.reset_caches()
        run = runs_mod.find_run(self.cfg, "r-removed")
        self.assertEqual(run.run_id, "r-removed")
        # Remove worktree from git's perspective; the runs/ dir on disk
        # still exists but is no longer enumerated.
        subprocess.run(
            ["git", "-C", str(self.tmp), "worktree", "remove", "--force", str(self.wt1)],
            check=True,
        )
        runs_mod.reset_caches()
        with self.assertRaises(runs_mod.RunNotFound):
            runs_mod.find_run(self.cfg, "r-removed")

    def test_iter_all_runs_yields_master_and_worktree(self) -> None:
        sub = runs_mod.workbench_subpath(self.cfg)
        _seed_run(self.cfg.runs_path / "r-m", "r-m",
                  worktree_path=None, status="done")
        _seed_run(self.wt1 / sub / "runs" / "r-1", "r-1",
                  worktree_path=str(self.wt1), status="building")
        _seed_run(self.wt2 / sub / "runs" / "r-2", "r-2",
                  worktree_path=str(self.wt2), status="building")
        runs_mod.reset_caches()
        ids = sorted(r.run_id for r in runs_mod.iter_all_runs(self.cfg))
        self.assertEqual(ids, ["r-1", "r-2", "r-m"])


class TestWalkWorktreesStaleMasterCarveOut(unittest.TestCase):
    """`_walk_worktrees` should yield terminal-state worktree hits when the
    master-side metadata is stale (TODO §1 Y scope, 2026-05-27).

    When master and worktree both say `done`, the worktree hit is just merged
    history and should be skipped. When master is still `human_review` but
    the worktree has progressed to `done`, the worktree is the more recent
    truth and must surface in `iter_all_runs` (otherwise `board` shows a
    stale-`human_review` ghost while `list` shows `done`).
    """

    def setUp(self) -> None:
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="aw-stale-master-"))
        _init_repo(self.tmp)
        shutil.copy(ROOT / "agent-workbench.yaml", self.tmp / "agent-workbench.yaml")
        shutil.copytree(ROOT / "schemas", self.tmp / "schemas")
        self.wt = self.tmp / "wt"
        _add_worktree(self.tmp, "agent/wt-stale", self.wt)
        self.cfg = config.load(self.tmp)
        reset_caches()

    def tearDown(self) -> None:
        reset_caches()
        cleanup(self.tmp)

    def _seed_collision(self, run_id: str, *, master_status: str,
                        worktree_status: str) -> None:
        """Create the same run in both master and worktree with different statuses."""
        sub = runs_mod.workbench_subpath(self.cfg)
        master_dir = self.cfg.runs_path / run_id
        wt_dir = self.wt / sub / "runs" / run_id
        _seed_run(master_dir, run_id, worktree_path=str(self.wt),
                  status=master_status)
        _seed_run(wt_dir, run_id, worktree_path=str(self.wt),
                  status=worktree_status)
        runs_mod.reset_caches()

    def test_walk_worktrees_prefers_terminal_worktree_when_master_stale(self) -> None:
        """Master says human_review, worktree says done → worktree wins."""
        self._seed_collision("r-stale", master_status="human_review",
                             worktree_status="done")
        runs = list(runs_mod._walk_worktrees(self.cfg))
        ids = [r.run_id for r in runs]
        self.assertIn("r-stale", ids,
                      "stale-master carve-out: worktree's done should surface "
                      "when master disagrees")
        kept = next(r for r in runs if r.run_id == "r-stale")
        self.assertEqual(kept.status, "done")
        self.assertEqual(kept.source, runs_mod.SOURCE_WORKTREE)

    def test_walk_worktrees_skips_terminal_worktree_when_master_agrees(self) -> None:
        """Both copies say done → worktree hit is just history, skip it."""
        self._seed_collision("r-clean", master_status="done",
                             worktree_status="done")
        runs = list(runs_mod._walk_worktrees(self.cfg))
        ids = [r.run_id for r in runs]
        self.assertNotIn("r-clean", ids,
                         "common case: worktree's done hit should be skipped "
                         "when master also says done (it's just merged "
                         "history checked out here)")

    def test_walk_worktrees_skips_when_master_file_missing(self) -> None:
        """No master-side metadata file at all → skip the worktree hit.

        Matches today's terminal-state-skip behavior. The carve-out only
        kicks in when master *exists* and *disagrees*.
        """
        sub = runs_mod.workbench_subpath(self.cfg)
        wt_dir = self.wt / sub / "runs" / "r-no-master"
        _seed_run(wt_dir, "r-no-master", worktree_path=str(self.wt),
                  status="done")
        runs_mod.reset_caches()
        runs = list(runs_mod._walk_worktrees(self.cfg))
        ids = [r.run_id for r in runs]
        self.assertNotIn("r-no-master", ids)


class TestIsSelfModifying(unittest.TestCase):
    """Self-modifying detection: workbench inside the target repo."""

    def setUp(self) -> None:
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="aw-runs-sm-"))
        _init_repo(self.tmp)
        shutil.copy(ROOT / "agent-workbench.yaml", self.tmp / "agent-workbench.yaml")
        shutil.copytree(ROOT / "schemas", self.tmp / "schemas")
        self.cfg = config.load(self.tmp)
        reset_caches()

    def tearDown(self) -> None:
        reset_caches()
        cleanup(self.tmp)

    def test_target_is_workbench_root_is_self_modifying(self) -> None:
        meta = {"target": {"repo": {"path": str(self.tmp)}}}
        self.assertTrue(runs_mod.is_self_modifying(self.cfg, meta))

    def test_unrelated_repo_is_not_self_modifying(self) -> None:
        other = pathlib.Path(tempfile.mkdtemp(prefix="aw-other-"))
        try:
            _init_repo(other)
            meta = {"target": {"repo": {"path": str(other)}}}
            self.assertFalse(runs_mod.is_self_modifying(self.cfg, meta))
        finally:
            cleanup(other)


class TestListRunsUnion(unittest.TestCase):
    """metadata.list_runs delegates to iter_all_runs."""

    def setUp(self) -> None:
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="aw-list-"))
        _init_repo(self.tmp)
        shutil.copy(ROOT / "agent-workbench.yaml", self.tmp / "agent-workbench.yaml")
        shutil.copytree(ROOT / "schemas", self.tmp / "schemas")
        self.wt = self.tmp / "wt"
        _add_worktree(self.tmp, "agent/wt", self.wt)
        self.cfg = config.load(self.tmp)
        reset_caches()

    def tearDown(self) -> None:
        reset_caches()
        cleanup(self.tmp)

    def test_list_runs_includes_worktrees(self) -> None:
        sub = runs_mod.workbench_subpath(self.cfg)
        _seed_run(self.cfg.runs_path / "r-master", "r-master",
                  worktree_path=None, status="done")
        _seed_run(self.wt / sub / "runs" / "r-wt", "r-wt",
                  worktree_path=str(self.wt), status="building")
        runs_mod.reset_caches()
        ids = metadata.list_runs(self.cfg)
        self.assertIn("r-master", ids)
        self.assertIn("r-wt", ids)


class TestWorktreeCacheTTL(unittest.TestCase):
    """`_WORKTREE_CACHE` honours a short TTL so the long-running board picks
    up worktrees created after startup.

    These tests monkey-patch `subprocess.run` to count git invocations rather
    than relying on real `git worktree list`, so the assertions stay
    deterministic regardless of how many worktrees the test environment has.
    """

    def setUp(self) -> None:
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="aw-ttl-test-"))
        _init_repo(self.tmp)
        shutil.copy(ROOT / "agent-workbench.yaml", self.tmp / "agent-workbench.yaml")
        shutil.copytree(ROOT / "schemas", self.tmp / "schemas")
        self.cfg = config.load(self.tmp)
        reset_caches()

    def tearDown(self) -> None:
        reset_caches()
        cleanup(self.tmp)

    def _patch_clock_and_git(self, clock, git_calls):
        """Patch runs_mod.time.monotonic and runs_mod.subprocess.run."""
        original_monotonic = runs_mod.time.monotonic
        original_run = runs_mod.subprocess.run

        def fake_monotonic():
            return clock["now"]

        def fake_run(cmd, **kwargs):
            git_calls.append(cmd)
            # Minimal `git worktree list --porcelain` reply: just the main
            # repo, no other worktrees. Matches what _flush would parse.
            class _R:
                returncode = 0
                stdout = f"worktree {self.tmp}\n\n"
                stderr = ""
            return _R()

        runs_mod.time.monotonic = fake_monotonic
        runs_mod.subprocess.run = fake_run
        self.addCleanup(lambda: setattr(runs_mod.time, "monotonic", original_monotonic))
        self.addCleanup(lambda: setattr(runs_mod.subprocess, "run", original_run))

    def test_cache_hit_within_ttl_invokes_git_once(self) -> None:
        clock = {"now": 100.0}
        git_calls: list = []
        self._patch_clock_and_git(clock, git_calls)
        # Two calls within TTL — only one git invocation expected.
        runs_mod._list_workbench_worktrees(self.cfg, ttl=2.0)
        clock["now"] += 1.0  # within TTL
        runs_mod._list_workbench_worktrees(self.cfg, ttl=2.0)
        self.assertEqual(len(git_calls), 1)

    def test_cache_miss_past_ttl_invokes_git_again(self) -> None:
        clock = {"now": 100.0}
        git_calls: list = []
        self._patch_clock_and_git(clock, git_calls)
        runs_mod._list_workbench_worktrees(self.cfg, ttl=2.0)
        clock["now"] += 2.5  # past TTL
        runs_mod._list_workbench_worktrees(self.cfg, ttl=2.0)
        self.assertEqual(len(git_calls), 2)

    def test_config_supplies_ttl(self) -> None:
        # When ttl kwarg is None, the cfg-supplied value is used.
        # We mutate cfg.raw to set worktree_cache_ttl_seconds = 0.05.
        self.cfg.raw.setdefault("board", {})["worktree_cache_ttl_seconds"] = 0.05
        clock = {"now": 100.0}
        git_calls: list = []
        self._patch_clock_and_git(clock, git_calls)
        runs_mod._list_workbench_worktrees(self.cfg)
        clock["now"] += 0.1  # past the configured TTL
        runs_mod._list_workbench_worktrees(self.cfg)
        self.assertEqual(len(git_calls), 2)

    def test_zero_or_negative_ttl_clamped_to_minimum(self) -> None:
        """A configured TTL of 0 (or negative) would defeat the cache's purpose
        and is forbidden by the module docstring. _resolve_worktree_cache_ttl
        clamps to a small positive floor so the cache still bounds git calls.
        """
        # Direct call.
        self.assertGreaterEqual(
            runs_mod._resolve_worktree_cache_ttl(self.cfg, 0.0),
            runs_mod._WORKTREE_CACHE_TTL_MIN_SECONDS,
        )
        self.assertGreaterEqual(
            runs_mod._resolve_worktree_cache_ttl(self.cfg, -1.5),
            runs_mod._WORKTREE_CACHE_TTL_MIN_SECONDS,
        )
        # Via cfg.raw.
        self.cfg.raw.setdefault("board", {})["worktree_cache_ttl_seconds"] = 0
        self.assertGreaterEqual(
            runs_mod._resolve_worktree_cache_ttl(self.cfg, None),
            runs_mod._WORKTREE_CACHE_TTL_MIN_SECONDS,
        )

    def test_failure_path_caches_empty_for_ttl(self) -> None:
        """Subprocess failures still populate the cache so a single transient
        git error doesn't make us hammer git for the rest of the window.
        """
        original_run = runs_mod.subprocess.run
        original_monotonic = runs_mod.time.monotonic
        clock = {"now": 100.0}
        git_calls: list = []

        def fake_run(cmd, **kwargs):
            git_calls.append(cmd)
            raise OSError("synthetic git failure")

        runs_mod.time.monotonic = lambda: clock["now"]
        runs_mod.subprocess.run = fake_run
        self.addCleanup(lambda: setattr(runs_mod.subprocess, "run", original_run))
        self.addCleanup(lambda: setattr(runs_mod.time, "monotonic", original_monotonic))

        result1 = runs_mod._list_workbench_worktrees(self.cfg, ttl=2.0)
        clock["now"] += 1.0  # within TTL
        result2 = runs_mod._list_workbench_worktrees(self.cfg, ttl=2.0)
        self.assertEqual(result1, ())
        self.assertEqual(result2, ())
        self.assertEqual(len(git_calls), 1)


if __name__ == "__main__":
    unittest.main()
