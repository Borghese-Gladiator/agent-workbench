"""Per-run filesystem lock.

Usage:
    with locks.acquire(cfg, run_id):
        ... mutate run ...

Implementation: O_EXCL create on runs/<run_id>/.lock. Holds the lock file
contents (pid + timestamp) for debugging; releases by deletion. Read-only
operations should not use this.
"""
from __future__ import annotations

import contextlib
import datetime as dt
import errno
import os
import pathlib

from lib.config import Config
from lib.metadata import run_dir


class LockError(Exception):
    pass


def _lock_path(cfg: Config, run_id: str) -> pathlib.Path:
    return run_dir(cfg, run_id) / ".lock"


@contextlib.contextmanager
def acquire(cfg: Config, run_id: str):
    p = _lock_path(cfg, run_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(str(p), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    except FileExistsError:
        try:
            existing = p.read_text().strip()
        except OSError:
            existing = "(unreadable)"
        raise LockError(
            f"run {run_id!r} is locked (lock file at {p}, contents: {existing}). "
            f"Another command may be mutating this run. If you are certain it is not, "
            f"remove the lock file manually."
        )
    try:
        with os.fdopen(fd, "w") as f:
            f.write(f"pid={os.getpid()} at={dt.datetime.now().astimezone().isoformat()}\n")
        yield
    finally:
        try:
            p.unlink()
        except FileNotFoundError:
            pass
        except OSError as e:
            if e.errno != errno.ENOENT:
                raise
