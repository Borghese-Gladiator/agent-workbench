"""Git + worktree manager.

All git invocations use `git -C <repo_path>` — we never `cd`. Subprocesses are
wrapped to surface stderr in raised errors so the caller can write a useful
audit entry.
"""
from __future__ import annotations

import pathlib
import subprocess
from dataclasses import dataclass

from lib.config import Config


class RepoError(Exception):
    pass


@dataclass(frozen=True)
class RunResult:
    returncode: int
    stdout: str
    stderr: str


def _git(repo_path: pathlib.Path | str, *args: str) -> RunResult:
    cmd = ["git", "-C", str(repo_path), *args]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    return RunResult(proc.returncode, proc.stdout, proc.stderr)


def _git_strict(repo_path: pathlib.Path | str, *args: str) -> str:
    r = _git(repo_path, *args)
    if r.returncode != 0:
        cmd = " ".join(["git", "-C", str(repo_path), *args])
        raise RepoError(f"git failed: {cmd}\n{r.stderr.strip()}")
    return r.stdout


def is_git_repo(repo_path: pathlib.Path) -> bool:
    if not repo_path.exists():
        return False
    r = _git(repo_path, "rev-parse", "--is-inside-work-tree")
    return r.returncode == 0 and r.stdout.strip() == "true"


def show_toplevel(repo_path: pathlib.Path) -> pathlib.Path | None:
    """Return `git -C <repo_path> rev-parse --show-toplevel` resolved, or None.

    Used to canonicalize an arbitrary subpath of a git repo to the repo's
    actual root, so naming downstream (e.g. derive_repo_name) is independent
    of which subpath the caller happened to pass. Returns None on any failure
    (path missing, not a git repo, git error) so callers can fall back to the
    old basename behavior.
    """
    if not repo_path.exists():
        return None
    r = _git(repo_path, "rev-parse", "--show-toplevel")
    if r.returncode != 0:
        return None
    raw = r.stdout.strip()
    if not raw:
        return None
    return pathlib.Path(raw).resolve()


def ref_exists(repo_path: pathlib.Path, ref: str) -> bool:
    r = _git(repo_path, "rev-parse", "--verify", "--quiet", ref)
    return r.returncode == 0


def resolve_ref_to_sha(repo_path: pathlib.Path | str, ref: str) -> str:
    """Resolve a symbolic ref (HEAD, branch name, short sha) to a full 40-char SHA.

    Raises ``RepoError`` if the ref cannot be resolved.
    """
    sha = _git_strict(repo_path, "rev-parse", "--verify", ref).strip()
    if not sha or len(sha) < 7:
        raise RepoError(f"unexpected rev-parse output for {ref!r}: {sha!r}")
    return sha


def branch_exists(repo_path: pathlib.Path, branch: str) -> bool:
    r = _git(repo_path, "show-ref", "--verify", "--quiet", f"refs/heads/{branch}")
    return r.returncode == 0


def worktree_exists(worktree_path: pathlib.Path) -> bool:
    return worktree_path.exists()


def verify_existing(repo_path: pathlib.Path, base_ref: str) -> None:
    """Pre-flight checks for an existing repo."""
    if not repo_path.exists():
        raise RepoError(f"repo path does not exist: {repo_path}")
    if not is_git_repo(repo_path):
        raise RepoError(f"not a git repo: {repo_path}")
    if not ref_exists(repo_path, base_ref):
        raise RepoError(f"base ref {base_ref!r} not found in {repo_path}")


def create_new(repo_path: pathlib.Path, *, monorepo_layout: bool = True) -> str:
    """Initialize a new repo at the given path. Returns initial commit SHA.

    For monorepo layout, scaffolds README.md + docs/ + backend/ + frontend/ shells.
    """
    if repo_path.exists() and any(repo_path.iterdir()):
        raise RepoError(f"refusing to init: {repo_path} exists and is not empty")
    repo_path.mkdir(parents=True, exist_ok=True)
    _git_strict(repo_path, "init", "-q", "-b", "main")
    readme = repo_path / "README.md"
    readme.write_text(f"# {repo_path.name}\n\nScaffold created by Agent Workbench.\n")
    if monorepo_layout:
        for sub in ("docs", "backend", "frontend"):
            (repo_path / sub).mkdir(exist_ok=True)
            (repo_path / sub / ".gitkeep").write_text("")
    _git_strict(repo_path, "add", "-A")
    _git_strict(
        repo_path,
        "-c", "user.name=Agent Workbench",
        "-c", "user.email=agent-workbench@local",
        "commit", "-q", "-m", "chore: agent-workbench initial scaffold",
    )
    sha = _git_strict(repo_path, "rev-parse", "HEAD").strip()
    return sha


