"""Unit tests for lib.repo_config — focused on the project_subpath feature."""

import sys
import tempfile
import unittest
from pathlib import Path
from textwrap import dedent

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lib.repo_config import ConfigError, load_config, validate_paths_on_disk


def _write_config(td: Path, body: str) -> Path:
    cfg = td / "repos.yaml"
    cfg.write_text(dedent(body).lstrip())
    return cfg


class TestProjectSubpath(unittest.TestCase):
    def test_default_empty_subpath_means_project_is_git_root(self):
        with tempfile.TemporaryDirectory() as td:
            cfg = _write_config(Path(td), """
                repos:
                  foo:
                    path: /tmp/foo
                    github: org/foo
                    default_branch: main
            """)
            entries = load_config(cfg)
            self.assertEqual(entries["foo"].project_subpath, "")
            self.assertEqual(entries["foo"].project_dir, Path("/tmp/foo"))

    def test_subpath_resolves_under_git_root(self):
        with tempfile.TemporaryDirectory() as td:
            cfg = _write_config(Path(td), """
                repos:
                  cards:
                    path: /tmp/monorepo
                    project_subpath: cards-game
                    github: org/monorepo
                    default_branch: master
            """)
            entries = load_config(cfg)
            self.assertEqual(entries["cards"].project_subpath, "cards-game")
            self.assertEqual(
                entries["cards"].project_dir,
                Path("/tmp/monorepo/cards-game"),
            )

    def test_absolute_subpath_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            cfg = _write_config(Path(td), """
                repos:
                  bad:
                    path: /tmp/foo
                    project_subpath: /not/relative
                    github: org/foo
                    default_branch: main
            """)
            with self.assertRaises(ConfigError):
                load_config(cfg)

    def test_dotdot_in_subpath_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            cfg = _write_config(Path(td), """
                repos:
                  bad:
                    path: /tmp/foo
                    project_subpath: ../escape
                    github: org/foo
                    default_branch: main
            """)
            with self.assertRaises(ConfigError):
                load_config(cfg)

    def test_unknown_field_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            cfg = _write_config(Path(td), """
                repos:
                  bad:
                    path: /tmp/foo
                    github: org/foo
                    default_branch: main
                    bogus_field: yes
            """)
            with self.assertRaises(ConfigError):
                load_config(cfg)


class TestValidatePathsOnDisk(unittest.TestCase):
    def test_subpath_must_exist_when_set(self):
        with tempfile.TemporaryDirectory() as td:
            git_root = Path(td) / "monorepo"
            git_root.mkdir()
            (git_root / ".git").mkdir()
            # project_subpath points at a dir that doesn't exist
            cfg = _write_config(Path(td), f"""
                repos:
                  cards:
                    path: {git_root}
                    project_subpath: cards-game
                    github: org/monorepo
                    default_branch: master
            """)
            entries = load_config(cfg)
            problems = validate_paths_on_disk(entries)
            self.assertEqual(len(problems), 1)
            self.assertIn("project_subpath does not exist", problems[0])

    def test_subpath_exists_no_problems(self):
        with tempfile.TemporaryDirectory() as td:
            git_root = Path(td) / "monorepo"
            (git_root / "cards-game").mkdir(parents=True)
            (git_root / ".git").mkdir()
            cfg = _write_config(Path(td), f"""
                repos:
                  cards:
                    path: {git_root}
                    project_subpath: cards-game
                    github: org/monorepo
                    default_branch: master
            """)
            entries = load_config(cfg)
            self.assertEqual(validate_paths_on_disk(entries), [])


if __name__ == "__main__":
    unittest.main()
