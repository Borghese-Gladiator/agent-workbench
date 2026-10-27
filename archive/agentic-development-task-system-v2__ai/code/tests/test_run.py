"""Unit tests for lib.run.

Run from the workbench root:
    PYTHONPATH=. python3 -m unittest discover tests
"""

import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lib import run as run_module
from lib.metadata import new_metadata, save
from lib.run import RunError, load_run


@contextmanager
def temp_workbench():
    """Spin up a tempdir, point lib.run's path constants at it, restore on exit."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp).resolve()
        runs_dir = root / "runs"
        runs_dir.mkdir()

        original_root = run_module.WORKBENCH_ROOT
        original_runs = run_module.RUNS_DIR
        run_module.WORKBENCH_ROOT = root
        run_module.RUNS_DIR = runs_dir
        try:
            yield root, runs_dir
        finally:
            run_module.WORKBENCH_ROOT = original_root
            run_module.RUNS_DIR = original_runs


def _seed_run(runs_dir: Path, run_id: str = "2026-05-07-foo-001") -> Path:
    run_dir = runs_dir / run_id
    run_dir.mkdir()
    md = new_metadata(
        run_id=run_id,
        feature_slug="foo",
        repo_key="frontend",
        repo_path="/tmp/frontend",
        github_repo="org/frontend",
        default_branch="main",
    )
    save(run_dir, md, touch_updated_at=False)
    return run_dir


class TestLoadRun(unittest.TestCase):
    def test_resolves_relative_path(self):
        with temp_workbench() as (root, runs_dir):
            _seed_run(runs_dir)
            info = load_run("runs/2026-05-07-foo-001")
            self.assertEqual(info.metadata.run_id, "2026-05-07-foo-001")
            self.assertEqual(info.run_dir, runs_dir / "2026-05-07-foo-001")
            self.assertEqual(info.workbench_root, root)

    def test_resolves_absolute_path(self):
        with temp_workbench() as (_root, runs_dir):
            run_dir = _seed_run(runs_dir)
            info = load_run(str(run_dir))
            self.assertEqual(info.metadata.run_id, "2026-05-07-foo-001")

    def test_empty_input_rejected(self):
        with self.assertRaises(RunError):
            load_run("")

    def test_missing_dir_rejected(self):
        with temp_workbench() as (_root, _runs_dir):
            with self.assertRaises(RunError) as cm:
                load_run("runs/2026-05-07-nope-001")
            self.assertIn("run dir not found", str(cm.exception))

    def test_path_outside_runs_rejected(self):
        with temp_workbench() as (root, _runs_dir):
            stray = root / "elsewhere"
            stray.mkdir()
            with self.assertRaises(RunError) as cm:
                load_run(str(stray))
            self.assertIn("must be under", str(cm.exception))

    def test_missing_metadata_rejected(self):
        with temp_workbench() as (_root, runs_dir):
            empty = runs_dir / "2026-05-07-empty-001"
            empty.mkdir()
            with self.assertRaises(RunError):
                load_run(str(empty))

    def test_invalid_metadata_rejected(self):
        with temp_workbench() as (_root, runs_dir):
            run_dir = runs_dir / "2026-05-07-bad-001"
            run_dir.mkdir()
            (run_dir / "metadata.yaml").write_text(
                "run_id: 2026-05-07-bad-001\nstatus: not_a_real_status\n"
            )
            with self.assertRaises(RunError):
                load_run(str(run_dir))


if __name__ == "__main__":
    unittest.main()
