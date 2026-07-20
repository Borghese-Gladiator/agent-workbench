"""Resolve a `<run_dir>` argument and load its metadata.

Slash commands (`.claude/commands/*.md`) accept a run-directory argument that
may be relative (`runs/<run_id>`) or absolute (`/Users/.../runs/<run_id>`),
and they all need the same first-step loading + validation. This module is
that single source of truth so the commands stay terse and consistent.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .metadata import Metadata, MetadataError, load
from .paths import RUNS_DIR, WORKBENCH_ROOT


class RunError(ValueError):
    """Raised when a run directory cannot be resolved or its metadata is invalid."""


@dataclass(frozen=True)
class RunInfo:
    metadata: Metadata
    run_dir: Path
    workbench_root: Path


def load_run(run_dir_input: str) -> RunInfo:
    """Resolve `<run_dir>` (relative or absolute) and load metadata.yaml.

    Relative paths are resolved against the workbench root. The resolved path
    must live under `<workbench_root>/runs/`. Raises `RunError` for missing
    dirs, missing/invalid metadata, or paths outside the runs tree.
    """
    if not run_dir_input:
        raise RunError("run_dir argument is empty")

    candidate = Path(run_dir_input)
    if not candidate.is_absolute():
        candidate = WORKBENCH_ROOT / candidate
    candidate = candidate.resolve()

    runs_root = RUNS_DIR.resolve()
    try:
        candidate.relative_to(runs_root)
    except ValueError as exc:
        raise RunError(
            f"run_dir must be under {runs_root}; got {candidate}"
        ) from exc

    if not candidate.is_dir():
        raise RunError(f"run dir not found: {candidate}")

    try:
        md = load(candidate)
    except MetadataError as exc:
        raise RunError(str(exc)) from exc

    return RunInfo(metadata=md, run_dir=candidate, workbench_root=WORKBENCH_ROOT)
