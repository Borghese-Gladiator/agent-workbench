"""Read/write helpers for `runs/<run_id>/metadata.yaml`.

`metadata.yaml` is the canonical state for a run. Other code MUST go through
this module rather than parsing the file or, worse, inferring state from
directory names.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, asdict, field, replace
from datetime import datetime, timezone
from pathlib import Path

from . import _yaml
from .paths import RUNS_DIR, metadata_path


VALID_STATUSES: tuple[str, ...] = (
    "draft",
    # Front-half lifecycle (added 05/13). `planned` is the legacy alias for
    # `ready` until callers migrate; both are valid simultaneously.
    "normalize",
    "brainstorm",
    "ready",
    "planned",
    "investigating",
    "investigated",
    "in_progress",
    "in_review",
    "qa",
    "merged",
    "abandoned",
)
TERMINAL_STATUSES: frozenset[str] = frozenset({"merged", "abandoned"})

# Statuses that are only valid when run_type == "investigation".
INVESTIGATION_ONLY_STATUSES: frozenset[str] = frozenset({"investigating", "investigated"})

VALID_RUN_TYPES: tuple[str, ...] = (
    "investigation",
    "feature",
    "review",
    "hotfix",
)

# kebab-case slug: lowercase letters, digits, hyphens; must start with a letter.
_SLUG_RE = re.compile(r"^[a-z][a-z0-9-]*$")
_RUN_ID_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})-([a-z][a-z0-9-]*)-(\d{3})$")
# Beads issue IDs: <prefix>-<hash>, optionally with dotted suffixes for
# hierarchical children (e.g. wb-hc1, wb-hc1.1, bd-42, bd-a3f8e9.2).
# Prefix is whatever was passed to `bd init --prefix` at workbench setup.
_BEADS_TASK_ID_RE = re.compile(r"^[a-z][a-z0-9]*-[a-z0-9]+(?:\.[0-9]+)*$")


class MetadataError(ValueError):
    """Raised when metadata.yaml is missing, malformed, or invalid."""


@dataclass
class Metadata:
    run_id: str = ""
    feature_slug: str = ""
    repo_key: str = ""
    # `repo_path` is the git repo root (where `.git` lives). This is what
    # `git -C <repo_path>` operates against and where `git worktree add`
    # cuts from.
    repo_path: str = ""
    # `project_subpath` is relative to repo_path. Empty when the project
    # IS the git repo (the common case). Non-empty when the project lives
    # in a subdirectory of a larger git repo. See docs/architecture.md
    # ("Subdirectory projects").
    project_subpath: str = ""
    github_repo: str = ""
    default_branch: str = ""
    branch_name: str = ""
    # `worktree_path` is the absolute path the git worktree was created at
    # (always the git-root-level worktree, never a subdir). The agent's
    # working dir is `worktree_path / project_subpath` — use `project_dir()`.
    worktree_path: str = ""
    status: str = "draft"
    # GitHub CLI integration (all optional; populated by scripts/open-pr.sh).
    # Stored as strings because our flat-YAML serializer is string-only.
    pr_url: str = ""
    pr_number: str = ""
    remote_name: str = "origin"
    github_cli_required: str = "false"
    # Investigation → fan-out workflow. parent_run_id is set on children by
    # spawn-children.sh; linear_ticket is populated by /ingest-linear;
    # run_type distinguishes investigation runs from feature/review/hotfix.
    parent_run_id: str = ""
    linear_ticket: str = ""
    run_type: str = "feature"
    # Beads integration. Populated by scripts/sync-to-beads.sh; format "bd-XX".
    beads_task_id: str = ""
    created_at: str = ""
    updated_at: str = ""

    # Order of fields above is the on-disk order — keep it stable.

    def to_yaml_dict(self) -> dict[str, str]:
        return asdict(self)

    def project_dir(self) -> str:
        """Return the absolute path to the project's working directory.

        For top-level projects, this is `repo_path`. For projects in a
        subdirectory of a larger git repo, this is `repo_path/project_subpath`.
        Used by scripts that need to scope an action to the project's files
        (e.g. validate-product-repos-clean.sh).
        """
        if not self.project_subpath:
            return self.repo_path
        return f"{self.repo_path.rstrip('/')}/{self.project_subpath.strip('/')}"

    def worktree_project_dir(self) -> str:
        """Return the absolute path the agent should `cd` into for this run.

        For top-level projects, this is `worktree_path`. For subdirectory
        projects, this is `worktree_path/project_subpath`. Empty if the
        worktree has not been created yet.
        """
        if not self.worktree_path:
            return ""
        if not self.project_subpath:
            return self.worktree_path
        return f"{self.worktree_path.rstrip('/')}/{self.project_subpath.strip('/')}"


def _now_iso() -> str:
    """ISO-8601 UTC timestamp with seconds resolution and a trailing 'Z'."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _today_iso_date() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def validate_status(status: str) -> None:
    if status not in VALID_STATUSES:
        raise MetadataError(
            f"invalid status {status!r}; must be one of: {', '.join(VALID_STATUSES)}"
        )


def validate_run_type(run_type: str) -> None:
    if run_type not in VALID_RUN_TYPES:
        raise MetadataError(
            f"invalid run_type {run_type!r}; must be one of: {', '.join(VALID_RUN_TYPES)}"
        )


def validate_beads_task_id(beads_task_id: str) -> None:
    if not _BEADS_TASK_ID_RE.match(beads_task_id):
        raise MetadataError(
            f"beads_task_id must match {_BEADS_TASK_ID_RE.pattern}; got {beads_task_id!r}"
        )


