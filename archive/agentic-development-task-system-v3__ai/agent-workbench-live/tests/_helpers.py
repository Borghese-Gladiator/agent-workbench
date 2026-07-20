"""Shared test helpers."""
from __future__ import annotations

import pathlib
import shutil
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent  # agent-workbench-live/
sys.path.insert(0, str(ROOT))


def make_tmp_workbench() -> pathlib.Path:
    """Create a temp workbench root with config + schemas copied in."""
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="aw-test-"))
    shutil.copy(ROOT / "agent-workbench.yaml", tmp / "agent-workbench.yaml")
    shutil.copytree(ROOT / "schemas", tmp / "schemas")
    shutil.copytree(ROOT / "templates", tmp / "templates")
    return tmp


def cleanup(path: pathlib.Path) -> None:
    if path.exists():
        shutil.rmtree(path, ignore_errors=True)


def reset_caches() -> None:
    """Clear lru_caches in lib modules between tests (schemas/config)."""
    from lib import events as ev, transitions as tr, runs as runs_mod
    ev._load_schemas.cache_clear()
    tr._load_schema.cache_clear()
    runs_mod.reset_caches()
