"""Run metadata read/write.

Source of truth for a run's state. Only this module writes
runs/<run_id>/metadata.yaml. The transition engine calls into it; other modules
read via load() but never call save() directly.

Validation contract
-------------------

Every load() walks the parsed dict against ``schemas/run-metadata.yaml`` (the
schema is now load-bearing, not descriptive). The walker accumulates a list of
``Problem`` records covering: missing-required field, wrong type, enum
violation, unknown extra key. The schema is the single source of truth for
``schema_version``, the ``status`` enum, and the nested shape of
``target.repo``, ``target.worktree``, ``validation``, ``completion``, and
``build``. ``scope`` and ``artifacts`` are tagged ``free_form: true`` in the
schema and deep-validated only enough to confirm the block is a dict — their
contents are governed by stage commands at write time.

Behavior under default mode (``policies.metadata_validation: warn`` or absent
in ``agent-workbench.yaml``):

- Required-field, wrong-type, and enum-violation problems print one line each
  to stderr; load() still returns the data.
- Unknown extra keys are silent (additive backward compatibility).

Behavior under strict mode (``policies.metadata_validation: strict``):

- All of the above are hard errors; load() raises ``MetadataError`` with every
  problem joined into the message.

Independent of mode, load() refuses to read a run whose tree contains more
than one ``metadata.yaml`` — that is an integrity violation, not a schema
problem, and always raises with both paths in the message.

The Python constants ``STATUSES`` and ``REQUIRED_TOP_LEVEL`` are kept for
public consumption (transitions.py, cmd_*.py read them) and asserted equal to
the schema-derived values at module import time so drift fails loudly.
"""
from __future__ import annotations

import datetime as dt
import os
import pathlib
import sys
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from lib import yaml_io
from lib.config import Config


class MetadataError(Exception):
    pass


# ---------- schema-driven validator ----------


@dataclass(frozen=True)
class Problem:
    """One validator finding. ``path`` is dot-joined keys from root."""

    path: str
    code: str
    message: str


# Map schema ``type:`` tokens to Python isinstance predicates. We use string
# tokens (rather than the runtime classes) so the schema stays
# language-agnostic and human-readable.
def _type_matches(value: Any, token: str) -> bool:
    if token == "null":
        return value is None
    if token == "str":
        return isinstance(value, str)
    if token == "int":
        # bool is a subclass of int in Python; exclude it so ``int`` doesn't
        # silently accept ``True``/``False``.
        return isinstance(value, int) and not isinstance(value, bool)
    if token == "bool":
        return isinstance(value, bool)
    if token == "float":
        return isinstance(value, float)
    if token == "dict":
        return isinstance(value, dict)
    if token == "list":
        return isinstance(value, list)
    raise MetadataError(f"unknown schema type token: {token!r}")


def _types_of_field(field_schema: dict) -> list[str]:
    t = field_schema.get("type")
    if t is None:
        return []
    if isinstance(t, str):
        return [t]
    if isinstance(t, list):
        return [str(x) for x in t]
    raise MetadataError(f"schema field 'type:' must be str or list, got {type(t).__name__}")


def _walk(
    data: Any,
    schema: dict,
    path: str,
    problems: list[Problem],
) -> None:
    """Recurse through ``schema`` and check ``data`` at each level.

    ``schema`` is a mapping of field-name -> field-schema. For each field:
      - check presence if required
      - check type against the field's ``type:``
      - check enum/eq if declared
      - if the field's type includes ``dict`` and the field declares ``keys:``
        (and is not ``free_form: true``), recurse into the keys.
    Unknown keys present in ``data`` but not in ``schema`` produce an
    ``unknown_key`` problem.
    """
    if not isinstance(data, dict):
        problems.append(
            Problem(
                path or "<root>",
                "wrong_type",
                f"expected dict at {path or '<root>'}, got {type(data).__name__}",
            )
        )
        return

    schema_keys = set(schema.keys())
    for field_name, field_schema in schema.items():
        field_path = f"{path}.{field_name}" if path else field_name
        required = bool(field_schema.get("required", False))
        present = field_name in data

        if not present:
            if required:
                problems.append(
                    Problem(
                        field_path,
                        "missing_required",
                        f"required field {field_path!r} is missing",
                    )
                )
            continue

        value = data[field_name]
        types = _types_of_field(field_schema)
        if types and not any(_type_matches(value, t) for t in types):
            problems.append(
                Problem(
                    field_path,
                    "wrong_type",
                    f"{field_path!r} has type {type(value).__name__}, expected {'|'.join(types)}",
                )
            )
            # Don't recurse into a value whose top-level shape is wrong.
            continue

        if "eq" in field_schema and value != field_schema["eq"]:
            problems.append(
                Problem(
                    field_path,
                    "eq_violation",
                    f"{field_path!r}={value!r}, expected {field_schema['eq']!r}",
                )
            )

        if "enum" in field_schema and value is not None and value not in field_schema["enum"]:
            problems.append(
                Problem(
                    field_path,
                    "enum_violation",
                    f"{field_path!r}={value!r} not in {field_schema['enum']!r}",
                )
            )

        # Recurse into nested dicts unless free_form.
        if (
            "dict" in types
            and isinstance(value, dict)
            and "keys" in field_schema
            and not field_schema.get("free_form", False)
        ):
            _walk(value, field_schema["keys"], field_path, problems)

    # Surface unknown keys at THIS level (only for non-free_form blocks).
    for present_key in data.keys():
        if present_key not in schema_keys:
            problems.append(
                Problem(
                    f"{path}.{present_key}" if path else present_key,
                    "unknown_key",
                    f"unknown key {present_key!r}"
                    + (f" under {path!r}" if path else ""),
                )
            )


