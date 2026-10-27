"""Manual-QA: validate every real-run metadata.yaml under master against the new schema.

Exits 0 if every real run has zero non-`unknown_key` problems in warn mode (i.e.
zero true violations). Exits 1 with a per-run summary otherwise. Per-run
`unknown_key` counts are reported informationally — warn mode suppresses them
in load() but we want visibility for reviewer notes.

Acceptance criterion #2: existing runs/ directories load without warnings under
default mode. This script enforces that empirically over all 20 master-side runs.
"""
from __future__ import annotations

import pathlib
import sys

# Pull lib/ from the worktree (where the new schema/validator live).
REPO_ROOT = pathlib.Path(
    "/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/"
    "agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/"
    "20260527__schema-level-validation-for-metadata-yaml/"
    "agentic-development-task-system-v3__ai/agent-workbench-live"
)
sys.path.insert(0, str(REPO_ROOT))

from lib import metadata, yaml_io  # noqa: E402

REAL_RUNS = pathlib.Path(
    "/Users/timothy.shee/GitHub/new-tech-monorepo/"
    "agentic-development-task-system-v3__ai/agent-workbench-live/runs"
)


def main() -> int:
    schema_path = REPO_ROOT / "schemas" / "run-metadata.yaml"
    schema = metadata._load_schema_from_path(schema_path)
    print(f"schema:    {schema_path}")
    print(f"runs dir:  {REAL_RUNS}")
    print()

    runs = sorted(REAL_RUNS.glob("*/metadata.yaml"))
    print(f"found {len(runs)} runs\n")

    any_bad = False
    for meta_file in runs:
        data = yaml_io.loads(meta_file.read_text())
        problems = metadata.validate(data, run_id=meta_file.parent.name, schema=schema)
        non_unknown = [p for p in problems if p.code != "unknown_key"]
        unknown = [p for p in problems if p.code == "unknown_key"]
        status = "OK   " if not non_unknown else "FAIL "
        print(f"  {status} {meta_file.parent.name}: "
              f"{len(non_unknown)} real, {len(unknown)} unknown")
        if non_unknown:
            any_bad = True
            for p in non_unknown:
                print(f"        - [{p.code}] {p.path}: {p.message}")
    print()
    if any_bad:
        print("RESULT: at least one real run has true (non-unknown) violations.")
        return 1
    print("RESULT: every real run validates clean under warn-mode rules "
          "(zero non-unknown_key problems).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
