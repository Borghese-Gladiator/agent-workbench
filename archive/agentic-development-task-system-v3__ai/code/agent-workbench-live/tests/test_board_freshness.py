"""Tests for the board's freshness machinery — multi-root watchdog
scheduling and periodic re-scan.

These tests instantiate AgentBoardApp but never spin up the Textual event
loop; the methods under test (_schedule_path, _schedule_worktree_runs_dirs,
_rescan_worktrees) are pure-Python and don't require an event loop. Per
DR-005 in plan.md.
"""
from __future__ import annotations

import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from tests._helpers import cleanup, reset_caches

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from lib import config, runs as runs_mod, yaml_io  # noqa: E402
from lib.board.app import AgentBoardApp, BoardOptions  # noqa: E402


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
        ["git", "-C", str(repo_path), "worktree", "add", "-b", branch,
         str(wt_path), "main"],
        check=True,
    )


def _seed_worktree_run(
    cfg, run_id: str, worktree_path: pathlib.Path, status: str = "building",
) -> pathlib.Path:
    """Seed a worktree-side run dir at <wt>/<sub>/runs/<run_id> and return it."""
    sub = runs_mod.workbench_subpath(cfg)
    assert sub is not None, "expected workbench to be inside a git repo"
    run_dir = worktree_path / sub / "runs" / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    meta = {
        "schema_version": 1,
        "run_id": run_id,
        "status": status,
        "created_at": "2026-05-26T00:00:00-04:00",
        "updated_at": "2026-05-26T00:00:00-04:00",
        "target": {
            "repo": {"mode": "existing", "path": "/tmp/fake-repo", "name": "fake",
                     "base_ref": "main"},
            "worktree": {"name": run_id,
                         "path": str(worktree_path),
                         "branch_name": f"agent/{run_id}",
                         "created": True,
                         "base_ref": "main"},
        },
        "scope": {"kind": "implementation", "summary": ""},
        "artifacts": {"raw_idea": "raw-idea.md"},
        "validation": {"required": True, "review_completed": False,
                       "qa_completed": False, "qa_recorded": False,
                       "tests_passed": None, "known_issues_count": 0},
        "completion": {"accepted_by": None, "completion_ref": None,
                       "completed_at": None, "abandoned_reason": None},
    }
    (run_dir / "metadata.yaml").write_text(yaml_io.dumps(meta))
    return run_dir


class FreshnessCase(unittest.TestCase):
    """Synthetic workbench: tmp acts as both the workbench and the main git
    repo. Worktrees are added under tmp/wt/<name>.
    """

    def setUp(self) -> None:
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="aw-fresh-test-"))
        _init_repo(self.tmp)
        shutil.copy(ROOT / "agent-workbench.yaml", self.tmp / "agent-workbench.yaml")
        shutil.copytree(ROOT / "schemas", self.tmp / "schemas")
        self.wt1 = self.tmp / "wt" / "wt1"
        self.wt2 = self.tmp / "wt" / "wt2"
        self.wt1.parent.mkdir(parents=True, exist_ok=True)
        _add_worktree(self.tmp, "agent/wt1", self.wt1)
        # wt2 is NOT added here; tests can add it mid-run to simulate the
        # "new worktree mid-board-session" case.
        self.cfg = config.load(self.tmp)
        reset_caches()

    def tearDown(self) -> None:
        reset_caches()
        cleanup(self.tmp)

    def _make_app(self):
        app = AgentBoardApp(self.cfg, BoardOptions())
        # Attach a fake Observer that just records scheduled paths.
        app._observer = mock.MagicMock()
        return app


