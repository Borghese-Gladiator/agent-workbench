"""First-class `Run` value object + union-of-worktrees enumeration.

A run dir's physical location is determined by `metadata.target.worktree.path`:
- self-modifying runs (the workbench is inside the target repo) live inside
  their worktree at `<worktree>/<workbench-rel-path>/runs/<run_id>/`
- non-self-modifying runs live in the workbench checkout's `cfg.runs_path`
- archived runs (`done`/`abandoned`) live in `cfg.runs_path` on master after
  the `complete`/`abandon` merge has delivered them there

This module is the source of truth for resolving "where does run X live right
now?" — every CLI command writes through `metadata.run_dir(cfg, run_id)` which
delegates here for runs whose metadata is already on disk.

`find_run` is strict (raises on collision); `iter_all_runs` is permissive
(prefers worktree, warns on stderr).

Worktree-list cache contract
----------------------------
`_WORKTREE_CACHE` memoises `git worktree list --porcelain` keyed on the
workbench root, with a short TTL (default 2s, configurable via
`agent-workbench.yaml` -> `board.worktree_cache_ttl_seconds`). The TTL is
correct for both consumer regimes:

  * short-lived CLI calls (sub-second lifetime) never reach TTL expiry, so
    they pay the git cost at most once per process — the original cache
    contract is preserved;
  * the long-running `agent-workbench board` ticks see new worktrees within
    TTL seconds, without paying the git cost on every tick.

Measured cost of `git worktree list --porcelain` on a 3-worktree repo was
~16ms median / ~19ms p90; cost scales roughly linearly with worktree count.
Do NOT remove the TTL or set it to 0 globally: the board would call git at
its re-scan rate, which is far above the original "once per process" budget
this cache was sized for.
"""
from __future__ import annotations

import dataclasses
import pathlib
import subprocess
import sys
import time
from typing import Iterator

from lib import yaml_io
from lib.config import Config


SOURCE_WORKTREE = "worktree"
SOURCE_MASTER = "master"


class RunNotFound(LookupError):
    """Raised when a run id resolves to no on-disk run dir."""


class RunCollision(RuntimeError):
    """Raised when a run id resolves to multiple on-disk run dirs.

    The message lists every conflicting path so the human can pick one.
    """


@dataclasses.dataclass(frozen=True)
class Run:
    """One run's location + status, resolved against the live worktree set."""

    run_id: str
    run_dir: pathlib.Path
    worktree_path: pathlib.Path | None
    status: str
    source: str  # SOURCE_WORKTREE or SOURCE_MASTER
    metadata: dict


def is_self_modifying(cfg: Config, meta: dict) -> bool:
    """True iff the workbench checkout is inside the target repo.

    Two equivalence rules:

    1. Filesystem ancestry: ``cfg.root`` is a descendant of
       ``meta.target.repo.path``. Cheap; catches the common case where the
       CLI runs from the same main checkout as the target.
    2. Git identity: ``cfg.root`` and ``meta.target.repo.path`` share the
       same git common dir. Catches the case where the CLI runs from a
       worktree of the same repo (worktrees live at a different filesystem
       path but share ``.git/worktrees/<name>``'s parent).
    """
    repo_path_raw = (meta.get("target") or {}).get("repo", {}).get("path")
    if not repo_path_raw:
        return False
    try:
        repo_root = pathlib.Path(repo_path_raw).resolve()
        wb_root = cfg.root.resolve()
    except (OSError, RuntimeError):
        return False
    try:
        wb_root.relative_to(repo_root)
        return True
    except ValueError:
        pass
    # Worktree case: compare git common dirs.
    wb_common = _git_common_dir(wb_root)
    repo_common = _git_common_dir(repo_root)
    if wb_common is None or repo_common is None:
        return False
    return wb_common == repo_common