def create_worktree(
    repo_path: pathlib.Path,
    branch_name: str,
    worktree_path: pathlib.Path,
    base_ref: str,
) -> None:
    if branch_exists(repo_path, branch_name):
        raise RepoError(f"branch {branch_name!r} already exists in {repo_path}")
    if worktree_path.exists():
        raise RepoError(f"worktree path already exists: {worktree_path}")
    worktree_path.parent.mkdir(parents=True, exist_ok=True)
    _git_strict(
        repo_path,
        "worktree", "add",
        "-b", branch_name,
        str(worktree_path),
        base_ref,
    )


def remove_worktree(repo_path: pathlib.Path, worktree_path: pathlib.Path, *, force: bool = False) -> None:
    args = ["worktree", "remove", str(worktree_path)]
    if force:
        args.insert(2, "--force")
    _git_strict(repo_path, *args)


def delete_branch(repo_path: pathlib.Path | str, branch: str) -> None:
    """Delete a local branch with -D (force). Used after worktree removal."""
    _git_strict(repo_path, "branch", "-D", branch)


def stage_and_commit_run_dir(
    worktree_path: pathlib.Path | str,
    run_dir_relpath: pathlib.Path | str,
    *,
    message: str,
) -> str | None:
    """Stage everything inside ``run_dir_relpath`` (relative to the worktree)
    and commit if anything was uncommitted. Returns the commit SHA, or None
    if there was nothing to commit.

    The commit uses a deterministic identity (``Agent Workbench`` /
    ``agent-workbench@local``) so callers don't need to thread author info.
    """
    rel = str(run_dir_relpath)
    add = _git(worktree_path, "add", "--", rel)
    if add.returncode != 0:
        # Path missing inside the worktree is fine (nothing to commit). Other
        # errors surface as RepoError.
        if "did not match any files" in (add.stderr or "").lower():
            return None
        raise RepoError(
            f"git add {rel!r} failed in {worktree_path}: {add.stderr.strip()}"
        )
    # Are there any staged changes under that path?
    diff = _git(worktree_path, "diff", "--cached", "--quiet", "--", rel)
    # `diff --quiet` exits 0 when there are no changes, 1 when there are.
    if diff.returncode == 0:
        return None
    if diff.returncode != 1:
        raise RepoError(
            f"git diff --cached failed in {worktree_path}: {diff.stderr.strip()}"
        )
    commit = _git(
        worktree_path,
        "-c", "user.name=Agent Workbench",
        "-c", "user.email=agent-workbench@local",
        "commit", "-q", "-m", message, "--", rel,
    )
    if commit.returncode != 0:
        raise RepoError(
            f"git commit failed in {worktree_path}: {commit.stderr.strip()}"
        )
    sha = _git_strict(worktree_path, "rev-parse", "HEAD").strip()
    return sha


