"""One-shot backfill: rewrite legacy `local-branch:` completion_refs to `merge:<sha>`.

Three runs reached `status: done` before `cmd_complete` learned to auto-merge
(see TODO §1, resolved 2026-05-24). Their `metadata.completion.completion_ref`
still carries the legacy `local-branch:<branch>` label. The merges happened by
hand against the v3 monorepo's `master`. This script rewrites the label to
`merge:<full-sha>` using the known SHAs from `docs/TODO.md` § "Completed work".

The dirty-tree refusal that forced several later runs into the manual-merge
path was the runs/<id>/.lock file showing up in `git status --porcelain`.
That root cause was fixed on 2026-05-25 by adding a workbench-scoped entry
to the root .gitignore (see docs/LOG.md). From that point on, `/complete`
merges without --no-merge and no new entries should be added to BACKFILL.
This script is legacy: keep it around for the existing rows, but new runs
should not require it.

Idempotent: re-running on already-backfilled metadata is a no-op.

Run from anywhere; pass the workbench root via --root, default is
`agent-workbench-live/` relative to this file.

Usage:
    python tools/backfill_completion_refs.py [--root agent-workbench-live] [--dry-run]
"""
from __future__ import annotations

import argparse
import pathlib
import sys


BACKFILL = {
    "2026-05-22-context-graph": "c6357454fb79562e504071ef59503f768af1283c",
    "2026-05-22-audit-unit-tests-for-duplication": "a02dd167c684aa2cc749dd42a7291466454c515d",
    "2026-05-22-token-efficiency-tracking": "271ab584632decc2121153004cc2442f28b32b01",
    # The run that ships the auto-merge code itself. The first `complete` ran
    # the legacy code path (because the new code wasn't live yet) and recorded
    # `local-branch:`; we merged by hand and now backfill the merge SHA.
    "2026-05-24-auto-merge-on-complete": "0069070afb24ff7df6b340cdc4335b52732d4a58",
    # TODO §2 (CLI stop banner). Same chicken-and-egg: the auto-merge code is
    # live on master but `complete`'s dirty-files pre-check refused on the
    # `runs/<id>/.lock` file that `locks.acquire` creates just before the
    # check runs (latent gap, tracked in this run's follow-ups). Used
    # `--no-merge` + `git merge --no-ff` by hand; backfill the merge SHA.
    "2026-05-24-cli-stop-banner-on-agent-stopping-transitions": "9eda554b2c5b6ea432f23b376133059925679ee9",
    # TODO §1 pass-2 (token efficiency). Hit the same `.lock`-during-dirty-check
    # gap as the stop-banner run; merged by hand.
    "2026-05-24-token-efficiency-pass-2": "be9f1122af28184d0d86aa6ac213291659c34135",
    # TODO §3 (fix generated_lines for base_ref=HEAD). Run reached `done` via the
    # legacy code path because its `runs/<id>/` lived in master's working tree
    # rather than the worktree (the §1 orphan-runs bug — see TODO §1), so the
    # auto-merge code didn't fire. Merged by hand; backfill the merge SHA.
    "2026-05-24-fix-generated-lines-base-ref-head": "303bd408dad335d6ed1d8b5bcf91a6fae3e52ad6",
    # TODO §2 (structured human_review handoff output). Same .lock-during-
    # dirty-check gap + an unrelated concurrent shengji run dir in master's
    # working tree blocked the auto-merge. Used --no-merge + manual
    # git merge --no-ff after temporarily moving the shengji dir aside.
    "2026-05-25-structured-human-review-handoff": "7dce6b9840a83cd75f01aff70cb9a50e3f98bbf0",
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--root",
        type=pathlib.Path,
        default=pathlib.Path(__file__).resolve().parent.parent,
        help="Workbench root (default: the dir containing tools/).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would change without writing.",
    )
    args = parser.parse_args(argv)

    # Lazy import — depends on PYTHONPATH being set up to find `lib/`.
    sys.path.insert(0, str(args.root))
    from lib import yaml_io

    runs_dir = args.root / "runs"
    if not runs_dir.is_dir():
        print(f"runs dir not found: {runs_dir}", file=sys.stderr)
        return 2

    changed = 0
    skipped = 0
    missing: list[str] = []

    for run_id, full_sha in BACKFILL.items():
        meta_path = runs_dir / run_id / "metadata.yaml"
        if not meta_path.exists():
            missing.append(run_id)
            continue

        text = meta_path.read_text()
        data = yaml_io.loads(text)
        if not isinstance(data, dict):
            print(f"{run_id}: metadata is not a mapping, skipping", file=sys.stderr)
            continue

        completion = data.setdefault("completion", {})
        current = completion.get("completion_ref")
        target = f"merge:{full_sha}"

        if current == target:
            skipped += 1
            print(f"{run_id}: already backfilled ({current})")
            continue

        if not isinstance(current, str) or not current.startswith("local-branch:"):
            # Don't clobber non-legacy refs.
            print(
                f"{run_id}: completion_ref is {current!r}, not a legacy label; skipping",
                file=sys.stderr,
            )
            continue

        print(f"{run_id}: {current!r} -> {target!r}")
        if args.dry_run:
            continue

        completion["completion_ref"] = target
        meta_path.write_text(yaml_io.dumps(data))
        changed += 1

    if missing:
        print("missing run directories: " + ", ".join(missing), file=sys.stderr)
    print(f"changed: {changed}, already-backfilled: {skipped}, missing: {len(missing)}")
    return 0 if not missing else 1


if __name__ == "__main__":
    sys.exit(main())