def _git_common_dir(start: pathlib.Path) -> pathlib.Path | None:
    """Return ``git -C <start> rev-parse --git-common-dir`` resolved, or None.

    Cached for the process lifetime keyed on the absolute starting path. The
    git common dir of a worktree never changes once the worktree exists, and
    the board called this once per snapshotted run before the cache landed —
    ~150 subprocess invocations per refresh on a 3-worktree repo.
    """
    key = str(start)
    cached = _GIT_COMMON_DIR_CACHE.get(key)
    if cached is not None:
        return cached[0]
    try:
        proc = subprocess.run(
            ["git", "-C", str(start), "rev-parse", "--git-common-dir"],
            capture_output=True, text=True, timeout=5, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        _GIT_COMMON_DIR_CACHE[key] = (None,)
        return None
    if proc.returncode != 0:
        _GIT_COMMON_DIR_CACHE[key] = (None,)
        return None
    raw = proc.stdout.strip()
    if not raw:
        _GIT_COMMON_DIR_CACHE[key] = (None,)
        return None
    p = pathlib.Path(raw)
    if not p.is_absolute():
        p = (start / p).resolve()
    else:
        p = p.resolve()
    _GIT_COMMON_DIR_CACHE[key] = (p,)
    return p


# Cache for `_git_common_dir`. Value is a 1-tuple so we can distinguish "cached
# None" from "not cached." See _git_common_dir for the contract.
_GIT_COMMON_DIR_CACHE: dict[str, tuple[pathlib.Path | None]] = {}


# Parsed-metadata cache keyed on (path, mtime_ns). The board calls
# `_try_build_run` once per run per snapshot, and YAML parsing was the
# dominant cost after the rest of PR1 landed. mtime is the freshness probe;
# any save() through metadata.save bumps it.
_METADATA_CACHE: dict[str, tuple[int, dict]] = {}


def workbench_subpath(cfg: Config) -> pathlib.Path | None:
    """Return cfg.root's path relative to its containing git repo, or None.

    For workbench-self-modifying runs, the workbench checkout is at this
    subpath inside the target repo. Inside the worktree the same subpath
    points at the workbench's mirror image.
    """
    wb_root = cfg.root.resolve()
    for parent in [wb_root, *wb_root.parents]:
        if (parent / ".git").exists():
            try:
                return wb_root.relative_to(parent)
            except ValueError:
                return None
    return None


def resolve_run_dir_for_meta(cfg: Config, run_id: str, meta: dict) -> pathlib.Path:
    """Where does this run live on disk *right now*, given its loaded metadata?

    Resolution rules:

    - If `target.worktree.path` is populated AND the worktree exists AND the
      workbench is inside the target repo (self-modifying) AND the run dir
      exists inside the worktree → return the worktree-side path.
    - Otherwise → return `cfg.runs_path / run_id`.

    This is deterministic: at most one location wins. Collision detection
    lives in `find_run` / `iter_all_runs`, not here.
    """
    target = meta.get("target") or {}
    worktree = target.get("worktree") or {}
    wt_path_raw = worktree.get("path")
    if wt_path_raw and is_self_modifying(cfg, meta):
        sub = workbench_subpath(cfg)
        if sub is not None:
            wt = pathlib.Path(wt_path_raw)
            candidate = wt / sub / "runs" / run_id
            if candidate.exists():
                return candidate
    return cfg.runs_path / run_id


def find_run(cfg: Config, run_id: str) -> Run:
    """Resolve a run by id across master + every live worktree.

    Raises `RunNotFound` if no matching run dir exists on disk. Raises
    `RunCollision` (with both absolute paths in the message) if the id
    resolves to more than one location.
    """
    hits = _collect_hits(cfg, run_id)
    if not hits:
        raise RunNotFound(f"run {run_id!r} not found in master or any worktree")
    if len(hits) > 1:
        paths = "\n  ".join(str(h.run_dir) for h in hits)
        raise RunCollision(
            f"run id {run_id!r} resolves to multiple paths:\n  {paths}"
        )
    return hits[0]


def iter_all_runs(cfg: Config) -> Iterator[Run]:
    """Enumerate every run on disk across master + worktrees.

    Collisions are downgraded to a stderr warning; the worktree copy wins.
    Yields in lexicographic order by `run_id`.
    """
    by_id: dict[str, list[Run]] = {}
    for run in _walk_all(cfg):
        by_id.setdefault(run.run_id, []).append(run)
    for run_id in sorted(by_id):
        hits = by_id[run_id]
        if len(hits) == 1:
            yield hits[0]
            continue
        # Collision: prefer worktree, warn.
        worktree_hits = [h for h in hits if h.source == SOURCE_WORKTREE]
        kept = worktree_hits[0] if worktree_hits else hits[0]
        others = [h for h in hits if h is not kept]
        other_paths = ", ".join(str(o.run_dir) for o in others)
        print(
            f"WARN: run {run_id!r} resolves to multiple paths; using "
            f"{kept.run_dir} (also at: {other_paths})",
            file=sys.stderr,
        )
        yield kept


def _collect_hits(cfg: Config, run_id: str) -> list[Run]:
    """All on-disk locations for a single id. Internal helper for find_run."""
    return [r for r in _walk_all(cfg) if r.run_id == run_id]


def _walk_all(cfg: Config) -> Iterator[Run]:
    """Internal: yield every on-disk run from master + worktrees."""
    yield from _walk_master(cfg)
    yield from _walk_worktrees(cfg)


def _walk_master(cfg: Config) -> Iterator[Run]:
    runs_path = cfg.runs_path
    if not runs_path.exists():
        return
    for entry in sorted(runs_path.iterdir()):
        if not entry.is_dir():
            continue
        if entry.name == "abandoned":
            # Archived-abandoned runs nest one level deeper.
            for sub in sorted(entry.iterdir()):
                if not sub.is_dir():
                    continue
                run = _try_build_run(sub, source=SOURCE_MASTER, cfg=cfg)
                if run is not None:
                    yield run
            continue
        run = _try_build_run(entry, source=SOURCE_MASTER, cfg=cfg)
        if run is not None:
            yield run


def _walk_worktrees(cfg: Config) -> Iterator[Run]:
    sub = workbench_subpath(cfg)
    if sub is None:
        return
    for wt in _list_workbench_worktrees(cfg):
        wt_runs = wt / sub / "runs"
        if not wt_runs.exists():
            continue
        for entry in sorted(wt_runs.iterdir()):
            if not entry.is_dir() or entry.name == "abandoned":
                continue
            run = _try_build_run(
                entry, source=SOURCE_WORKTREE, cfg=cfg, worktree_hint=wt,
            )
            if run is None:
                continue
            # Skip terminal-state runs from worktrees: those are usually just
            # merged history checked out in the worktree, NOT live work. The
            # master-side copy is meant to be the canonical archive.
            #
            # Carve-out: if the master-side metadata is stale (status doesn't
            # match the worktree's terminal status), prefer the worktree hit.
            # This closes the `list` vs `board` disagreement when
            # cmd_complete's master-side write fails to land in the merge
            # commit (the bug fixed by TODO §1, Y scope). Without this carve-
            # out, `board` shows the stale `human_review` while `list` shows
            # `done`.
            if run.status in ("done", "abandoned"):
                master_status = _master_side_status(cfg, run.run_id)
                if master_status == run.status or master_status is None:
                    continue
                # Master disagrees and exists — worktree is the recent truth.
            # Skip runs whose recorded worktree path doesn't match this
            # worktree — same reason: those entries are merged-history
            # artifacts that happen to be checked out here, not work being
            # done in this worktree.
            recorded_wt = (run.metadata.get("target") or {}).get("worktree", {}).get("path")
            if recorded_wt:
                try:
                    if pathlib.Path(recorded_wt).resolve() != wt.resolve():
                        continue
                except OSError:
                    pass
            yield run


def _master_side_status(cfg: Config, run_id: str) -> str | None:
    """Return the status recorded in the *master-side* metadata.yaml, or None.

    Used by `_walk_worktrees` to detect the stale-master case (worktree says
    `done` / `abandoned` but master is still `human_review`). Reads
    `cfg.runs_path / run_id / "metadata.yaml"` directly via yaml_io to avoid
    `metadata.load`'s worktree-resolution logic, which would re-route to the
    worktree copy and defeat the comparison.
    """
    meta_path = cfg.runs_path / run_id / "metadata.yaml"
    try:
        text = meta_path.read_text()
    except OSError:
        return None
    try:
        data = yaml_io.loads(text)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    status = data.get("status")
    return status if isinstance(status, str) else None


def _try_build_run(
    run_dir: pathlib.Path,
    *,
    source: str,
    cfg: Config,
    worktree_hint: pathlib.Path | None = None,
) -> Run | None:
    """Parse one run dir's metadata.yaml into a Run, or None if unreadable.

    Parsed metadata is cached on (path, mtime_ns) — the board calls this
    once per run on every snapshot, and YAML parsing dominates after the
    rest of PR1 lands.
    """
    meta_path = run_dir / "metadata.yaml"
    try:
        st = meta_path.stat()
    except OSError:
        return None
    cache_key = str(meta_path)
    cached = _METADATA_CACHE.get(cache_key)
    if cached is not None and cached[0] == st.st_mtime_ns:
        meta = cached[1]
    else:
        try:
            meta = yaml_io.loads(meta_path.read_text())
        except Exception:
            return None
        if isinstance(meta, dict):
            _METADATA_CACHE[cache_key] = (st.st_mtime_ns, meta)
    if not isinstance(meta, dict):
        return None
    run_id = meta.get("run_id")
    if not isinstance(run_id, str) or run_id != run_dir.name:
        # Drift between dir name and recorded id — treat as unreadable.
        return None
    status = str(meta.get("status") or "")
    wt_raw = (meta.get("target") or {}).get("worktree", {}).get("path")
    worktree_path = (
        pathlib.Path(wt_raw) if wt_raw else (worktree_hint if worktree_hint else None)
    )
    return Run(
        run_id=run_id,
        run_dir=run_dir.resolve(),
        worktree_path=worktree_path,
        status=status,
        source=source,
        metadata=meta,
    )


# Cache keyed on the workbench root path string. Value is
# (populated_at_monotonic, worktrees) so each call can decide whether to
# re-fetch based on a short TTL. See the module docstring for the contract.
_WORKTREE_CACHE: dict[str, tuple[float, tuple[pathlib.Path, ...]]] = {}
_WORKTREE_CACHE_TTL_DEFAULT_SECONDS: float = 2.0
# Lower bound — the cache is load-bearing for short-lived CLI calls, and a
# 0 / negative TTL would silently make every call invoke git (the exact
# behavior the module docstring forbids). Configured values below this clamp
# upward.
_WORKTREE_CACHE_TTL_MIN_SECONDS: float = 0.05


def _resolve_worktree_cache_ttl(cfg: Config, override: float | None) -> float:
    if override is not None:
        ttl = float(override)
    else:
        board = (cfg.raw.get("board") or {}) if isinstance(cfg.raw, dict) else {}
        try:
            ttl = float(board.get("worktree_cache_ttl_seconds",
                                  _WORKTREE_CACHE_TTL_DEFAULT_SECONDS))
        except (TypeError, ValueError):
            ttl = _WORKTREE_CACHE_TTL_DEFAULT_SECONDS
    if ttl < _WORKTREE_CACHE_TTL_MIN_SECONDS:
        return _WORKTREE_CACHE_TTL_MIN_SECONDS
    return ttl


def _list_workbench_worktrees(
    cfg: Config,
    *,
    ttl: float | None = None,
) -> tuple[pathlib.Path, ...]:
    """Every workbench worktree path *except* the main checkout.

    Memoised with a short TTL (see module docstring). Pass ``ttl`` to override
    the configured value — primarily for tests.
    """
    wb_root = cfg.root.resolve()
    cache_key = str(wb_root)
    effective_ttl = _resolve_worktree_cache_ttl(cfg, ttl)
    now = time.monotonic()
    cached = _WORKTREE_CACHE.get(cache_key)
    if cached is not None and (now - cached[0]) < effective_ttl:
        return cached[1]
    main_repo = _git_main_repo_root(wb_root)
    if main_repo is None:
        _WORKTREE_CACHE[cache_key] = (now, ())
        return ()
    try:
        proc = subprocess.run(
            ["git", "-C", str(main_repo), "worktree", "list", "--porcelain"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        _WORKTREE_CACHE[cache_key] = (now, ())
        return ()
    if proc.returncode != 0:
        _WORKTREE_CACHE[cache_key] = (now, ())
        return ()
    out: list[pathlib.Path] = []
    current: dict[str, str] = {}

    def _flush() -> None:
        if not current:
            return
        wt = current.get("worktree")
        if wt and "bare" not in current:
            p = pathlib.Path(wt).resolve()
            if p != main_repo:
                out.append(p)
        current.clear()

    for line in proc.stdout.splitlines():
        if not line.strip():
            _flush()
            continue
        if " " in line:
            key, _, value = line.partition(" ")
            current[key] = value
        else:
            current[line] = ""
    _flush()
    result = tuple(out)
    _WORKTREE_CACHE[cache_key] = (now, result)
    return result


def reset_caches() -> None:
    """Clear in-process caches. Called by tests between scenarios."""
    _WORKTREE_CACHE.clear()
    _GIT_COMMON_DIR_CACHE.clear()
    _METADATA_CACHE.clear()


def _git_main_repo_root(start: pathlib.Path) -> pathlib.Path | None:
    """The main working-copy root of the git repo containing `start`."""
    for parent in [start, *start.parents]:
        if (parent / ".git").is_dir():
            return parent.resolve()
    # Worktree case: .git is a file pointing at .../worktrees/<name>
    for parent in [start, *start.parents]:
        dotgit = parent / ".git"
        if dotgit.is_file():
            try:
                gitfile = dotgit.read_text()
            except OSError:
                return None
            # "gitdir: <abs-path-to-.git/worktrees/<name>>"
            if not gitfile.startswith("gitdir:"):
                return None
            gitdir = pathlib.Path(gitfile.split(":", 1)[1].strip()).resolve()
            # gitdir = <repo>/.git/worktrees/<name>; the repo root is two parents up
            # from `worktrees/<name>`.
            try:
                return gitdir.parent.parent.parent.resolve()
            except OSError:
                return None
    return None
