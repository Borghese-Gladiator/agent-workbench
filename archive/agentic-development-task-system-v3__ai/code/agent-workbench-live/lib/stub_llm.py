"""LLM-stub mode for E2E testing (TODO §1).

When `AGENT_WORKBENCH_STUB_LLM` is set, the LLM-bearing CLI subcommands
(`shape`, `plan`, `validate`, `followups`) skip authoring artifacts via a
model and instead copy canned files from a fixture directory.

Layout the helper expects under `<fixture-dir>/`:

    shaping/brief.md
    planning/plan.md
    building/build.md
    validating/review.md
    validating/qa/report.md
    validating/HUMAN_REVIEW.md
    followups/follow-ups.md

Each stage maps to the files the matching `--init` step normally leaves
empty for the model to fill. The helper writes them at the run root —
where the finalize step looks before the transition engine moves them
under `stages/<N>_<stage>/`.

The module is pure-stdlib and lives outside the slash command bodies on
purpose: stub-LLM mode is invoked by the CLI's `--init` Bash step, so
slash command markdown stays unchanged.
"""
from __future__ import annotations

import os
import pathlib
import shutil


ENV_VAR = "AGENT_WORKBENCH_STUB_LLM"


# Stage -> list of (source path inside fixture dir, destination relative to run dir).
# Building's source is `build.md`; the builder writes that at the run root
# during the building stage. /shape and /plan stage their own runs of init,
# but for stub-LLM we materialize artifacts during the same --init step for
# all four LLM-bearing stages (shape, plan, validate, followups).
_STAGE_FILES: dict[str, tuple[tuple[str, str], ...]] = {
    "shaping": (
        ("shaping/brief.md", "brief.md"),
    ),
    "planning": (
        ("planning/plan.md", "plan.md"),
    ),
    "building": (
        ("building/build.md", "build.md"),
    ),
    "validating": (
        ("validating/review.md", "review.md"),
        ("validating/qa/report.md", "qa/report.md"),
        ("validating/HUMAN_REVIEW.md", "HUMAN_REVIEW.md"),
    ),
    "followups": (
        ("followups/follow-ups.md", "follow-ups.md"),
    ),
}


class StubLLMError(Exception):
    pass


def fixture_dir_from_env() -> pathlib.Path | None:
    """Return the fixture dir set in the env, or None when the var is unset.

    Raises StubLLMError if the var is set but the path doesn't exist — a
    fat-fingered env var should fail loudly, not silently fall back to LLM
    mode."""
    val = os.environ.get(ENV_VAR)
    if not val:
        return None
    p = pathlib.Path(val).resolve()
    if not p.is_dir():
        raise StubLLMError(
            f"{ENV_VAR}={val} is set but the path is not a directory"
        )
    return p


def materialize(run_dir: pathlib.Path, stage: str, fixture_dir: pathlib.Path) -> list[pathlib.Path]:
    """Copy the canned artifacts for `stage` into `run_dir`. Returns the
    list of files written (absolute paths). Overwrites existing files —
    the calling `--init` step staged templates that the fixtures replace."""
    spec = _STAGE_FILES.get(stage)
    if spec is None:
        raise StubLLMError(f"unknown stage: {stage!r}")
    written: list[pathlib.Path] = []
    for rel_src, rel_dst in spec:
        src = fixture_dir / rel_src
        if not src.exists():
            # A scenario can legitimately omit some files (e.g. the abandon
            # scenario never reaches validating). Skip silently so callers
            # don't have to special-case.
            continue
        dst = run_dir / rel_dst
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)
        written.append(dst)
    return written
