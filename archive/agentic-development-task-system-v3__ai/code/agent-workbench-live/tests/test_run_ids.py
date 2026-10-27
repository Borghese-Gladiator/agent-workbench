"""Unit tests for lib/run_ids.py — slug / run_id / date / worktree helpers."""
from __future__ import annotations

import datetime as dt
import pathlib
import subprocess
import tempfile
import unittest

from lib import run_ids
from lib.cli.cmd_new_run import _canonical_repo_basename


class TestExtractRunDate(unittest.TestCase):
    def test_happy_paths(self):
        cases = [
            ("2026-05-21-foo", "20260521"),
            ("2026-12-31-some-longer-slug-here", "20261231"),
        ]
        for run_id, expected in cases:
            self.assertEqual(run_ids.extract_run_date(run_id), expected, msg=run_id)

    def test_rejects_bad_inputs(self):
        bad_inputs = [
            "",                       # empty
            "foo-bar-baz",            # no date prefix
            "99-99-99-foo",           # two-digit year, wrong shape
            "not-a-date-foo",         # garbage prefix
            "2026-05-21",             # missing trailing hyphen (bare date isn't a run_id)
        ]
        for bad in bad_inputs:
            with self.assertRaises(run_ids.NamingError, msg=bad):
                run_ids.extract_run_date(bad)


class TestSlugify(unittest.TestCase):
    def test_rejects_empty_or_punctuation(self):
        for bad in ["", "!!!---///"]:
            with self.assertRaises(run_ids.NamingError, msg=bad):
                run_ids.slugify(bad)

    def test_lowercase_kebab(self):
        self.assertEqual(run_ids.slugify("Hello World"), "hello-world")

    def test_unicode_stripped(self):
        # The "é" gets folded to "e" by NFKD, "ñ" to "n".
        self.assertEqual(run_ids.slugify("café piña"), "cafe-pina")


class TestMakeRunId(unittest.TestCase):
    def test_uses_provided_date(self):
        rid = run_ids.make_run_id("foo", today=dt.date(2026, 5, 21))
        self.assertEqual(rid, "2026-05-21-foo")
        # And it round-trips through extract_run_date.
        self.assertEqual(run_ids.extract_run_date(rid), "20260521")


class TestCanonicalRepoBasename(unittest.TestCase):
    """Cover the canonicalization that makes any subpath of the same repo
    derive the same `repo_name` (and so land worktrees under the same
    second-level dir).
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="aw-test-canonical-")
        # Resolve through any symlinks (e.g. macOS /var -> /private/var) so
        # later equality checks against git's own resolved toplevel match.
        self.tmpdir = pathlib.Path(self._tmp.name).resolve()

    def tearDown(self):
        self._tmp.cleanup()

    def _make_git_repo(self, name: str) -> pathlib.Path:
        repo = self.tmpdir / name
        repo.mkdir()
        subprocess.run(
            ["git", "init", "-q", "-b", "main", str(repo)],
            check=True, capture_output=True,
        )
        return repo

    def test_existing_repo_subpath_resolves_to_toplevel(self):
        repo = self._make_git_repo("monorepo-with-distinct-name")
        sub = repo / "sub" / "dir"
        sub.mkdir(parents=True)
        result = _canonical_repo_basename(sub, "existing")
        # Whatever subpath was passed, we land on the repo toplevel's name.
        self.assertEqual(result, "monorepo-with-distinct-name")

    def test_existing_repo_toplevel_resolves_to_itself(self):
        repo = self._make_git_repo("plain-toplevel")
        result = _canonical_repo_basename(repo, "existing")
        self.assertEqual(result, "plain-toplevel")

    def test_new_repo_mode_uses_path_basename(self):
        # In new-repo mode the directory may not even exist as a git repo yet
        # — toplevel resolution is skipped and the path's own basename wins.
        new_repo_path = self.tmpdir / "brand-new-repo"
        result = _canonical_repo_basename(new_repo_path, "new")
        self.assertEqual(result, "brand-new-repo")

    def test_non_git_path_falls_back_to_basename(self):
        # Existing directory that is NOT a git repo. Falls back gracefully
        # to the path's basename rather than crashing.
        non_git = self.tmpdir / "not-a-git-repo"
        non_git.mkdir()
        result = _canonical_repo_basename(non_git, "existing")
        self.assertEqual(result, "not-a-git-repo")

    def test_round_trip_through_derive_repo_name(self):
        # End-to-end: a subpath input slugifies to the toplevel-derived name,
        # not the subpath's basename. This is the assertion that would have
        # failed under the pre-canonicalization line cmd_new_run.py:54.
        repo = self._make_git_repo("Cool_Monorepo")
        sub = repo / "services" / "api"
        sub.mkdir(parents=True)
        repo_name = run_ids.derive_repo_name(
            _canonical_repo_basename(sub, "existing")
        )
        self.assertEqual(repo_name, "cool-monorepo")
        # And explicitly NOT the subpath basename.
        self.assertNotEqual(repo_name, "api")


if __name__ == "__main__":
    unittest.main()