def validate(data: dict, run_id: str | None = None, schema: dict | None = None) -> list[Problem]:
    """Walk ``data`` against the metadata schema and return all problems.

    Pure: no I/O if ``schema`` is supplied. Tests pass synthetic schemas to
    exercise edge cases without touching disk.

    ``run_id`` is accepted for symmetry with caller-side logging — the walker
    itself doesn't use it.
    """
    if schema is None:
        # Default: pull the project schema. We rely on the caller already
        # having a Config, so load() does the wiring; this branch exists so
        # ad-hoc callers can do ``validate(data)`` against the shipped schema.
        # We resolve relative to this file rather than re-doing config lookup.
        schema_path = pathlib.Path(__file__).resolve().parent.parent / "schemas" / "run-metadata.yaml"
        schema = _load_schema_from_path(schema_path)
    problems: list[Problem] = []
    schema_root = schema["schema"] if "schema" in schema else schema
    _walk(data, schema_root, "", problems)
    return problems


@lru_cache(maxsize=4)
def _load_schema_from_path(path: pathlib.Path) -> dict:
    if not path.exists():
        raise MetadataError(f"metadata schema not found: {path}")
    with open(path) as f:
        data = yaml_io.loads(f.read())
    if not isinstance(data, dict) or "schema" not in data:
        raise MetadataError(f"{path}: expected top-level 'schema:' mapping")
    return data


def _schema_for(cfg: Config) -> dict:
    return _load_schema_from_path(cfg.schemas_path / "run-metadata.yaml")


def _validation_mode(cfg: Config) -> str:
    """Read ``policies.metadata_validation`` from agent-workbench.yaml.

    Default: ``warn``. Allowed: ``warn``, ``strict``. Any other value falls
    back to ``warn`` with a warning to stderr so a typo doesn't silently
    disable strict mode.
    """
    pol = (cfg.raw.get("policies") or {})
    mode = pol.get("metadata_validation", "warn")
    if mode not in ("warn", "strict"):
        print(
            f"metadata.yaml: policies.metadata_validation={mode!r} unrecognized, defaulting to 'warn'",
            file=sys.stderr,
        )
        return "warn"
    return mode


def _filter_problems_for_mode(problems: list[Problem], mode: str) -> list[Problem]:
    """In ``warn`` mode, suppress ``unknown_key`` problems (additive backcompat).

    In ``strict`` mode, all problems count.
    """
    if mode == "strict":
        return problems
    return [p for p in problems if p.code != "unknown_key"]


def _report_problems(problems: list[Problem], run_id: str, mode: str) -> None:
    """Print or raise based on ``mode``. No-op if ``problems`` is empty."""
    if not problems:
        return
    lines = [
        f"metadata.yaml: run={run_id}: {p.path}: [{p.code}] {p.message}"
        for p in problems
    ]
    if mode == "strict":
        raise MetadataError("metadata schema violations:\n  " + "\n  ".join(lines))
    for line in lines:
        print(line, file=sys.stderr)


# ---------- public constants kept in sync with the schema ----------


STATUSES = {
    "draft",
    "shaping",
    "planning",
    "ready",
    "building",
    "validating",
    "followups",
    "human_review",
    "done",
    "abandoned",
}

REQUIRED_TOP_LEVEL = (
    "schema_version",
    "run_id",
    "status",
    "created_at",
    "updated_at",
    "target",
    "scope",
    "artifacts",
    "validation",
    "completion",
)


