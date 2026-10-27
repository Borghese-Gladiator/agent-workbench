"""Workbench config loader.

Reads agent-workbench.yaml from the workbench root and exposes typed accessors.
"""
from __future__ import annotations

import pathlib
from dataclasses import dataclass
from typing import Any

from lib import yaml_io


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Paths:
    runs_dir: str
    worktrees_dir: str
    schemas_dir: str


@dataclass(frozen=True)
class Defaults:
    branch_prefix: str
    base_ref: str
    run_id_template: str
    worktree_name_template: str
    branch_name_template: str
    new_repo_default_layout: str


@dataclass(frozen=True)
class Gates:
    require_ready_gate: bool
    require_preimplementation_audit_inputs: bool
    require_validation_before_human_review: bool
    require_handoff_before_human_review: bool
    require_acceptance_before_done: bool


@dataclass(frozen=True)
class Artifacts:
    raw_idea: str
    answers: str
    brief: str
    plan: str
    preflight: str
    assumptions: str
    decisions: str
    implementation_summary: str
    diff_summary: str
    review_report: str
    qa_report: str
    audit: str
    handoff: str


@dataclass(frozen=True)
class Validation:
    qa_commands_file: str
    qa_report_file: str
    qa_artifacts_dir: str
    qa_recordings_dir: str
    qa_traces_dir: str


@dataclass(frozen=True)
class Config:
    root: pathlib.Path
    cli_name: str
    paths: Paths
    defaults: Defaults
    gates: Gates
    artifacts: Artifacts
    validation: Validation
    raw: dict  # full parsed YAML, for less-common keys

    @property
    def runs_path(self) -> pathlib.Path:
        return self.root / self.paths.runs_dir

    @property
    def worktrees_path(self) -> pathlib.Path:
        wt = pathlib.Path(self.paths.worktrees_dir).expanduser()
        return wt if wt.is_absolute() else self.root / wt

    @property
    def schemas_path(self) -> pathlib.Path:
        return self.root / self.paths.schemas_dir


def _req(d: dict, key: str, where: str) -> Any:
    if key not in d:
        raise ConfigError(f"missing key {key!r} in {where}")
    return d[key]


def load(root: pathlib.Path) -> Config:
    path = root / "agent-workbench.yaml"
    if not path.exists():
        raise ConfigError(f"config not found: {path}")
    with open(path) as f:
        raw = yaml_io.loads(f.read())
    if not isinstance(raw, dict):
        raise ConfigError(f"{path}: top-level must be a mapping")

    cli = _req(raw, "cli", str(path))
    paths_d = _req(raw, "paths", str(path))
    defaults_d = _req(raw, "defaults", str(path))
    gates_d = _req(raw, "gates", str(path))
    artifacts_d = _req(raw, "artifacts", str(path))
    validation_d = _req(raw, "validation", str(path))

    return Config(
        root=root.resolve(),
        cli_name=_req(cli, "name", "cli"),
        paths=Paths(
            runs_dir=_req(paths_d, "runs_dir", "paths"),
            worktrees_dir=_req(paths_d, "worktrees_dir", "paths"),
            schemas_dir=_req(paths_d, "schemas_dir", "paths"),
        ),
        defaults=Defaults(
            branch_prefix=_req(defaults_d, "branch_prefix", "defaults"),
            base_ref=_req(defaults_d, "base_ref", "defaults"),
            run_id_template=_req(defaults_d, "run_id_template", "defaults"),
            worktree_name_template=_req(defaults_d, "worktree_name_template", "defaults"),
            branch_name_template=_req(defaults_d, "branch_name_template", "defaults"),
            new_repo_default_layout=_req(defaults_d, "new_repo_default_layout", "defaults"),
        ),
        gates=Gates(
            require_ready_gate=bool(_req(gates_d, "require_ready_gate", "gates")),
            require_preimplementation_audit_inputs=bool(
                _req(gates_d, "require_preimplementation_audit_inputs", "gates")
            ),
            require_validation_before_human_review=bool(
                _req(gates_d, "require_validation_before_human_review", "gates")
            ),
            require_handoff_before_human_review=bool(
                _req(gates_d, "require_handoff_before_human_review", "gates")
            ),
            require_acceptance_before_done=bool(
                _req(gates_d, "require_acceptance_before_done", "gates")
            ),
        ),
        artifacts=Artifacts(
            raw_idea=_req(artifacts_d, "raw_idea", "artifacts"),
            answers=_req(artifacts_d, "answers", "artifacts"),
            brief=_req(artifacts_d, "brief", "artifacts"),
            plan=_req(artifacts_d, "plan", "artifacts"),
            preflight=_req(artifacts_d, "preflight", "artifacts"),
            assumptions=_req(artifacts_d, "assumptions", "artifacts"),
            decisions=_req(artifacts_d, "decisions", "artifacts"),
            implementation_summary=_req(artifacts_d, "implementation_summary", "artifacts"),
            diff_summary=_req(artifacts_d, "diff_summary", "artifacts"),
            review_report=_req(artifacts_d, "review_report", "artifacts"),
            qa_report=_req(artifacts_d, "qa_report", "artifacts"),
            audit=_req(artifacts_d, "audit", "artifacts"),
            handoff=_req(artifacts_d, "handoff", "artifacts"),
        ),
        validation=Validation(
            qa_commands_file=_req(validation_d, "qa_commands_file", "validation"),
            qa_report_file=_req(validation_d, "qa_report_file", "validation"),
            qa_artifacts_dir=_req(validation_d, "qa_artifacts_dir", "validation"),
            qa_recordings_dir=_req(validation_d, "qa_recordings_dir", "validation"),
            qa_traces_dir=_req(validation_d, "qa_traces_dir", "validation"),
        ),
        raw=raw,
    )