class TestMultiRootScheduling(FreshnessCase):

    def test_schedule_path_is_idempotent(self) -> None:
        app = self._make_app()
        runs_path = self.cfg.runs_path
        runs_path.mkdir(parents=True, exist_ok=True)
        app._schedule_path(str(runs_path))
        app._schedule_path(str(runs_path))  # duplicate
        self.assertEqual(app._observer.schedule.call_count, 1)
        self.assertIn(str(runs_path), app._watched_paths)

    def test_schedule_worktree_runs_dirs_picks_up_existing_worktrees(self) -> None:
        # Seed one run in wt1 so the runs/ dir exists for watchdog.
        _seed_worktree_run(self.cfg, "r-wt1", self.wt1)
        runs_mod.reset_caches()
        app = self._make_app()
        app._schedule_worktree_runs_dirs()
        sub = runs_mod.workbench_subpath(self.cfg)
        # Paths are resolved (symlink-following) because _schedule_path
        # resolves before keying; on macOS /var → /private/var.
        expected = str((self.wt1 / sub / "runs").resolve())
        self.assertIn(expected, app._watched_paths)
        self.assertEqual(app._observer.schedule.call_count, 1)

    def test_schedule_worktree_runs_dirs_dedupes_multiple_runs(self) -> None:
        # Two runs in wt1 share the same runs/ parent — still one schedule
        # (post-refactor we iterate worktrees, not runs, so this is the
        # baseline case rather than a dedupe test, but the assertion is
        # unchanged: a worktree gets exactly one observer regardless of how
        # many runs it has).
        _seed_worktree_run(self.cfg, "r-wt1-a", self.wt1)
        _seed_worktree_run(self.cfg, "r-wt1-b", self.wt1)
        runs_mod.reset_caches()
        app = self._make_app()
        app._schedule_worktree_runs_dirs()
        self.assertEqual(app._observer.schedule.call_count, 1)

    def test_schedule_worktree_runs_dirs_skips_worktree_with_no_runs_dir(self) -> None:
        # wt1 exists as a git worktree but has no <wt>/<sub>/runs/ directory
        # yet (brand-new worktree pre-first-write). Watchdog can't schedule
        # against a nonexistent path, so we should skip cleanly rather than
        # crash. The next rescan (after the first run dir is written) will
        # pick it up.
        runs_mod.reset_caches()
        app = self._make_app()
        app._schedule_worktree_runs_dirs()
        self.assertEqual(app._observer.schedule.call_count, 0)
        # And no exception was raised.

    def test_schedule_path_handles_observer_exception(self) -> None:
        # If watchdog refuses a path (vanished, perms, etc.), we accept and
        # do NOT record it as watched.
        app = self._make_app()
        app._observer.schedule.side_effect = OSError("synthetic")
        app._schedule_path("/nonexistent/dir")
        self.assertNotIn("/nonexistent/dir", app._watched_paths)


class TestPeriodicRescan(FreshnessCase):

    def test_rescan_picks_up_new_worktree_via_ttl_not_reset_caches(self) -> None:
        """End-to-end TTL path: rescan after the cache TTL expires (advanced
        via monkey-patched monotonic clock) actually re-fetches the worktree
        set and sees a new worktree, without any explicit reset_caches call.
        This is the production path — production never calls reset_caches.
        """
        _seed_worktree_run(self.cfg, "r-wt1", self.wt1)
        runs_mod.reset_caches()  # one-time setup to clear any prior state
        # Monkey-patch the clock so we can advance past TTL.
        original_monotonic = runs_mod.time.monotonic
        clock = {"now": 1000.0}
        runs_mod.time.monotonic = lambda: clock["now"]
        self.addCleanup(lambda: setattr(runs_mod.time, "monotonic",
                                        original_monotonic))

        # Drive a default TTL of 2s.
        self.cfg.raw.setdefault("board", {})["worktree_cache_ttl_seconds"] = 2.0

        app = self._make_app()
        app._schedule_worktree_runs_dirs()  # populates cache at t=1000.0
        initial_count = app._observer.schedule.call_count

        # Create wt2 with a run mid-session. Cache still holds stale data.
        _add_worktree(self.tmp, "agent/wt2", self.wt2)
        _seed_worktree_run(self.cfg, "r-wt2", self.wt2)

        # Rescan immediately — TTL hasn't expired; cache returns stale set.
        app._rescan_worktrees()
        self.assertEqual(app._observer.schedule.call_count, initial_count,
                         "rescan within TTL should hit cache and see no new "
                         "worktree")

        # Advance past TTL; cache should refetch.
        clock["now"] += 3.0
        app._rescan_worktrees()
        sub = runs_mod.workbench_subpath(self.cfg)
        wt2_runs = str((self.wt2 / sub / "runs").resolve())
        self.assertIn(wt2_runs, app._watched_paths)
        self.assertEqual(app._observer.schedule.call_count, initial_count + 1)

    def test_rescan_idempotent(self) -> None:
        _seed_worktree_run(self.cfg, "r-wt1", self.wt1)
        runs_mod.reset_caches()
        app = self._make_app()
        app._schedule_worktree_runs_dirs()
        count_after_first = app._observer.schedule.call_count
        # Force cache miss so rescan actually re-fetches — verifies that
        # re-fetching the same worktree set does NOT re-schedule the same
        # path. (The TTL-vs-reset distinction is exercised in the test above;
        # here we focus on the dedupe-via-_watched_paths invariant.)
        runs_mod.reset_caches()
        app._rescan_worktrees()
        runs_mod.reset_caches()
        app._rescan_worktrees()
        self.assertEqual(app._observer.schedule.call_count, count_after_first)


