"""Slug, run_id, branch, and worktree naming.

The templates live in agent-workbench.yaml.defaults, but the rules here are simple:
- run_id        := YYYY-MM-DD-<slug>
- worktree_name := <slug>  (unless caller overrides)
- worktree dir  := <YYYYMMDD>__<worktree_name>  (TODO §1, derived from run_id)
- branch_name   := <branch_prefix>/<worktree_name>
- repo_name     := slugified basename of the git **toplevel** (canonicalized
                   by the caller via `git rev-parse --show-toplevel`), not the
                   path the user typed. `derive_repo_name` itself is a pure
                   slugify — the toplevel-canonicalization is done at the
                   caller (cmd_new_run.py). `--repo-name` overrides this.
"""
from __future__ import annotations

import datetime as dt
import re
import unicodedata

from lib.config import Config


SLUG_MAX_LEN = 60


class NamingError(ValueError):
    pass


def slugify(text: str) -> str:
    """Lowercase kebab-case ASCII slug, length-capped, non-empty."""
    if not text:
        raise NamingError("empty slug input")
    # Normalize unicode -> ascii.
    norm = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    norm = norm.lower()
    # Replace non-alphanumeric runs with single hyphen.
    norm = re.sub(r"[^a-z0-9]+", "-", norm)
    norm = norm.strip("-")
    if not norm:
        raise NamingError(f"slug became empty after sanitization: {text!r}")
    if len(norm) > SLUG_MAX_LEN:
        norm = norm[:SLUG_MAX_LEN].rstrip("-") or norm[:SLUG_MAX_LEN]
    return norm


def make_run_id(slug: str, today: dt.date | None = None) -> str:
    today = today or dt.date.today()
    return f"{today.isoformat()}-{slug}"


def make_branch_name(cfg: Config, worktree_name: str) -> str:
    prefix = cfg.defaults.branch_prefix
    return f"{prefix}/{worktree_name}"


def derive_repo_name(repo_path_basename: str) -> str:
    """Default repo name = basename of repo path; sanitize the same way as slugs."""
    return slugify(repo_path_basename)


_RUN_ID_DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})-")


def extract_run_date(run_id: str) -> str:
    """Return the YYYYMMDD prefix derived from a run_id (TODO §1).

    Example: extract_run_date("2026-05-21-foo") -> "20260521".
    Raises NamingError on a malformed run_id.
    """
    m = _RUN_ID_DATE_RE.match(run_id)
    if not m:
        raise NamingError(f"run_id missing YYYY-MM-DD prefix: {run_id!r}")
    return f"{m.group(1)}{m.group(2)}{m.group(3)}"


def make_worktree_path(cfg: Config, repo_name: str, worktree_name: str, run_id: str):
    """Compose the worktree path.

    Last segment is `<YYYYMMDD>__<worktree_name>` (TODO §1) so a glance at
    `worktrees/<repo_name>/` reveals both the date and the slug. The date
    comes from the run_id rather than `datetime.now()` so the path stays
    idempotent across calls.
    """
    date = extract_run_date(run_id)
    return cfg.worktrees_path / repo_name / f"{date}__{worktree_name}"
