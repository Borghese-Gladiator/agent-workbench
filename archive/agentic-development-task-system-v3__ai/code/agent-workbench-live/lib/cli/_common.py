"""Helpers shared by CLI subcommands."""
from __future__ import annotations

import getpass
import json
import pathlib
import sys
from typing import Any

from lib import config as config_mod
from lib.config import Config


def load_config(args) -> Config:
    return config_mod.load(args.root)


def actor_from_env(role: str = "agent") -> dict:
    """Default actor when the caller doesn't supply one."""
    name = "unknown"
    try:
        name = getpass.getuser()
    except Exception:
        pass
    return {"type": role, "name": name}


def fail(msg: str, exit_code: int = 2) -> int:
    print(f"error: {msg}", file=sys.stderr)
    return exit_code


def print_json(data: Any) -> None:
    print(json.dumps(data, indent=2, default=str))


def template_path(cfg: Config, name: str) -> pathlib.Path:
    return cfg.root / "templates" / name


def copy_template_if_missing(cfg: Config, run_dir: pathlib.Path, name: str) -> pathlib.Path:
    """Copy templates/<name> into run_dir if absent. Returns the destination."""
    dest = run_dir / name
    if dest.exists():
        return dest
    src = template_path(cfg, name)
    if not src.exists():
        # OK — not every artifact needs a template.
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text("")
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(src.read_text())
    return dest