def validate_feature_slug(slug: str) -> None:
    if not _SLUG_RE.match(slug):
        raise MetadataError(
            f"feature_slug must be kebab-case starting with a letter "
            f"(matching {_SLUG_RE.pattern}); got {slug!r}"
        )


def parse_run_id(run_id: str) -> tuple[str, str, int]:
    """Decompose a run_id into (date, slug, suffix). Raises on malformed input."""
    match = _RUN_ID_RE.match(run_id)
    if not match:
        raise MetadataError(
            f"malformed run_id {run_id!r}; expected YYYY-MM-DD-<slug>-NNN"
        )
    return match.group(1), match.group(2), int(match.group(3))


def generate_run_id(feature_slug: str, runs_dir: Path = RUNS_DIR) -> str:
    """Pick the next available run_id for today + slug.

    Auto-increments NNN if collisions exist on the same date. Never overwrites.
    """
    validate_feature_slug(feature_slug)
    date = _today_iso_date()
    runs_dir.mkdir(parents=True, exist_ok=True)

    # Scan existing run dirs that share today's date and slug.
    existing_suffixes: list[int] = []
    prefix = f"{date}-{feature_slug}-"
    for entry in runs_dir.iterdir():
        if not entry.is_dir():
            continue
        if not entry.name.startswith(prefix):
            continue
        try:
            _, _, suffix = parse_run_id(entry.name)
        except MetadataError:
            continue
        existing_suffixes.append(suffix)

    next_suffix = (max(existing_suffixes) + 1) if existing_suffixes else 1
    if next_suffix > 999:
        raise MetadataError(
            f"more than 999 runs for {date}-{feature_slug}; pick a new slug"
        )
    return f"{date}-{feature_slug}-{next_suffix:03d}"


def load(run_dir: Path) -> Metadata:
    """Load metadata.yaml from a run directory."""
    path = metadata_path(run_dir)
    if not path.exists():
        raise MetadataError(f"{path} does not exist")
    raw = _yaml.load(path)

    # Reject unexpected nested mappings — metadata.yaml is flat.
    for key, value in raw.items():
        if isinstance(value, dict):
            raise MetadataError(
                f"{path}: field {key!r} must be a scalar, not a mapping"
            )

    # Build Metadata from known fields; warn on unknown fields by raising,
    # so schema drift is loud rather than silently ignored.
    known_fields = {f.name for f in Metadata.__dataclass_fields__.values()}
    unknown = [k for k in raw.keys() if k not in known_fields]
    if unknown:
        raise MetadataError(
            f"{path}: unknown field(s): {', '.join(unknown)}"
        )

    # Build with explicit defaults — Metadata's dataclass defaults handle fields
    # not present in legacy metadata.yaml files.
    init_kwargs: dict[str, str] = {}
    for fname in known_fields:
        if fname in raw:
            init_kwargs[fname] = raw[fname]
    md = Metadata(**init_kwargs)
    if md.status:
        validate_status(md.status)
    if md.run_type:
        validate_run_type(md.run_type)
    if md.parent_run_id:
        parse_run_id(md.parent_run_id)
    if md.beads_task_id:
        validate_beads_task_id(md.beads_task_id)
    return md


def save(run_dir: Path, md: Metadata, *, touch_updated_at: bool = True) -> None:
    """Write metadata.yaml for a run, validating before serialization."""
    if md.status:
        validate_status(md.status)
    if md.run_type:
        validate_run_type(md.run_type)
    if md.parent_run_id:
        parse_run_id(md.parent_run_id)
    if md.beads_task_id:
        validate_beads_task_id(md.beads_task_id)
    if md.status in INVESTIGATION_ONLY_STATUSES and md.run_type != "investigation":
        raise MetadataError(
            f"status {md.status!r} is only valid for run_type=investigation; "
            f"got run_type={md.run_type!r}"
        )
    if touch_updated_at:
        md = replace(md, updated_at=_now_iso())
    _yaml.dump(md.to_yaml_dict(), metadata_path(run_dir))


def new_metadata(
    *,
    run_id: str,
    feature_slug: str,
    repo_key: str,
    repo_path: str,
    github_repo: str,
    default_branch: str,
    project_subpath: str = "",
    parent_run_id: str = "",
    linear_ticket: str = "",
    run_type: str = "feature",
) -> Metadata:
    """Construct a Metadata instance for a brand-new run."""
    parse_run_id(run_id)  # validate format
    validate_feature_slug(feature_slug)
    validate_run_type(run_type)
    if parent_run_id:
        parse_run_id(parent_run_id)
    now = _now_iso()
    return Metadata(
        run_id=run_id,
        feature_slug=feature_slug,
        repo_key=repo_key,
        repo_path=repo_path,
        project_subpath=project_subpath,
        github_repo=github_repo,
        default_branch=default_branch,
        branch_name=f"ai/{run_id}",
        worktree_path="",  # set when the worktree is created
        status="draft",
        parent_run_id=parent_run_id,
        linear_ticket=linear_ticket,
        run_type=run_type,
        created_at=now,
        updated_at=now,
    )


def transition(md: Metadata, new_status: str) -> Metadata:
    """Return a new Metadata with the given status and refreshed updated_at."""
    validate_status(new_status)
    if md.status in TERMINAL_STATUSES and new_status != md.status:
        raise MetadataError(
            f"cannot transition from terminal status {md.status!r} to {new_status!r}"
        )
    if new_status in INVESTIGATION_ONLY_STATUSES and md.run_type != "investigation":
        raise MetadataError(
            f"status {new_status!r} is only valid for run_type=investigation; "
            f"got run_type={md.run_type!r}"
        )
    return replace(md, status=new_status, updated_at=_now_iso())