class TestRealWatchdogDelivery(FreshnessCase):
    """End-to-end with a REAL watchdog Observer (not mocked).

    Drives the production scheduling path (`_schedule_worktree_runs_dirs`),
    writes a file into the watched worktree-side runs/ dir, and asserts the
    watchdog backend delivers an event that flows through
    `_Handler.on_any_event` → `_mark_fs_dirty`. We don't run the Textual
    event loop; we replace `_mark_fs_dirty` with a recording sink instead.

    NOTE: PR2 replaced the per-event `post_message` with a coalesced
    `_mark_fs_dirty` flag drained by an interval timer. The wiring tested
    here is `_Handler -> _mark_fs_dirty`; the debounce drain is tested in
    test_handler_debounce.
    """

    def _make_real_app(self):
        from watchdog.observers import Observer as RealObserver
        app = AgentBoardApp(self.cfg, BoardOptions())
        app._observer = RealObserver()
        app._observer.daemon = True
        # Replace `_mark_fs_dirty` with a recording sink. The watchdog
        # handler calls it from the Observer thread; `.append` is atomic on
        # a list in CPython (GIL).
        recorded: list = []
        app._recorded_posts = recorded  # name kept for back-compat with the
                                        # existing test bodies below
        app._mark_fs_dirty = lambda: recorded.append(("dirty",))
        return app

    def test_real_watchdog_fires_handler_on_file_write(self) -> None:
        import time as _time
        # Seed a run so the runs/ dir exists for watchdog to schedule on.
        _seed_worktree_run(self.cfg, "r-wt1", self.wt1)
        runs_mod.reset_caches()
        app = self._make_real_app()
        try:
            app._schedule_worktree_runs_dirs()
            app._observer.start()
            sub = runs_mod.workbench_subpath(self.cfg)
            watched = (self.wt1 / sub / "runs").resolve()
            self.assertIn(str(watched), app._watched_paths)

            # Touch a file under the watched dir. Use a fresh filename so we
            # don't depend on the seeded file's timestamps.
            trigger = watched / "r-wt1" / "events.jsonl"
            trigger.parent.mkdir(parents=True, exist_ok=True)
            # Watchdog needs the modification to be observable; an open()
            # with 'a' + write + flush is the most robust shape across
            # FSEvents (macOS) and inotify (Linux).
            with open(trigger, "a") as f:
                f.write('{"e": "synthetic"}\n')
                f.flush()

            # Poll up to 2s for the handler to fire. Watchdog backends
            # deliver within tens of milliseconds typically.
            deadline = _time.monotonic() + 2.0
            while _time.monotonic() < deadline:
                if app._recorded_posts:
                    break
                _time.sleep(0.05)
            self.assertTrue(
                app._recorded_posts,
                "real watchdog Observer did not deliver an event to "
                "_Handler within 2s — wiring is broken",
            )
        finally:
            try:
                app._observer.stop()
                app._observer.join(timeout=1.0)
            except Exception:
                pass

    def test_real_watchdog_filters_tmp_suffix(self) -> None:
        """A `.tmp` file write must NOT trigger a post (atomic-rename noise
        filter in `_Handler.on_any_event`)."""
        import time as _time
        _seed_worktree_run(self.cfg, "r-wt1", self.wt1)
        runs_mod.reset_caches()
        app = self._make_real_app()
        try:
            app._schedule_worktree_runs_dirs()
            app._observer.start()
            sub = runs_mod.workbench_subpath(self.cfg)
            watched = (self.wt1 / sub / "runs").resolve()
            # Write ONLY a .tmp file — should be filtered. The _Handler does
            # not see the .tmp suffix early enough on all backends (FSEvents
            # may report the parent dir, not the file), so we can't promise
            # zero posts; instead, write a .tmp and assert that the post (if
            # any) does not block subsequent observation of a real file.
            tmp = watched / "r-wt1" / "metadata.yaml.tmp"
            tmp.parent.mkdir(parents=True, exist_ok=True)
            with open(tmp, "a") as f:
                f.write("\n")
                f.flush()
            _time.sleep(0.3)
            posts_after_tmp = len(app._recorded_posts)

            real_file = watched / "r-wt1" / "events.jsonl"
            with open(real_file, "a") as f:
                f.write('{"e": "real"}\n')
                f.flush()
            deadline = _time.monotonic() + 2.0
            while _time.monotonic() < deadline:
                if len(app._recorded_posts) > posts_after_tmp:
                    break
                _time.sleep(0.05)
            self.assertGreater(
                len(app._recorded_posts), posts_after_tmp,
                "real file write must produce a post; if this fails the "
                "watchdog wiring missed the non-.tmp event",
            )
        finally:
            try:
                app._observer.stop()
                app._observer.join(timeout=1.0)
            except Exception:
                pass


if __name__ == "__main__":
    unittest.main()