def _assert_constants_match_schema() -> None:
    """Fail loudly at import time if the schema and Python constants drift.

    Catches the case where someone adds a status to the enum (or to the
    REQUIRED_TOP_LEVEL list) without updating both places.
    """
    schema_path = pathlib.Path(__file__).resolve().parent.parent / "schemas" / "run-metadata.yaml"
    if not schema_path.exists():
        # Tooling-only environments may run before the workbench tree is fully
        # populated. Don't block import.
        return
    try:
        schema = _load_schema_from_path(schema_path)
    except MetadataError:
        return
    s = schema["schema"]
    schema_statuses = set(s["status"]["enum"])
    if schema_statuses != STATUSES:
        raise MetadataError(
            "STATUSES drift: "
            f"in code but not schema={STATUSES - schema_statuses!r}, "
            f"in schema but not code={schema_statuses - STATUSES!r}"
        )
    schema_required = tuple(
        k for k, v in s.items() if isinstance(v, dict) and v.get("required") is True
    )
    if set(schema_required) != set(REQUIRED_TOP_LEVEL):
        raise MetadataError(
            "REQUIRED_TOP_LEVEL drift: "
            f"in code but not schema={set(REQUIRED_TOP_LEVEL) - set(schema_required)!r}, "
            f"in schema but not code={set(schema_required) - set(REQUIRED_TOP_LEVEL)!r}"
        )


_assert_constants_match_schema()


def now_iso() -> str:
    """ISO-8601 timestamp with seconds resolution, local time + offset."""
    return dt.datetime.now().astimezone().replace(microsecond=0).isoformat()


def run_dir(cfg: Config, run_id: str) -> pathlib.Path:
    """Where does this run live on disk?

    For runs whose metadata is already on disk, the path honors
    ``target.worktree.path`` (self-modifying runs live inside their
    worktree). For runs with no metadata yet (e.g. before
    ``metadata.create`` writes the first file) this falls back to
    ``cfg.runs_path / run_id`` — which is also where ``create`` writes
    the seed and where non-self-modifying runs stay.
    """
    # Local import keeps the module-load graph acyclic (lib.runs imports
    # nothing from this module, but lib.runs.find_run drives metadata
    # discovery elsewhere).
    from lib import runs as runs_mod

    candidate = cfg.runs_path / run_id
    meta_at_master = candidate / "metadata.yaml"
    if meta_at_master.exists():
        try:
            data = yaml_io.loads(meta_at_master.read_text())
        except Exception:
            return candidate
        if isinstance(data, dict):
            return runs_mod.resolve_run_dir_for_meta(cfg, run_id, data)
        return candidate
    # No master-side metadata; the run may live entirely in a worktree.
    try:
        run = runs_mod.find_run(cfg, run_id)
        return run.run_dir
    except (runs_mod.RunNotFound, runs_mod.RunCollision):
        return candidate


def metadata_path(cfg: Config, run_id: str) -> pathlib.Path:
    return run_dir(cfg, run_id) / "metadata.yaml"


def _check_duplicate_metadata(run_dir_path: pathlib.Path, run_id: str) -> None:
    """Refuse to load when more than one metadata.yaml lives under run_dir.

    Always-on integrity check; runs before YAML parsing. Independent of the
    warn/strict policy — duplicates are never a soft warning.
    """
    if not run_dir_path.is_dir():
        return
    matches = list(run_dir_path.rglob("metadata.yaml"))
    if len(matches) > 1:
        paths = "\n  ".join(str(m) for m in sorted(matches))
        raise MetadataError(
            f"run {run_id!r}: multiple metadata.yaml files in {run_dir_path}:\n  {paths}"
        )


def _validate(data: dict) -> None:
    """Cheap structural pre-check used by ``save()``.

    The full schema walk runs on ``load()``. ``save()`` keeps the original
    quick check so we never *write* a metadata.yaml that's missing
    REQUIRED_TOP_LEVEL or has a bad status. Writing is rarer than reading and
    the writer's check stays narrow (the schema walk catches the rest the
    next time anyone loads).
    """
    if not isinstance(data, dict):
        raise MetadataError("metadata must be a mapping")
    missing = [k for k in REQUIRED_TOP_LEVEL if k not in data]
    if missing:
        raise MetadataError(f"missing required keys: {missing}")
    status = data["status"]
    if status not in STATUSES:
        raise MetadataError(f"invalid status: {status!r}")


def load(cfg: Config, run_id: str) -> dict:
    p = metadata_path(cfg, run_id)
    if not p.exists():
        raise MetadataError(f"no metadata for run {run_id!r}: {p}")
    _check_duplicate_metadata(p.parent, run_id)
    with open(p) as f:
        data = yaml_io.loads(f.read())
    if not isinstance(data, dict):
        raise MetadataError(f"{p}: top-level must be a mapping")
    # Quick structural check matches the old behavior — keeps load() crashing
    # loudly on truly malformed inputs (no status, etc.) regardless of mode.
    _validate(data)
    # Full schema walk: emits warnings or raises based on mode.
    mode = _validation_mode(cfg)
    problems = _filter_problems_for_mode(
        validate(data, run_id=run_id, schema=_schema_for(cfg)), mode
    )
    _report_problems(problems, run_id=run_id, mode=mode)
    return data


