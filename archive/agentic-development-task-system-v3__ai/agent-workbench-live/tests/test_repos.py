"""Unit tests for lib/repos helpers added to support cmd_complete's auto-merge.

Covers `worktree_dirty_files`, `worktree_is_clean`, `current_branch`,
`resolve_parent_branch`, and `merge_no_ff` against throwaway git repos.
"""
from __future__ import annotations

import pathlib
import shutil
import subprocess
import tempfile
import unittest

import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from lib import repos  # noqa: E402


def _run(cwd: pathlib.Path, *args: str) -> str:
    out = subprocess.run(
        ["git", "-C", str(cwd), *args],
        check=True, capture_output=True, text=True,
    )
    return out.stdout


def _git_init(path: pathlib.Path) -> None:
    _run(path, "init", "-q", "-b", "main")
    _run(path, "config", "user.email", "test@x")
    _run(path, "config", "user.name", "test")


def _commit(path: pathlib.Path, file_rel: str, body: str, message: str) -> str:
    (path / file_rel).write_text(body)
    _run(path, "add", file_rel)
    _run(path, "commit", "-q", "-m", message)
    return _run(path, "rev-parse", "HEAD").strip()


class _RepoTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="aw-repos-test-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)


class TestWorktreeDirtyHelpers(_RepoTestCase):
    """worktree_dirty_files + worktree_is_clean."""

    def test_clean_after_init_with_commits(self) -> None:
        _git_init(self.tmp)
        _commit(self.tmp, "a.txt", "hello\n", "init")
        self.assertEqual(repos.worktree_dirty_files(self.tmp), [])
        self.assertTrue(repos.worktree_is_clean(self.tmp))

    def test_dirty_with_unstaged_change(self) -> None:
        _git_init(self.tmp)
        _commit(self.tmp, "a.txt", "hello\n", "init")
        (self.tmp / "a.txt").write_text("dirty\n")
        dirty = repos.worktree_dirty_files(self.tmp)
        self.assertIn("a.txt", dirty)
        self.assertFalse(repos.worktree_is_clean(self.tmp))

    def test_dirty_with_untracked_file(self) -> None:
        _git_init(self.tmp)
        _commit(self.tmp, "a.txt", "hello\n", "init")
        (self.tmp / "new.txt").write_text("x")
        dirty = repos.worktree_dirty_files(self.tmp)
        self.assertIn("new.txt", dirty)

    def test_dirty_with_staged_change(self) -> None:
        _git_init(self.tmp)
        _commit(self.tmp, "a.txt", "hello\n", "init")
        (self.tmp / "b.txt").write_text("staged")
        _run(self.tmp, "add", "b.txt")
        dirty = repos.worktree_dirty_files(self.tmp)
        self.assertIn("b.txt", dirty)

    def test_run_lock_file_is_gitignored(self) -> None:
        """Per-run .lock files inside the workbench runs/ tree must not show
        up as dirty — that was the bug `/complete` kept hitting before the
        root .gitignore gained the workbench-scoped pattern.
        """
        _git_init(self.tmp)
        _commit(self.tmp, "a.txt", "hello\n", "init")
        gitignore_path = self.tmp / ".gitignore"
        gitignore_path.write_text(
            "agentic-development-task-system-v3__ai/"
            "agent-workbench-live/runs/*/.lock\n"
        )
        _run(self.tmp, "add", ".gitignore")
        _run(self.tmp, "commit", "-q", "-m", "ignore lock")
        run_dir = (
            self.tmp
            / "agentic-development-task-system-v3__ai"
            / "agent-workbench-live"
            / "runs"
            / "2026-05-25-fixture"
        )
        run_dir.mkdir(parents=True)
        (run_dir / ".lock").write_text("")
        self.assertEqual(repos.worktree_dirty_files(self.tmp), [])
        self.assertTrue(repos.worktree_is_clean(self.tmp))


