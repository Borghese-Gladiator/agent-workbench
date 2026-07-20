"""Unit tests for lib/followups.py (TODO §1f)."""
from __future__ import annotations

import unittest

from tests._helpers import make_tmp_workbench, cleanup  # noqa: F401

from lib import followups


ENTRY = """\
---
title: {title}
motivation: keep it short
suggested_scope: small chunk
category: {category}
---

Optional prose.
"""


def _doc(*entries: str) -> str:
    return "\n".join(entries)


class TestExtract(unittest.TestCase):
    def test_no_blocks_returns_empty(self):
        self.assertEqual(followups.extract_entries("# Follow-ups\n\nNo content.\n"), [])

    def test_one_entry(self):
        out = followups.extract_entries(ENTRY.format(title="a", category="tech_debt"))
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["title"], "a")
        self.assertEqual(out[0]["category"], "tech_debt")

    def test_multiple_entries(self):
        text = _doc(
            ENTRY.format(title="alpha", category="tech_debt"),
            ENTRY.format(title="beta", category="docs"),
            ENTRY.format(title="gamma", category="bug_risk"),
        )
        out = followups.extract_entries(text)
        self.assertEqual([e["title"] for e in out], ["alpha", "beta", "gamma"])

    def test_categories_helper(self):
        text = _doc(
            ENTRY.format(title="a", category="tech_debt"),
            ENTRY.format(title="b", category="docs"),
            ENTRY.format(title="c", category="tech_debt"),
        )
        cats = followups.categories(followups.extract_entries(text))
        self.assertEqual(cats, ["docs", "tech_debt"])


class TestValidate(unittest.TestCase):
    def test_rejects_bad_inputs(self):
        # Each case is (label, text, expected_error_substring). Folded into
        # one test because the call shape is identical: validate(text) → errs
        # where errs[0] contains the substring (or, for sentinel-mix, any
        # error contains it).
        bad = [
            ("empty file → no_followups required", "", "no_followups"),
            (
                "missing required keys",
                "---\ntitle: missing-others\n---\n",
                "missing required keys",
            ),
            (
                "invalid category",
                ENTRY.format(title="bad", category="not_a_real_category"),
                "invalid category",
            ),
            (
                "duplicate titles",
                _doc(
                    ENTRY.format(title="dup", category="docs"),
                    ENTRY.format(title="dup", category="bug_risk"),
                ),
                "duplicate",
            ),
            (
                "sentinel mixed with real entries",
                _doc(
                    ENTRY.format(title="real", category="tech_debt"),
                    ENTRY.format(title="nothing", category="no_followups"),
                ),
                "sentinel",
            ),
        ]
        for label, text, substr in bad:
            errs = followups.validate(text)
            self.assertTrue(
                any(substr in e for e in errs),
                msg=f"{label}: expected substring {substr!r} in {errs!r}",
            )

    def test_accepts_valid_inputs(self):
        # All cases share the assertion: validate(text) == [].
        cats = ["tech_debt", "scope_extension", "bug_risk", "refactor", "docs"]
        accepted = [
            ("no_followups sentinel alone",
             ENTRY.format(title="nothing to surface", category="no_followups")),
            ("all five real categories",
             _doc(*(ENTRY.format(title=f"t{i}", category=c) for i, c in enumerate(cats)))),
            ("deferred_from_bounce category",
             ENTRY.format(title="leftover", category="deferred_from_bounce")),
        ]
        for label, text in accepted:
            self.assertEqual(followups.validate(text), [], msg=label)


if __name__ == "__main__":
    unittest.main()
