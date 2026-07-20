"""Parse and validate the followups stage's follow-ups.md (TODO §1f).

The file contains 1–5 mini-briefs, each delimited by YAML frontmatter:

    ---
    title: <short title>
    motivation: <why this matters>
    suggested_scope: <one-run-sized chunk>
    category: tech_debt | scope_extension | bug_risk | refactor | docs |
              deferred_from_bounce | no_followups
    ---

The `no_followups` category is the explicit-opt-out sentinel: when a run has
nothing forward-looking to surface, the author writes exactly one entry with
this category and a motivation explaining the absence. Empty file is invalid.

Public surface:
    VALID_CATEGORIES                  set of allowed `category:` values
    REQUIRED_FRONTMATTER_KEYS         tuple of keys every entry must have
    NO_FOLLOWUPS_CATEGORY             sentinel category value
    extract_entries(md_text)          list of parsed entry dicts
    validate(md_text)                 list[str] of errors; empty = OK
"""
from __future__ import annotations

import re

from lib import yaml_io


NO_FOLLOWUPS_CATEGORY = "no_followups"

VALID_CATEGORIES = frozenset({
    "tech_debt",
    "scope_extension",
    "bug_risk",
    "refactor",
    "docs",
    "deferred_from_bounce",
    NO_FOLLOWUPS_CATEGORY,
})

REQUIRED_FRONTMATTER_KEYS = ("title", "motivation", "suggested_scope", "category")


# A frontmatter block is `---\n<yaml>\n---` at a line boundary.
# Capture the YAML body between the delimiters.
_BLOCK_RE = re.compile(
    r"^---\s*\n(?P<body>.*?)\n---\s*$",
    re.MULTILINE | re.DOTALL,
)


def extract_entries(md_text: str) -> list[dict]:
    """Return a list of frontmatter dicts (in document order).

    Bodies that can't be parsed as the YAML subset are silently skipped — the
    caller's validate() will surface that as "no entries found".
    """
    entries: list[dict] = []
    for m in _BLOCK_RE.finditer(md_text):
        body = m.group("body")
        try:
            data = yaml_io.loads(body)
        except yaml_io.YamlSubsetError:
            continue
        if isinstance(data, dict):
            entries.append(data)
    return entries


def validate(md_text: str) -> list[str]:
    """Return a list of error strings; empty list means the file is valid."""
    errors: list[str] = []
    entries = extract_entries(md_text)
    if not entries:
        errors.append(
            "follow-ups.md has no frontmatter entries; if there are no "
            "follow-ups, add one explicit entry with category: no_followups"
        )
        return errors
    seen_titles: set[str] = set()
    for i, entry in enumerate(entries, start=1):
        label = f"entry #{i}"
        missing = [k for k in REQUIRED_FRONTMATTER_KEYS if not entry.get(k)]
        if missing:
            errors.append(f"{label}: missing required keys: {missing}")
            continue
        category = entry["category"]
        if category not in VALID_CATEGORIES:
            errors.append(
                f"{label}: invalid category {category!r}; "
                f"must be one of {sorted(VALID_CATEGORIES)}"
            )
        title = str(entry["title"]).strip()
        if title in seen_titles:
            errors.append(f"{label}: duplicate title {title!r}")
        else:
            seen_titles.add(title)
    # If the file uses the explicit-none sentinel, it must be the SOLE entry.
    if any(e.get("category") == NO_FOLLOWUPS_CATEGORY for e in entries) and len(entries) > 1:
        errors.append(
            "follow-ups.md uses the no_followups sentinel alongside real entries; "
            "drop the sentinel or remove the other entries"
        )
    return errors


def categories(entries: list[dict]) -> list[str]:
    """Return the (de-duplicated, sorted) list of categories used."""
    return sorted({str(e.get("category") or "") for e in entries if e.get("category")})