class TestResolveParentBranch(_RepoTestCase):
    def test_head_resolves_to_current_branch(self) -> None:
        _git_init(self.tmp)
        _commit(self.tmp, "a.txt", "hello\n", "init")
        self.assertEqual(repos.resolve_parent_branch(self.tmp, "HEAD"), "main")

    def test_explicit_branch_returns_as_is(self) -> None:
        _git_init(self.tmp)
        _commit(self.tmp, "a.txt", "hello\n", "init")
        _run(self.tmp, "checkout", "-b", "feature")
        # main still exists; ask for it explicitly
        self.assertEqual(repos.resolve_parent_branch(self.tmp, "main"), "main")

    def test_missing_branch_raises(self) -> None:
        _git_init(self.tmp)
        _commit(self.tmp, "a.txt", "hello\n", "init")
        with self.assertRaises(repos.RepoError):
            repos.resolve_parent_branch(self.tmp, "no-such-branch")


class TestResolveRefToSha(_RepoTestCase):
    """resolve_ref_to_sha: HEAD / branch-name / missing-ref."""

    def test_head_resolves_to_full_sha(self) -> None:
        _git_init(self.tmp)
        sha = _commit(self.tmp, "a.txt", "hello\n", "init")
        self.assertEqual(repos.resolve_ref_to_sha(self.tmp, "HEAD"), sha)

    def test_branch_name_resolves_to_full_sha(self) -> None:
        _git_init(self.tmp)
        sha = _commit(self.tmp, "a.txt", "hello\n", "init")
        self.assertEqual(repos.resolve_ref_to_sha(self.tmp, "main"), sha)

    def test_missing_ref_raises(self) -> None:
        _git_init(self.tmp)
        _commit(self.tmp, "a.txt", "hello\n", "init")
        with self.assertRaises(repos.RepoError):
            repos.resolve_ref_to_sha(self.tmp, "no-such-ref-xyz")


class TestCurrentBranch(_RepoTestCase):
    def test_returns_branch_name(self) -> None:
        _git_init(self.tmp)
        _commit(self.tmp, "a.txt", "hello\n", "init")
        self.assertEqual(repos.current_branch(self.tmp), "main")

    def test_detached_head_returns_none(self) -> None:
        _git_init(self.tmp)
        sha = _commit(self.tmp, "a.txt", "hello\n", "init")
        _run(self.tmp, "checkout", sha)  # detached HEAD
        self.assertIsNone(repos.current_branch(self.tmp))


