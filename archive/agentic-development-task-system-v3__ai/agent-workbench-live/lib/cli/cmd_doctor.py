"""doctor subcommand. Validate the workbench root."""
from __future__ import annotations

import json
import pathlib

from lib import yaml_io, config as config_mod
from lib.cli._common import fail, load_config


HELP = "Validate the workbench root, schemas, and config."


def register(p) -> None:
    pass


def _check_file(p: pathlib.Path) -> bool:
    if not p.exists():
        print(f"  MISSING  {p}")
        return False
    print(f"  ok       {p}")
    return True


def run(args) -> int:
    root = pathlib.Path(args.root).resolve()
    print(f"workbench root: {root}")
    ok = True

    print("layout:")
    for sub in ("bin/agent-workbench", "lib", "schemas", "templates", "agent-workbench.yaml"):
        if not _check_file(root / sub):
            ok = False
    print()

    print("schemas:")
    for name in ("events.jsonl", "run-metadata.yaml", "transitions.yaml"):
        p = root / "schemas" / name
        if not p.exists():
            print(f"  MISSING  {p}")
            ok = False
            continue
        try:
            if name.endswith(".jsonl"):
                for n, line in enumerate(p.read_text().splitlines(), start=1):
                    line = line.strip()
                    if not line:
                        continue
                    json.loads(line)
            else:
                yaml_io.loads(p.read_text())
            print(f"  ok       {p}")
        except Exception as e:
            print(f"  INVALID  {p}: {e}")
            ok = False
    print()

    print("config:")
    cfg = None
    try:
        cfg = config_mod.load(root)
        print(f"  ok       agent-workbench.yaml (cli={cfg.cli_name})")
    except Exception as e:
        print(f"  INVALID  agent-workbench.yaml: {e}")
        ok = False
    print()

    # TODO §1B3: orphan check. Any runs/<id>/ in master's working tree whose
    # status is anything other than `done` or `abandoned` is an orphan from
    # the pre-A1 behaviour. Soft warning — never fails the doctor.
    if cfg is not None:
        print("orphans:")
        orphans = _find_orphan_run_dirs(cfg)
        if not orphans:
            print("  ok       no orphans")
        else:
            for path, status in orphans:
                print(f"  WARN     {path} (status: {status})")
                print(
                    "           fix: move into the owning worktree, "
                    "or commit + merge if the run is already complete."
                )
        print()

    if ok:
        print("doctor: PASS")
        return 0
    print("doctor: FAIL")
    return 1


def _find_orphan_run_dirs(cfg) -> list[tuple[pathlib.Path, str]]:
    """Non-terminal run dirs in master's runs/ that should live in a worktree.

    Only meaningful when ``doctor`` runs against the main checkout (master).
    From inside a worktree, every entry under ``cfg.runs_path`` is by design
    the worktree's own run — the check is silently skipped.

    Skips the ``abandoned/`` archive subtree (those are by-design
    master-resident).
    """
    out: list[tuple[pathlib.Path, str]] = []
    if _running_inside_worktree(cfg):
        return out
    runs_path = cfg.runs_path
    if not runs_path.exists():
        return out
    for entry in sorted(runs_path.iterdir()):
        if not entry.is_dir() or entry.name == "abandoned":
            continue
        meta_path = entry / "metadata.yaml"
        if not meta_path.exists():
            continue
        try:
            data = yaml_io.loads(meta_path.read_text())
        except Exception:
            continue
        if not isinstance(data, dict):
            continue
        status = str(data.get("status") or "")
        if status in ("done", "abandoned"):
            continue
        out.append((entry, status))
    return out


def _running_inside_worktree(cfg) -> bool:
    """True iff cfg.root is inside a non-main worktree of its git repo.

    Worktree's ``.git`` is a file (pointing at the main repo's .git/worktrees/<n>);
    the main repo's ``.git`` is a directory.
    """
    for parent in [cfg.root, *cfg.root.parents]:
        dotgit = parent / ".git"
        if dotgit.is_dir():
            return False
        if dotgit.is_file():
            return True
    return False
