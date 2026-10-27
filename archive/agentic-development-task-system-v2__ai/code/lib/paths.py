"""Centralized path resolution for ai-workbench.

The workbench root is the directory containing this `lib/` package's parent.
Other modules and scripts should ask this module for paths rather than
constructing them ad-hoc.
"""

from __future__ import annotations

from pathlib import Path

# lib/paths.py → parent is lib/, parent.parent is the workbench root.
WORKBENCH_ROOT: Path = Path(__file__).resolve().parent.parent

CONFIG_DIR: Path = WORKBENCH_ROOT / "config"
REPOS_YAML: Path = CONFIG_DIR / "repos.yaml"
REPOS_YAML_EXAMPLE: Path = CONFIG_DIR / "repos.yaml.example"

TEMPLATES_DIR: Path = WORKBENCH_ROOT / "templates"
RUNS_DIR: Path = WORKBENCH_ROOT / "runs"
WORKTREES_DIR: Path = WORKBENCH_ROOT / "worktrees"
IDEAS_DIR: Path = WORKBENCH_ROOT / "ideas"
DOCS_DIR: Path = WORKBENCH_ROOT / "docs"
SCRIPTS_DIR: Path = WORKBENCH_ROOT / "scripts"

# Files that templates/ must contain. Validated by scripts/validate-workbench.sh.
REQUIRED_TEMPLATES: tuple[str, ...] = (
    "raw-idea.md",
    "normalized-feature-input.md",
    "spec.md",
    "run-log.md",
    "decisions.md",
    "qa-log.md",
    "pr-summary.md",
    "metadata.yaml",
)

# The set of artifacts copied into a fresh run directory.
# (metadata.yaml is rendered separately, not copied verbatim.)
RUN_ARTIFACT_TEMPLATES: tuple[str, ...] = (
    "raw-idea.md",
    "normalized-feature-input.md",
    "spec.md",
    "run-log.md",
    "decisions.md",
    "qa-log.md",
    "pr-summary.md",
)


def run_dir(run_id: str) -> Path:
    """Return the canonical run directory path for a run_id."""
    return RUNS_DIR / run_id


def worktree_dir(run_id: str) -> Path:
    """Return the canonical worktree directory path for a run_id."""
    return WORKTREES_DIR / run_id


def metadata_path(run_dir_path: Path) -> Path:
    """Return the metadata.yaml path inside a given run directory."""
    return run_dir_path / "metadata.yaml"
