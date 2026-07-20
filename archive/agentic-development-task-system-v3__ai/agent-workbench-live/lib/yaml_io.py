"""Stdlib YAML reader/writer for the flat subset Agent Workbench uses.

Supported:
- Block-style mappings: `key: value`, nested by indentation (spaces only).
- Block-style sequences: `- item` lines.
- Scalars: int, float, bool (`true`/`false`/`True`/`False`), null (`null`/`~`/empty),
  bare strings, single-quoted strings, double-quoted strings.
- Comments (`#`) to end of line. Inline comments are allowed on scalar values.
- Lists of scalars or lists of maps.
- Mixed nesting of maps and lists.

Not supported (rejected with YamlSubsetError):
- Flow style (`{a: 1, b: 2}`, `[1, 2, 3]`).
- Anchors and aliases (`&foo`, `*foo`).
- Multi-document streams (`---` separator).
- Multiline scalars (`|`, `>`).
- Tabs for indentation.
- Tag directives (`!!str` etc).

The writer emits canonical block form with two-space indent.
"""
from __future__ import annotations

import re
from typing import Any


class YamlSubsetError(ValueError):
    """Raised when input or output uses YAML features outside our subset."""


# ---------- writer ----------

_BARE_SCALAR_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_./:+\-]*$")
_RESERVED_BARE = {"true", "false", "null", "yes", "no", "on", "off", "True", "False", "Null", "None", "~"}


def _is_int(s: str) -> bool:
    try:
        int(s)
        return True
    except ValueError:
        return False


def _is_float(s: str) -> bool:
    try:
        float(s)
        return True
    except ValueError:
        return False


