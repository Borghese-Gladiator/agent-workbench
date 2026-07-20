"""Parse a fenced WBS block out of a run's `decisions.md`.

The WBS block is the contract between an investigation run and `spawn-children.sh`.
Format inside the parent run's `decisions.md`:

    ## WBS — children to spawn

    ```yaml
    children:
      - slug: "dashboard-shell"
        repo_key: "frontend"
        summary: "Shell-level dashboard route"
      - slug: "channel-data-api"
        repo_key: "backend"
        summary: "GET /channels endpoint"
    ```

The heading must appear exactly once. The first ` ```yaml ` fence after it is
the WBS payload; we hand its body to `lib._yaml.loads()`.

Rejection-on-ambiguity: zero matches → error; multiple matches → error;
missing required fields on any child → error pointing at the offending index.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from . import _yaml


_WBS_HEADING_RE = re.compile(
    r"^##\s*WBS\b.*$",  # tolerates "## WBS — children to spawn", "## WBS", etc.
    re.MULTILINE,
)
_FENCE_OPEN_RE = re.compile(r"^```ya?ml\s*$", re.MULTILINE)
_FENCE_CLOSE_RE = re.compile(r"^```\s*$", re.MULTILINE)
# HTML comment block, possibly multi-line. Matches the entire <!-- ... --> span
# so we can strip scaffold/template blocks before scanning.
_HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)

# Reuse the slug regex from metadata.py without importing (avoid cycles).
_SLUG_RE = re.compile(r"^[a-z][a-z0-9-]*$")


class WbsError(ValueError):
    """Raised when a WBS block is missing, malformed, or invalid."""


@dataclass(frozen=True)
class WbsItem:
    slug: str
    repo_key: str
    summary: str = ""


def parse(decisions_md_path: Path) -> list[WbsItem]:
    """Return the WBS items from a parent run's decisions.md."""
    if not decisions_md_path.exists():
        raise WbsError(f"{decisions_md_path} does not exist")
    raw_text = decisions_md_path.read_text(encoding="utf-8")
    # Strip HTML comments so the template's commented-out WBS scaffold doesn't
    # confuse the heading scanner.
    text = _HTML_COMMENT_RE.sub("", raw_text)

    headings = list(_WBS_HEADING_RE.finditer(text))
    if not headings:
        raise WbsError(
            f"{decisions_md_path}: no '## WBS' heading found. "
            "Add a section named '## WBS — children to spawn' with a "
            "fenced yaml block listing children."
        )
    if len(headings) > 1:
        raise WbsError(
            f"{decisions_md_path}: found {len(headings)} '## WBS' headings; "
            "expected exactly one."
        )
    after = text[headings[0].end():]

    fence_open = _FENCE_OPEN_RE.search(after)
    if not fence_open:
        raise WbsError(
            f"{decisions_md_path}: no ```yaml fence found after the WBS heading."
        )
    body_start = fence_open.end()
    fence_close = _FENCE_CLOSE_RE.search(after, body_start)
    if not fence_close:
        raise WbsError(
            f"{decisions_md_path}: ```yaml fence opened but never closed."
        )
    body = after[body_start:fence_close.start()]

    try:
        parsed = _yaml.loads(body)
    except _yaml.YamlError as exc:
        raise WbsError(f"{decisions_md_path}: WBS yaml parse error: {exc}") from exc

    children = parsed.get("children")
    if not isinstance(children, list):
        raise WbsError(
            f"{decisions_md_path}: WBS block must contain a top-level "
            "`children:` list. Got: " + repr(children)
        )
    if not children:
        raise WbsError(
            f"{decisions_md_path}: WBS `children:` list is empty."
        )

    items: list[WbsItem] = []
    for idx, raw in enumerate(children):
        if not isinstance(raw, dict):
            raise WbsError(
                f"{decisions_md_path}: child #{idx} is not a mapping: {raw!r}"
            )
        slug = (raw.get("slug") or "").strip()
        repo_key = (raw.get("repo_key") or "").strip()
        summary = (raw.get("summary") or "").strip()
        if not slug:
            raise WbsError(f"{decisions_md_path}: child #{idx} is missing `slug`.")
        if not _SLUG_RE.match(slug):
            raise WbsError(
                f"{decisions_md_path}: child #{idx} slug {slug!r} must be "
                "kebab-case starting with a letter."
            )
        if not repo_key:
            raise WbsError(
                f"{decisions_md_path}: child #{idx} (slug={slug!r}) is missing `repo_key`."
            )
        items.append(WbsItem(slug=slug, repo_key=repo_key, summary=summary))

    return items