def save(cfg: Config, run_id: str, data: dict, *, dest: pathlib.Path | None = None) -> None:
    """Write metadata.yaml for one run.

    ``dest`` lets the caller bypass the run_dir lookup (used by ``create``
    on the seed write, when run_dir's resolution can't see the freshly-
    created directory yet).
    """
    _validate(data)
    data["updated_at"] = now_iso()
    if dest is not None:
        p = dest / "metadata.yaml"
    else:
        p = metadata_path(cfg, run_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    with open(tmp, "w") as f:
        f.write(yaml_io.dumps(data))
    tmp.replace(p)


def create(
    cfg: Config,
    run_id: str,
    *,
    repo_mode: str,
    repo_path: str,
    repo_name: str,
    base_ref: str,
    worktree_name: str,
    branch_name: str,
    raw_idea_path: str,
    scope_kind: str = "implementation",
    scope_summary: str = "",
    worktree_path: str | None = None,
    base_ref_sha: str | None = None,
    run_dir_override: pathlib.Path | None = None,
) -> dict:
    """Create the run directory and initial metadata.yaml. Returns the saved metadata.

    ``worktree_path`` + ``base_ref_sha`` are populated when ``new-run`` creates
    the worktree up front (TODO §1A). ``run_dir_override`` is the absolute
    path to write the run dir at — used by ``new-run`` for self-modifying
    runs to place the dir inside the freshly-created worktree.
    """
    rd = run_dir_override if run_dir_override is not None else run_dir(cfg, run_id)
    if rd.exists():
        raise MetadataError(f"run {run_id!r} already exists at {rd}")
    rd.mkdir(parents=True)
    now = now_iso()
    data: dict[str, Any] = {
        "schema_version": 1,
        "run_id": run_id,
        "status": "draft",
        "created_at": now,
        "updated_at": now,
        "target": {
            "repo": {
                "mode": repo_mode,
                "path": repo_path,
                "name": repo_name,
                "base_ref": base_ref,
                "base_ref_sha": base_ref_sha,
                "fingerprint": None,
                "created_by_run": run_id if repo_mode == "new" else None,
            },
            "worktree": {
                "name": worktree_name,
                "path": worktree_path,
                "branch_name": branch_name,
                "created": bool(worktree_path),
                "base_ref": base_ref,
                "initial_commit_sha": None,
            },
        },
        "scope": {
            "kind": scope_kind,
            "summary": scope_summary,
        },
        "artifacts": {
            "raw_idea": raw_idea_path,
            "answers": None,
            "brief": None,
            "plan": None,
            "preflight": None,
            "assumptions": None,
            "decisions": None,
            "implementation_summary": None,
            "diff_summary": None,
            "review_report": None,
            "qa_report": None,
            "audit": None,
            "handoff": None,
            "followups": None,
        },
        "validation": {
            "required": True,
            "review_completed": False,
            "qa_completed": False,
            "qa_recorded": False,
            "tests_passed": None,
            "known_issues_count": 0,
        },
        "completion": {
            "accepted_by": None,
            "completion_ref": None,
            "completed_at": None,
            "abandoned_reason": None,
        },
        # Build-loop telemetry surfaced for the reviewer (TODO §1e). Optional
        # at load time so flat-layout runs created before this field existed
        # still load; required to be filled by validate --init before
        # building -> validating.
        "build": {
            "iterations": None,
            "exit_reason": None,
            "max_iterations": _resolve_max_build_iterations(cfg),
        },
    }
    save(cfg, run_id, data, dest=rd)
    return data


def _resolve_max_build_iterations(cfg: Config) -> int:
    raw = cfg.raw.get("defaults", {}) or {}
    return int(raw.get("max_build_iterations", 5))


def set_status(cfg: Config, run_id: str, new_status: str) -> dict:
    """Used only by lib/transitions. Other code MUST NOT call this."""
    if new_status not in STATUSES:
        raise MetadataError(f"invalid status: {new_status!r}")
    data = load(cfg, run_id)
    data["status"] = new_status
    save(cfg, run_id, data)
    return data


def update(cfg: Config, run_id: str, mutator) -> dict:
    """Apply a callable to the metadata dict in place and save. Convenience helper."""
    data = load(cfg, run_id)
    mutator(data)
    save(cfg, run_id, data)
    return data


def list_runs(cfg: Config) -> list[str]:
    """Run ids across master + every live worktree, deduplicated."""
    # Local import to keep the module-load graph acyclic.
    from lib import runs as runs_mod
    return [r.run_id for r in runs_mod.iter_all_runs(cfg)]