def archive_tree_to_path(
    repo_path: pathlib.Path | str,
    ref: str,
    source_relpath: pathlib.Path | str,
    dest_abs_path: pathlib.Path,
) -> None:
    """Extract ``source_relpath`` from ``ref`` in ``repo_path`` to ``dest_abs_path``.

    Uses ``git archive | tar`` so the operation works without checking the
    ref out and without depending on whichever working copy is currently
    materialised. ``dest_abs_path`` is created (and parents created) as
    needed; on success the directory contains the same files that
    ``ref:source_relpath`` does.

    Raises ``RepoError`` if either git or tar fails.
    """
    src = str(source_relpath)
    dest = pathlib.Path(dest_abs_path)
    dest.mkdir(parents=True, exist_ok=True)
    git_proc = subprocess.Popen(
        ["git", "-C", str(repo_path), "archive", "--format=tar", ref, src],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    tar_proc = subprocess.Popen(
        ["tar", "-x", "--strip-components", str(len(pathlib.PurePath(src).parts)),
         "-C", str(dest)],
        stdin=git_proc.stdout,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if git_proc.stdout:
        git_proc.stdout.close()  # allow git_proc to receive a SIGPIPE if tar exits
    _, tar_err = tar_proc.communicate()
    git_proc.wait()
    git_err = (git_proc.stderr.read() if git_proc.stderr else b"").decode()
    if git_proc.returncode != 0:
        raise RepoError(
            f"git archive failed for {ref}:{src} in {repo_path}: {git_err.strip()}"
        )
    if tar_proc.returncode != 0:
        raise RepoError(
            f"tar -x failed extracting to {dest}: {tar_err.decode().strip()}"
        )


class MergeConflictError(RepoError):
    """Raised when `git merge --no-ff` produced conflicts; the merge has been aborted."""

    def __init__(self, conflicted_files: list[str], stderr: str = "") -> None:
        super().__init__(
            f"merge conflict in {len(conflicted_files)} file(s): "
            + ", ".join(conflicted_files)
        )
        self.conflicted_files = conflicted_files
        self.stderr = stderr


def worktree_dirty_files(worktree_path: pathlib.Path | str) -> list[str]:
    """Return the list of dirty paths in a worktree (empty when clean).

    Uses `git status --porcelain`. Each entry is the path the porcelain format
    reports (the two leading status columns are stripped).
    """
    r = _git(worktree_path, "status", "--porcelain")
    if r.returncode != 0:
        raise RepoError(
            f"git status failed in {worktree_path}: {r.stderr.strip()}"
        )
    out: list[str] = []
    for line in r.stdout.splitlines():
        if not line.strip():
            continue
        # porcelain format: XY <path>; columns 0-1 are status, col 2 is space.
        out.append(line[3:].strip())
    return out


def worktree_is_clean(worktree_path: pathlib.Path | str) -> bool:
    """True when `git status --porcelain` reports no changes."""
    return len(worktree_dirty_files(worktree_path)) == 0


def current_branch(repo_path: pathlib.Path | str) -> str | None:
    """The current branch in the given repo, or None if detached HEAD."""
    r = _git(repo_path, "symbolic-ref", "--quiet", "--short", "HEAD")
    if r.returncode != 0:
        return None
    return r.stdout.strip() or None


def resolve_parent_branch(
    repo_path: pathlib.Path | str, base_ref: str
) -> str:
    """Resolve a run's `base_ref` to a concrete branch name.

    Runs created with the default `base_ref: HEAD` need that "HEAD" resolved to
    whatever branch was checked out at the time. If `base_ref` is literally
    `"HEAD"`, we read `git symbolic-ref --short HEAD` from the target repo.
    Otherwise we verify it's a real branch and return as-is.

    Raises `RepoError` if no branch can be resolved.
    """
    if base_ref == "HEAD":
        head = current_branch(repo_path)
        if not head:
            raise RepoError(
                f"cannot resolve base_ref 'HEAD' in {repo_path}: detached HEAD"
            )
        return head
    if not branch_exists(repo_path, base_ref):
        raise RepoError(
            f"base_ref {base_ref!r} is not a branch in {repo_path}"
        )
    return base_ref


def merge_no_ff(
    repo_path: pathlib.Path | str,
    parent_branch: str,
    worktree_branch: str,
    *,
    message: str | None = None,
) -> str:
    """Merge `worktree_branch` into `parent_branch` with --no-ff.

    Pre-flight:
      - parent and worktree branches must exist
      - repo working tree must be clean (no staged or unstaged changes)

    Behavior:
      - records the original branch (if any) so we can restore it on the
        success path
      - checks out `parent_branch`, runs `git merge --no-ff`
      - on success: returns the merge commit SHA, restores the original
        branch via `git checkout -`
      - on conflict: runs `git merge --abort`, raises `MergeConflictError`
        with the conflicted-files list. Leaves the parent branch checked out
        so the human is dropped where they need to resolve.
    """
    if not branch_exists(repo_path, parent_branch):
        raise RepoError(f"parent branch {parent_branch!r} not found in {repo_path}")
    if not branch_exists(repo_path, worktree_branch):
        raise RepoError(f"worktree branch {worktree_branch!r} not found in {repo_path}")
    if not worktree_is_clean(repo_path):
        dirty = worktree_dirty_files(repo_path)
        raise RepoError(
            f"refusing to merge: {repo_path} has uncommitted changes: {dirty}"
        )

    original = current_branch(repo_path)
    _git_strict(repo_path, "checkout", parent_branch)

    merge_args = ["merge", "--no-ff"]
    if message:
        merge_args += ["-m", message]
    merge_args.append(worktree_branch)
    r = _git(repo_path, *merge_args)
    if r.returncode != 0:
        # Pull the conflicted-file list before aborting.
        diag = _git(repo_path, "diff", "--name-only", "--diff-filter=U")
        conflicted = [ln.strip() for ln in diag.stdout.splitlines() if ln.strip()]
        abort = _git(repo_path, "merge", "--abort")
        if abort.returncode != 0:
            # `merge --abort` failing is exceptional — surface it with the
            # original conflict context so the human can clean up by hand.
            raise RepoError(
                f"merge failed AND `git merge --abort` failed in {repo_path}: "
                f"merge stderr: {r.stderr.strip()}; "
                f"abort stderr: {abort.stderr.strip()}"
            )
        raise MergeConflictError(conflicted, stderr=r.stderr)

    sha = _git_strict(repo_path, "rev-parse", "HEAD").strip()
    if original and original != parent_branch:
        _git_strict(repo_path, "checkout", original)
    return sha
