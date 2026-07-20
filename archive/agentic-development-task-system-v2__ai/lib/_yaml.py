"""Minimal flat-YAML reader/writer using only the stdlib.

We deliberately avoid PyYAML/yq to keep ai-workbench zero-install. The YAML
shapes we care about are small and predictable:

  - `config/repos.yaml`: a top-level `repos:` mapping whose values are flat
    string-only mappings (path / github / default_branch).
  - `runs/<run_id>/metadata.yaml`: flat top-level mapping of string scalars.
  - WBS blocks inside `decisions.md` (read-only): a top-level mapping whose
    value is a list of flat string-only mappings.

This module supports exactly that subset:

  - `#` comments
  - blank lines
  - `key: value` (plain, single-quoted, or double-quoted scalars)
  - `key:` followed by a 2-space-indented mapping (one level deep, used for
    `repos:`)
  - `key:` followed by a 2-space-indented list of `- subkey: value` items
    (used for the WBS block; reader-only — `dumps()` does not emit lists)

Anything fancier (nested lists, multi-line scalars, anchors, flow style) is
rejected loudly. If we ever need more, we'll extend this module or take a
real YAML dependency at that point.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any


class YamlError(ValueError):
    """Raised when our minimal YAML parser sees something it cannot handle."""


def _strip_inline_comment(value: str) -> str:
    """Remove a trailing ` # comment` from an unquoted value.

    Quoted values are returned verbatim — `#` inside quotes is data, not a
    comment.
    """
    if not value:
        return value
    if value[0] in ('"', "'"):
        return value
    hash_idx = value.find(" #")
    if hash_idx == -1:
        return value
    return value[:hash_idx].rstrip()


def _parse_scalar(raw: str) -> str:
    """Parse a YAML scalar to a Python string. Empty string for empty scalar."""
    raw = raw.strip()
    if raw == "":
        return ""
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in ('"', "'"):
        # Trivial quote stripping. Our generated YAML never uses escapes, so a
        # full unescape is unnecessary. Reject embedded escapes loudly.
        body = raw[1:-1]
        if "\\" in body:
            raise YamlError(f"escape sequences not supported in scalars: {raw!r}")
        return body
    return _strip_inline_comment(raw)


def loads(text: str) -> dict[str, Any]:
    """Parse a flat-or-one-level-nested YAML document into a dict."""
    result: dict[str, Any] = {}
    current_parent: str | None = None  # key under which a 2-indent block is collected
    parent_block: Any = None             # dict (mapping mode) or list (list-of-mappings mode)
    nested_key: str | None = None         # current child key inside parent_block (mapping mode)

    for lineno, raw_line in enumerate(text.splitlines(), start=1):
        # Drop trailing whitespace; preserve leading for indent detection.
        line = raw_line.rstrip()
        if not line.strip():
            continue
        if line.lstrip().startswith("#"):
            continue

        indent = len(line) - len(line.lstrip(" "))
        stripped = line.lstrip(" ")

        if indent == 0:
            # Top-level. Either `key: value` or `key:` (start of nested block).
            if ":" not in stripped:
                raise YamlError(f"line {lineno}: expected 'key: value', got {line!r}")
            key, _, rest = stripped.partition(":")
            key = key.strip()
            rest_clean = _strip_inline_comment(rest.strip()) if not rest.strip().startswith(("'", '"')) else rest.strip()
            if rest_clean == "":
                # Start of a nested block. Mode (mapping vs. list) is decided by
                # the first child line.
                current_parent = key
                parent_block = None  # decided lazily
                result[key] = None    # placeholder; replaced when mode is known
                nested_key = None
            else:
                result[key] = _parse_scalar(rest)
                current_parent = None
                parent_block = None
                nested_key = None

        elif indent == 2:
            if current_parent is None:
                raise YamlError(
                    f"line {lineno}: indented line with no parent: {line!r}"
                )
            if stripped.startswith("- "):
                # List-of-mappings item. Lock parent into list mode if undecided;
                # reject if parent was already a mapping.
                if parent_block is None:
                    parent_block = []
                    result[current_parent] = parent_block
                if not isinstance(parent_block, list):
                    raise YamlError(
                        f"line {lineno}: list item under {current_parent!r}, "
                        "but earlier child made it a mapping"
                    )
                item_body = stripped[2:]  # strip "- "
                if ":" not in item_body:
                    raise YamlError(
                        f"line {lineno}: list item must be 'key: value', got {line!r}"
                    )
                ikey, _, irest = item_body.partition(":")
                new_item: dict[str, str] = {ikey.strip(): _parse_scalar(irest)}
                parent_block.append(new_item)
                nested_key = None
                continue

            # Mapping-mode child of the current parent.
            if parent_block is None:
                parent_block = {}
                result[current_parent] = parent_block
            if not isinstance(parent_block, dict):
                raise YamlError(
                    f"line {lineno}: mapping child under {current_parent!r}, "
                    "but earlier child made it a list"
                )
            if ":" not in stripped:
                raise YamlError(f"line {lineno}: expected 'key: value', got {line!r}")
            key, _, rest = stripped.partition(":")
            key = key.strip()
            rest_clean = _strip_inline_comment(rest.strip()) if not rest.strip().startswith(("'", '"')) else rest.strip()
            if rest_clean == "":
                # Grandchild mapping starting (e.g. `frontend:` under `repos:`).
                nested_key = key
                parent_block[key] = {}
            else:
                # Leaf scalar directly under parent (we don't currently use this
                # shape in our schemas, but accept it for completeness).
                parent_block[key] = _parse_scalar(rest)
                nested_key = None

        elif indent == 4:
            if current_parent is None or parent_block is None:
                raise YamlError(
                    f"line {lineno}: 4-space-indented line without parent: {line!r}"
                )
            if ":" not in stripped:
                raise YamlError(f"line {lineno}: expected 'key: value', got {line!r}")
            key, _, rest = stripped.partition(":")
            if isinstance(parent_block, list):
                # Continuation of the current list item.
                if not parent_block:
                    raise YamlError(
                        f"line {lineno}: 4-space-indented line before any list item"
                    )
                parent_block[-1][key.strip()] = _parse_scalar(rest)
            else:
                # Leaf inside a grandchild mapping (e.g. `path: /foo` under `frontend:`).
                if nested_key is None:
                    raise YamlError(
                        f"line {lineno}: 4-space-indented line without grandchild parent: {line!r}"
                    )
                grandchild = parent_block[nested_key]
                if not isinstance(grandchild, dict):
                    raise YamlError(
                        f"line {lineno}: expected mapping under {nested_key!r}, got scalar"
                    )
                grandchild[key.strip()] = _parse_scalar(rest)

        else:
            raise YamlError(
                f"line {lineno}: unexpected indent {indent}; "
                "supported indents are 0, 2, 4 spaces"
            )

    # If a top-level `key:` had no children, materialize it as an empty mapping
    # for backward-compatible behavior.
    for k, v in list(result.items()):
        if v is None:
            result[k] = {}

    return result


def load(path: Path) -> dict[str, Any]:
    """Read and parse a YAML file."""
    return loads(path.read_text(encoding="utf-8"))


def _quote_if_needed(value: str) -> str:
    """Wrap a string in double quotes when it could be misread as YAML syntax."""
    if value == "":
        return '""'
    needs_quote = (
        value[0] in (" ", "#", "-", "?", ":", "&", "*", "!", "|", ">", "%", "@", "`", "[", "{", "'", '"')
        or value[-1] == " "
        or ":" in value
        or "#" in value
        or "\n" in value
    )
    if "\n" in value:
        # We deliberately do not support multi-line scalars in the writer.
        raise YamlError("multi-line string values are not supported")
    if needs_quote:
        if '"' in value:
            raise YamlError(f"cannot serialize string containing double-quote: {value!r}")
        return f'"{value}"'
    return value


def dumps(data: dict[str, Any]) -> str:
    """Serialize a dict (flat or one-level-nested) back to YAML.

    The output is intentionally simple and stable so diffs stay readable.
    """
    lines: list[str] = []
    for key, value in data.items():
        if isinstance(value, dict):
            lines.append(f"{key}:")
            for sub_key, sub_value in value.items():
                if isinstance(sub_value, dict):
                    lines.append(f"  {sub_key}:")
                    for leaf_key, leaf_value in sub_value.items():
                        if not isinstance(leaf_value, str):
                            raise YamlError(
                                f"leaf value at {key}.{sub_key}.{leaf_key} must be a string"
                            )
                        lines.append(f"    {leaf_key}: {_quote_if_needed(leaf_value)}")
                elif isinstance(sub_value, str):
                    lines.append(f"  {sub_key}: {_quote_if_needed(sub_value)}")
                else:
                    raise YamlError(
                        f"unsupported value type at {key}.{sub_key}: {type(sub_value).__name__}"
                    )
        elif isinstance(value, str):
            lines.append(f"{key}: {_quote_if_needed(value)}")
        else:
            raise YamlError(
                f"unsupported value type at {key}: {type(value).__name__}"
            )
    return "\n".join(lines) + "\n"


def dump(data: dict[str, Any], path: Path) -> None:
    """Serialize and write to a file (UTF-8, trailing newline)."""
    path.write_text(dumps(data), encoding="utf-8")
