"""Unit tests for lib.wbs."""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lib.wbs import WbsError, parse


def _write(p: Path, text: str) -> None:
    p.write_text(text, encoding="utf-8")


GOOD = """# Decisions

## DR-001 — pick framework
**Decision:** keep it.

## WBS — children to spawn

```yaml
children:
  - slug: "dashboard-shell"
    repo_key: "frontend"
    summary: "Shell route + nav entry"
  - slug: "channel-data-api"
    repo_key: "backend"
    summary: "GET /channels"
```

Notes after.
"""


class TestWbsParse(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dec = Path(self._tmp.name) / "decisions.md"

    def tearDown(self):
        self._tmp.cleanup()

    def test_happy_path(self):
        _write(self.dec, GOOD)
        items = parse(self.dec)
        self.assertEqual(len(items), 2)
        self.assertEqual(items[0].slug, "dashboard-shell")
        self.assertEqual(items[1].repo_key, "backend")
        self.assertEqual(items[1].summary, "GET /channels")

    def test_no_heading(self):
        _write(self.dec, "# x\n\nNothing.\n")
        with self.assertRaises(WbsError):
            parse(self.dec)

    def test_two_headings(self):
        _write(
            self.dec,
            "# x\n\n## WBS first\n\n```yaml\nchildren:\n  - slug: a\n    repo_key: frontend\n```\n\n## WBS second\n\n```yaml\nchildren:\n  - slug: b\n    repo_key: frontend\n```\n",
        )
        with self.assertRaises(WbsError):
            parse(self.dec)

    def test_missing_slug(self):
        _write(
            self.dec,
            "# x\n\n## WBS — children\n\n```yaml\nchildren:\n  - repo_key: \"frontend\"\n    summary: \"no slug\"\n```\n",
        )
        with self.assertRaises(WbsError) as ctx:
            parse(self.dec)
        self.assertIn("slug", str(ctx.exception).lower())

    def test_missing_repo_key(self):
        _write(
            self.dec,
            "# x\n\n## WBS — children\n\n```yaml\nchildren:\n  - slug: \"a\"\n```\n",
        )
        with self.assertRaises(WbsError):
            parse(self.dec)

    def test_bad_slug(self):
        _write(
            self.dec,
            "# x\n\n## WBS — children\n\n```yaml\nchildren:\n  - slug: \"Bad-Slug\"\n    repo_key: \"frontend\"\n```\n",
        )
        with self.assertRaises(WbsError) as ctx:
            parse(self.dec)
        self.assertIn("kebab-case", str(ctx.exception))

    def test_no_fence(self):
        _write(
            self.dec,
            "# x\n\n## WBS — children\n\n(no fence)\n",
        )
        with self.assertRaises(WbsError):
            parse(self.dec)

    def test_unclosed_fence(self):
        _write(
            self.dec,
            "# x\n\n## WBS — children\n\n```yaml\nchildren:\n  - slug: a\n    repo_key: frontend\n",
        )
        with self.assertRaises(WbsError):
            parse(self.dec)

    def test_html_comment_scaffold_is_ignored(self):
        # Template includes a <!-- ... ## WBS ... --> scaffold; real WBS comes
        # later. We must find the live one, not the commented-out one.
        _write(
            self.dec,
            (
                "# x\n\n"
                "<!--\n"
                "## WBS — children to spawn\n\n"
                "```yaml\n"
                "children:\n"
                "  - slug: \"\"\n"
                "    repo_key: \"\"\n"
                "```\n"
                "-->\n\n"
                "## WBS — children to spawn\n\n"
                "```yaml\n"
                "children:\n"
                "  - slug: real\n"
                "    repo_key: frontend\n"
                "```\n"
            ),
        )
        items = parse(self.dec)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0].slug, "real")


if __name__ == "__main__":
    unittest.main()
