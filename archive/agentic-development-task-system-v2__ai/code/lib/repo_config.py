"""Loader and validator for `config/repos.yaml`.

The config maps a `repo_key` (used by all the lifecycle scripts) to the
absolute path, GitHub slug, and default branch of a product repo.

Use `load_config()` to get a fully validated `RepoConfig` mapping. Use
`get_repo()` to fetch a single entry by key with a clear error message on miss.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from . import _yaml
from .paths import REPOS_YAML


class ConfigError(ValueError):
    """Raised when repos.yaml is missing, malformed, or fails validation."""


@dataclass(frozen=True)
class RepoEntry:
    repo_key: str
    path: Path                # the git repo root (where `.git` lives)
    github: str
    default_branch: str
    project_subpath: str = ""  # "" → project == git root; non-empty → subdir

    @property
    def project_dir(self) -> Path:
        """Where the AI agent's files actually live.

        Equal to `path` for top-level projects. For projects that live in a
        subdirectory of a larger git repo, this is `path / project_subpath`.
        """
        if not self.project_subpath:
            return self.path
        return self.path / self.project_subpath


REQUIRED_FIELDS: tuple[str, ...] = ("path", "github", "default_branch")
OPTIONAL_FIELDS: tuple[str, ...] = ("project_subpath",)


def _validate_entry(repo_key: str, raw: dict[str, str]) -> RepoEntry:
    missing = [field for field in REQUIRED_FIELDS if field not in raw or raw[field] == ""]
    if missing:
        raise ConfigError(
            f"repo '{repo_key}' is missing required field(s): {', '.join(missing)}"
        )

    allowed = set(REQUIRED_FIELDS) | set(OPTIONAL_FIELDS)
    unknown = [k for k in raw.keys() if k not in allowed]
    if unknown:
        raise ConfigError(
            f"repo '{repo_key}' has unknown field(s): {', '.join(unknown)}. "
            f"Allowed: {', '.join(sorted(allowed))}"
        )

    path_str = raw["path"]
    if not path_str.startswith("/"):
        raise ConfigError(
            f"repo '{repo_key}' path must be absolute (no '~', no relative paths): "
            f"got {path_str!r}"
        )
    if "~" in path_str:
        raise ConfigError(
            f"repo '{repo_key}' path must not contain '~'. Use the expanded "
            f"absolute path instead: got {path_str!r}"
        )

    github = raw["github"]
    if "/" not in github or github.startswith("/") or github.endswith("/"):
        raise ConfigError(
            f"repo '{repo_key}' github must be '<org>/<repo>': got {github!r}"
        )

    project_subpath = (raw.get("project_subpath") or "").strip()
    if project_subpath:
        if project_subpath.startswith("/"):
            raise ConfigError(
                f"repo '{repo_key}' project_subpath must be relative to path, "
                f"not absolute: got {project_subpath!r}"
            )
        if ".." in Path(project_subpath).parts:
            raise ConfigError(
                f"repo '{repo_key}' project_subpath must not contain '..': "
                f"got {project_subpath!r}"
            )

    return RepoEntry(
        repo_key=repo_key,
        path=Path(path_str),
        github=github,
        default_branch=raw["default_branch"],
        project_subpath=project_subpath,
    )


def load_config(path: Path = REPOS_YAML) -> dict[str, RepoEntry]:
    """Load and validate `config/repos.yaml`. Returns a dict keyed by repo_key."""
    if not path.exists():
        raise ConfigError(
            f"{path} does not exist. Copy config/repos.yaml.example to "
            f"config/repos.yaml and edit it for your machine."
        )

    raw = _yaml.load(path)

    if "repos" not in raw or not isinstance(raw["repos"], dict):
        raise ConfigError(
            f"{path}: top-level 'repos:' mapping is required."
        )

    repos_block = raw["repos"]
    if not repos_block:
        raise ConfigError(f"{path}: 'repos:' must contain at least one entry.")

    entries: dict[str, RepoEntry] = {}
    for repo_key, sub in repos_block.items():
        if not isinstance(sub, dict):
            raise ConfigError(
                f"{path}: repo '{repo_key}' must be a mapping with "
                f"path/github/default_branch."
            )
        entries[repo_key] = _validate_entry(repo_key, sub)

    return entries


def get_repo(repo_key: str, path: Path = REPOS_YAML) -> RepoEntry:
    """Fetch a single repo entry by key. Raises ConfigError if missing."""
    config = load_config(path)
    if repo_key not in config:
        known = ", ".join(sorted(config.keys())) or "(none)"
        raise ConfigError(
            f"unknown repo_key '{repo_key}'. Known keys: {known}"
        )
    return config[repo_key]


def validate_paths_on_disk(config: dict[str, RepoEntry]) -> list[str]:
    """Check that each configured repo path exists and looks like a git repo.

    For entries with a `project_subpath`, also verify that the subdirectory
    exists under the git root.

    Returns a list of human-readable problem strings. Empty list = all good.
    Does not raise — callers decide whether to treat findings as fatal.
    """
    problems: list[str] = []
    for entry in config.values():
        if not entry.path.exists():
            problems.append(
                f"repo '{entry.repo_key}': path does not exist: {entry.path}"
            )
            continue
        if not entry.path.is_dir():
            problems.append(
                f"repo '{entry.repo_key}': path is not a directory: {entry.path}"
            )
            continue
        # A regular repo has .git as a directory; a worktree has .git as a file.
        git_marker = entry.path / ".git"
        if not git_marker.exists():
            problems.append(
                f"repo '{entry.repo_key}': not a git repo (no .git): {entry.path}"
            )
            continue
        if entry.project_subpath:
            if not entry.project_dir.exists():
                problems.append(
                    f"repo '{entry.repo_key}': project_subpath does not exist "
                    f"under git root: {entry.project_dir}"
                )
            elif not entry.project_dir.is_dir():
                problems.append(
                    f"repo '{entry.repo_key}': project_subpath is not a "
                    f"directory: {entry.project_dir}"
                )
    return problems
