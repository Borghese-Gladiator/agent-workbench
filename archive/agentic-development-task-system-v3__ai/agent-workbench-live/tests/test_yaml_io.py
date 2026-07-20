"""Tests for lib/yaml_io."""
from __future__ import annotations

import unittest

from tests._helpers import reset_caches  # noqa: F401
from lib import yaml_io


class TestYamlIO(unittest.TestCase):
    def test_scalars(self):
        cases = {
            "true": True,
            "false": False,
            "null": None,
            "~": None,
            "42": 42,
            "-1": -1,
            "3.14": 3.14,
            '"hello"': "hello",
            "'world'": "world",
            "bare-string": "bare-string",
        }
        for text, expected in cases.items():
            self.assertEqual(yaml_io.loads(f"k: {text}"), {"k": expected}, msg=text)

    def test_nested_map(self):
        text = """
a:
  b:
    c: 1
    d: hello
"""
        self.assertEqual(yaml_io.loads(text), {"a": {"b": {"c": 1, "d": "hello"}}})

    def test_list_of_scalars(self):
        text = """
items:
  - a
  - b
  - 3
"""
        self.assertEqual(yaml_io.loads(text), {"items": ["a", "b", 3]})

    def test_list_of_maps(self):
        text = """
transitions:
  - from: draft
    to: shaping
    evidence:
      required:
        - raw_idea_path
  - from: shaping
    to: planning
    evidence:
      required:
        - brief_path
"""
        data = yaml_io.loads(text)
        self.assertEqual(len(data["transitions"]), 2)
        self.assertEqual(data["transitions"][0]["from"], "draft")
        self.assertEqual(data["transitions"][0]["evidence"]["required"], ["raw_idea_path"])

    def test_comments_stripped(self):
        text = """
a: 1  # inline comment
# whole-line comment
b: 2
"""
        self.assertEqual(yaml_io.loads(text), {"a": 1, "b": 2})

    def test_rejects_unsupported_yaml(self):
        # Every case is "loads(input) → YamlSubsetError". Folded into one test
        # because the shape is identical; the label distinguishes the
        # rejection branch when one regresses.
        bad_inputs = [
            ("flow-style mapping", "a: {b: 1}"),
            ("flow-style sequence", "a: [1, 2]"),
            ("multi-document stream", "---\na: 1\n---\nb: 2\n"),
            ("tab indentation", "a:\n\tb: 1\n"),
        ]
        for label, text in bad_inputs:
            with self.assertRaises(yaml_io.YamlSubsetError, msg=label):
                yaml_io.loads(text)

    def test_round_trip_template_shape(self):
        data = {
            "schema_version": 1,
            "run_id": "2026-05-18-test",
            "status": "draft",
            "target": {
                "repo": {"mode": "existing", "path": "/x", "name": "x", "base_ref": "HEAD", "fingerprint": None},
                "worktree": {"name": "x", "path": None, "branch_name": "agent/x", "created": False, "base_ref": "HEAD"},
            },
            "scope": {"kind": "implementation", "summary": "test"},
            "artifacts": {"raw_idea": "raw-idea.md", "answers": None},
            "validation": {"required": True, "tests_passed": None, "known_issues_count": 0},
            "completion": {"accepted_by": None, "completion_ref": None},
            "created_at": "2026-05-18T10:00:00-04:00",
            "updated_at": "2026-05-18T10:00:00-04:00",
        }
        out = yaml_io.dumps(data)
        back = yaml_io.loads(out)
        self.assertEqual(back, data)


if __name__ == "__main__":
    unittest.main()