class TestMergeNoFf(_RepoTestCase):
    def _setup_two_branch_repo(self) -> tuple[str, str]:
        """Init repo with `main` + a feature branch. Returns (main_sha, feat_sha)."""
        _git_init(self.tmp)
        main_sha = _commit(self.tmp, "a.txt", "hello\n", "init main")
        _run(self.tmp, "checkout", "-b", "feature")
        feat_sha = _commit(self.tmp, "b.txt", "feature change\n", "add b")
        _run(self.tmp, "checkout", "main")
        return main_sha, feat_sha

    def test_happy_merge_records_no_ff(self) -> None:
        _main_sha, feat_sha = self._setup_two_branch_repo()
        merge_sha = repos.merge_no_ff(
            self.tmp, parent_branch="main", worktree_branch="feature",
            message="merge feat",
        )
        # Returned SHA is the parent branch's new HEAD.
        self.assertEqual(merge_sha, _run(self.tmp, "rev-parse", "main").strip())
        # It's a merge commit (has 2 parents).
        parents = _run(self.tmp, "rev-list", "--parents", "-n", "1", merge_sha).split()
        self.assertEqual(len(parents), 3)  # commit + 2 parents
        # The feature commit is reachable from the merge commit.
        ancestors = _run(self.tmp, "rev-list", merge_sha).split()
        self.assertIn(feat_sha, ancestors)

    def test_happy_merge_restores_original_branch(self) -> None:
        """When we start on a different branch, success restores it via `checkout -`."""
        self._setup_two_branch_repo()
        # Make a third branch and start on it.
        _run(self.tmp, "checkout", "-b", "side")
        repos.merge_no_ff(
            self.tmp, parent_branch="main", worktree_branch="feature",
        )
        # After the merge, we should be back on `side`.
        self.assertEqual(repos.current_branch(self.tmp), "side")

    def test_dirty_repo_refuses(self) -> None:
        self._setup_two_branch_repo()
        (self.tmp / "dirty.txt").write_text("uncommitted")
        with self.assertRaises(repos.RepoError):
            repos.merge_no_ff(
                self.tmp, parent_branch="main", worktree_branch="feature",
            )

    def test_missing_parent_branch_refuses(self) -> None:
        self._setup_two_branch_repo()
        with self.assertRaises(repos.RepoError):
            repos.merge_no_ff(
                self.tmp, parent_branch="nope", worktree_branch="feature",
            )

    def test_missing_worktree_branch_refuses(self) -> None:
        self._setup_two_branch_repo()
        with self.assertRaises(repos.RepoError):
            repos.merge_no_ff(
                self.tmp, parent_branch="main", worktree_branch="nope",
            )

    def test_conflict_aborts_and_raises(self) -> None:
        """A conflicting merge runs `git merge --abort` and raises with file list."""
        _git_init(self.tmp)
        _commit(self.tmp, "f.txt", "main line 1\n", "init main")
        _run(self.tmp, "checkout", "-b", "feature")
        _commit(self.tmp, "f.txt", "feature change\n", "feat change")
        _run(self.tmp, "checkout", "main")
        # Conflicting commit on main.
        _commit(self.tmp, "f.txt", "main change\n", "main change")

        with self.assertRaises(repos.MergeConflictError) as ctx:
            repos.merge_no_ff(
                self.tmp, parent_branch="main", worktree_branch="feature",
            )
        self.assertIn("f.txt", ctx.exception.conflicted_files)

        # After --abort, working tree is clean.
        self.assertTrue(repos.worktree_is_clean(self.tmp))
        # And we're still on main (where the abort left us).
        self.assertEqual(repos.current_branch(self.tmp), "main")


class TestRemoveWorktree(_RepoTestCase):
    """remove_worktree drops the worktree dir and its git registration."""

    def _setup_with_worktree(self) -> tuple[pathlib.Path, pathlib.Path, str]:
        _git_init(self.tmp)
        _commit(self.tmp, "a.txt", "hello\n", "init")
        wt = self.tmp.parent / (self.tmp.name + "-wt")
        repos.create_worktree(self.tmp, "feature", wt, "main")
        return self.tmp, wt, "feature"

    def test_remove_worktree_cleans_up_path(self) -> None:
        repo, wt, _branch = self._setup_with_worktree()
        self.assertTrue(wt.exists())
        repos.remove_worktree(repo, wt, force=True)
        self.assertFalse(wt.exists())
        # `git worktree list` no longer shows the path.
        listing = _run(repo, "worktree", "list", "--porcelain")
        self.assertNotIn(str(wt), listing)

    def test_remove_worktree_missing_path_raises(self) -> None:
        _git_init(self.tmp)
        _commit(self.tmp, "a.txt", "hello\n", "init")
        bogus = self.tmp.parent / "not-a-worktree"
        with self.assertRaises(repos.RepoError):
            repos.remove_worktree(self.tmp, bogus, force=True)


class TestDeleteBranch(_RepoTestCase):
    """delete_branch removes the local ref."""

    def test_delete_branch_removes_ref(self) -> None:
        _git_init(self.tmp)
        _commit(self.tmp, "a.txt", "hello\n", "init")
        _run(self.tmp, "branch", "scratch")
        # Sanity: branch is there.
        self.assertTrue(repos.branch_exists(self.tmp, "scratch"))
        repos.delete_branch(self.tmp, "scratch")
        self.assertFalse(repos.branch_exists(self.tmp, "scratch"))

    def test_delete_missing_branch_raises(self) -> None:
        _git_init(self.tmp)
        _commit(self.tmp, "a.txt", "hello\n", "init")
        with self.assertRaises(repos.RepoError):
            repos.delete_branch(self.tmp, "no-such-branch")


if __name__ == "__main__":
    unittest.main()