def _emit_scalar(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    if not isinstance(v, str):
        raise YamlSubsetError(f"cannot emit scalar of type {type(v).__name__}: {v!r}")
    if v == "":
        return '""'
    needs_quote = (
        v in _RESERVED_BARE
        or _is_int(v)
        or _is_float(v)
        or not _BARE_SCALAR_RE.match(v)
        or v.startswith("-")
        or v.startswith("?")
        or v.startswith(":")
        or v.startswith("@")
        or "  " in v
        or v != v.strip()
    )
    if not needs_quote:
        return v
    if '"' in v and "'" not in v:
        return "'" + v + "'"
    escaped = v.replace("\\", "\\\\").replace('"', '\\"')
    return '"' + escaped + '"'


def _dump(value: Any, indent: int, lines: list[str]) -> None:
    pad = " " * indent
    if isinstance(value, dict):
        if not value:
            lines.append(pad + "{}")
            return
        for k, v in value.items():
            if not isinstance(k, str):
                raise YamlSubsetError(f"map keys must be strings, got {type(k).__name__}")
            key = _emit_scalar(k)
            if isinstance(v, (dict, list)) and v:
                lines.append(f"{pad}{key}:")
                _dump(v, indent + 2, lines)
            elif isinstance(v, dict) and not v:
                lines.append(f"{pad}{key}: {{}}")
            elif isinstance(v, list) and not v:
                lines.append(f"{pad}{key}: []")
            else:
                lines.append(f"{pad}{key}: {_emit_scalar(v)}")
    elif isinstance(value, list):
        if not value:
            lines.append(pad + "[]")
            return
        for item in value:
            if isinstance(item, dict) and item:
                first = True
                for k, v in item.items():
                    key = _emit_scalar(k)
                    prefix = f"{pad}- " if first else f"{pad}  "
                    if isinstance(v, (dict, list)) and v:
                        lines.append(f"{prefix}{key}:")
                        _dump(v, indent + 4, lines)
                    else:
                        lines.append(f"{prefix}{key}: {_emit_scalar(v)}")
                    first = False
            elif isinstance(item, list) and item:
                lines.append(f"{pad}-")
                _dump(item, indent + 2, lines)
            else:
                lines.append(f"{pad}- {_emit_scalar(item)}")
    else:
        lines.append(f"{pad}{_emit_scalar(value)}")


def dumps(data: Any) -> str:
    """Serialize a Python dict/list/scalar to YAML in our subset."""
    if data is None:
        return "null\n"
    if not isinstance(data, (dict, list)):
        return _emit_scalar(data) + "\n"
    lines: list[str] = []
    _dump(data, 0, lines)
    return "\n".join(lines) + "\n"


# ---------- reader ----------

_QUOTED_DQ = re.compile(r'^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$')
_QUOTED_SQ = re.compile(r"^'([^']*)'\s*(?:#.*)?$")


def _strip_comment_outside_quotes(s: str) -> str:
    out = []
    i = 0
    in_sq = False
    in_dq = False
    while i < len(s):
        c = s[i]
        if in_sq:
            out.append(c)
            if c == "'":
                in_sq = False
        elif in_dq:
            out.append(c)
            if c == "\\" and i + 1 < len(s):
                out.append(s[i + 1])
                i += 2
                continue
            if c == '"':
                in_dq = False
        else:
            if c == "#":
                break
            if c == "'":
                in_sq = True
            elif c == '"':
                in_dq = True
            out.append(c)
        i += 1
    return "".join(out)


def _parse_scalar(raw: str) -> Any:
    s = raw.strip()
    if s == "" or s == "null" or s == "~" or s == "Null" or s == "None":
        return None
    if s in ("true", "True"):
        return True
    if s in ("false", "False"):
        return False
    m = _QUOTED_DQ.match(raw.strip())
    if m:
        return m.group(1).encode().decode("unicode_escape")
    m = _QUOTED_SQ.match(raw.strip())
    if m:
        return m.group(1)
    # int?
    try:
        if re.fullmatch(r"-?\d+", s):
            return int(s)
    except ValueError:
        pass
    # float?
    try:
        if re.fullmatch(r"-?\d+\.\d+([eE][+-]?\d+)?", s):
            return float(s)
    except ValueError:
        pass
    return s


def _indent_of(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


class _Tokenizer:
    """Holds the raw lines and a cursor; lets the parser peek/consume."""

    def __init__(self, text: str) -> None:
        self.lines: list[tuple[int, int, str]] = []  # (lineno, indent, content)
        for n, raw in enumerate(text.splitlines(), start=1):
            if "\t" in (raw.rstrip("\n")):
                # tabs not allowed in significant indentation
                if raw.lstrip(" \t").startswith("#"):
                    continue
                if "\t" in raw[: len(raw) - len(raw.lstrip())]:
                    raise YamlSubsetError(f"line {n}: tab in indentation not allowed")
            stripped = raw.rstrip()
            # detect multi-doc / directives
            if stripped == "---" or stripped == "..." or stripped.startswith("%"):
                raise YamlSubsetError(f"line {n}: multi-doc / directives not supported")
            content = _strip_comment_outside_quotes(stripped)
            if content.strip() == "":
                continue
            indent = _indent_of(content)
            self.lines.append((n, indent, content))
        self.i = 0

    def peek(self) -> tuple[int, int, str] | None:
        if self.i >= len(self.lines):
            return None
        return self.lines[self.i]

    def pop(self) -> tuple[int, int, str]:
        tok = self.lines[self.i]
        self.i += 1
        return tok


def _check_no_flow(content: str, lineno: int) -> None:
    # Be permissive: only reject when '{' or '[' appears outside quotes at the value position.
    # The conservative check below catches the common cases without false positives on legit punctuation.
    s = _strip_comment_outside_quotes(content)
    # Pull the value side after ': ' if present.
    if ": " in s:
        _, _, rest = s.partition(": ")
    elif s.endswith(":"):
        rest = ""
    else:
        rest = s.lstrip("- ").strip()
    rest = rest.strip()
    if rest.startswith("{") or rest.startswith("["):
        raise YamlSubsetError(f"line {lineno}: flow style not supported")


def _parse_block(tok: _Tokenizer, indent: int) -> Any:
    """Parse a block starting at the given indent."""
    peek = tok.peek()
    if peek is None:
        return None
    _, ind, content = peek
    if ind < indent:
        return None
    stripped = content.lstrip(" ")
    if stripped.startswith("- "):
        return _parse_sequence(tok, indent)
    if stripped == "-":
        return _parse_sequence(tok, indent)
    return _parse_mapping(tok, indent)


def _parse_mapping(tok: _Tokenizer, indent: int) -> dict:
    out: dict = {}
    while True:
        peek = tok.peek()
        if peek is None:
            return out
        lineno, ind, content = peek
        if ind < indent:
            return out
        if ind > indent:
            raise YamlSubsetError(f"line {lineno}: unexpected indent in mapping")
        _check_no_flow(content, lineno)
        stripped = content.lstrip(" ")
        if stripped.startswith("- "):
            raise YamlSubsetError(f"line {lineno}: sequence item where mapping expected")
        if ":" not in stripped:
            raise YamlSubsetError(f"line {lineno}: expected mapping `key: value`")
        # Find the first ':' outside quotes.
        key_end = _find_key_separator(stripped, lineno)
        key_raw = stripped[:key_end].strip()
        rest = stripped[key_end + 1 :].strip()
        key = _parse_scalar(key_raw)
        if not isinstance(key, str):
            raise YamlSubsetError(f"line {lineno}: mapping key must be a string, got {key!r}")
        tok.pop()  # consume this line
        if rest == "":
            child = _parse_block(tok, indent + 2)
            out[key] = child if child is not None else None
        else:
            out[key] = _parse_scalar(rest)


def _find_key_separator(s: str, lineno: int) -> int:
    in_sq = False
    in_dq = False
    for i, c in enumerate(s):
        if in_sq:
            if c == "'":
                in_sq = False
        elif in_dq:
            if c == "\\":
                continue
            if c == '"':
                in_dq = False
        else:
            if c == "'":
                in_sq = True
            elif c == '"':
                in_dq = True
            elif c == ":":
                return i
    raise YamlSubsetError(f"line {lineno}: no key separator found")


def _parse_sequence(tok: _Tokenizer, indent: int) -> list:
    out: list = []
    while True:
        peek = tok.peek()
        if peek is None:
            return out
        lineno, ind, content = peek
        if ind < indent:
            return out
        if ind > indent:
            raise YamlSubsetError(f"line {lineno}: unexpected indent in sequence")
        stripped = content.lstrip(" ")
        if not stripped.startswith("-"):
            return out
        _check_no_flow(content, lineno)
        if stripped == "-":
            tok.pop()
            child = _parse_block(tok, indent + 2)
            out.append(child)
            continue
        if not stripped.startswith("- "):
            raise YamlSubsetError(f"line {lineno}: malformed sequence item")
        after_dash = stripped[2:]
        # is it a scalar, or a mapping starting on this line?
        if ":" in after_dash and _looks_like_mapping_start(after_dash, lineno):
            # Inline first key of a mapping item, e.g. `- key: value`
            # The mapping continues with subsequent lines indented to `indent + 2`.
            tok.pop()
            # Reconstruct a virtual mapping at indent+2.
            virtual_key_end = _find_key_separator(after_dash, lineno)
            key_raw = after_dash[:virtual_key_end].strip()
            rest = after_dash[virtual_key_end + 1 :].strip()
            key = _parse_scalar(key_raw)
            if not isinstance(key, str):
                raise YamlSubsetError(f"line {lineno}: mapping key must be a string, got {key!r}")
            item: dict = {}
            if rest == "":
                child = _parse_block(tok, indent + 4)
                item[key] = child if child is not None else None
            else:
                item[key] = _parse_scalar(rest)
            # absorb additional mapping entries at indent + 2
            while True:
                p = tok.peek()
                if p is None:
                    break
                ln, i2, c2 = p
                if i2 != indent + 2:
                    break
                s2 = c2.lstrip(" ")
                if s2.startswith("- "):
                    break
                if ":" not in s2:
                    raise YamlSubsetError(f"line {ln}: expected continued mapping entry")
                _check_no_flow(c2, ln)
                ke = _find_key_separator(s2, ln)
                k_raw = s2[:ke].strip()
                r2 = s2[ke + 1 :].strip()
                k = _parse_scalar(k_raw)
                if not isinstance(k, str):
                    raise YamlSubsetError(f"line {ln}: mapping key must be a string")
                tok.pop()
                if r2 == "":
                    child = _parse_block(tok, indent + 4)
                    item[k] = child if child is not None else None
                else:
                    item[k] = _parse_scalar(r2)
            out.append(item)
        else:
            tok.pop()
            out.append(_parse_scalar(after_dash))


def _looks_like_mapping_start(s: str, lineno: int) -> bool:
    # heuristic: there's a `:` outside quotes, before any space-then-`#`
    try:
        _find_key_separator(s, lineno)
        return True
    except YamlSubsetError:
        return False


def loads(text: str) -> Any:
    """Parse YAML text in our subset to a Python object."""
    tok = _Tokenizer(text)
    if tok.peek() is None:
        return None
    return _parse_block(tok, 0)
