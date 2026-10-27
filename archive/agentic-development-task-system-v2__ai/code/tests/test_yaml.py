"""Unit tests for lib._yaml — focused on the new list-of-mappings support
and regression coverage of the existing flat / one-level-nested shapes.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lib._yaml import YamlError, dumps, loads


class TestFlatMapping(unittest.TestCase):
    def test_basic_flat(self):
        out = loads('run_id: "abc"\nstatus: draft\n')
        self.assertEqual(out, {"run_id": "abc", "status": "draft"})

    def test_empty_quoted_value(self):
        out = loads('worktree_path: ""\n')
        self.assertEqual(out, {"worktree_path": ""})


class TestOneLevelNested(unittest.TestCase):
    def test_repos_yaml_shape(self):
        text = (
            "repos:\n"
            "  frontend:\n"
            "    path: /abs/frontend\n"
            "    github: org/frontend\n"
            "    default_branch: main\n"
            "  backend:\n"
            "    path: /abs/backend\n"
            "    github: org/backend\n"
            "    default_branch: main\n"
        )
        out = loads(text)
        self.assertEqual(out["repos"]["frontend"]["github"], "org/frontend")
        self.assertEqual(out["repos"]["backend"]["default_branch"], "main")


class TestListOfMappings(unittest.TestCase):
    def test_wbs_shape(self):
        text = (
            "children:\n"
            '  - slug: "a"\n'
            '    repo_key: "frontend"\n'
            '    summary: "thing one"\n'
            '  - slug: "b"\n'
            '    repo_key: "backend"\n'
        )
        out = loads(text)
        self.assertIsInstance(out["children"], list)
        self.assertEqual(len(out["children"]), 2)
        self.assertEqual(out["children"][0]["slug"], "a")
        self.assertEqual(out["children"][1]["repo_key"], "backend")

    def test_list_with_comments_and_blanks(self):
        text = (
            "children:\n"
            "  # first item\n"
            "  - slug: a\n"
            "    repo_key: frontend\n"
            "\n"
            "  # second\n"
            "  - slug: b\n"
            "    repo_key: backend\n"
        )
        out = loads(text)
        self.assertEqual(len(out["children"]), 2)

    def test_mixing_list_and_mapping_rejected(self):
        text = (
            "children:\n"
            "  - slug: a\n"
            "    repo_key: frontend\n"
            "  bogus: nope\n"
        )
        with self.assertRaises(YamlError):
            loads(text)

    def test_scalar_list_item_rejected(self):
        text = "children:\n  - bare-scalar\n"
        with self.assertRaises(YamlError):
            loads(text)

    def test_orphan_4_indent_rejected(self):
        text = "children:\n    foo: bar\n"
        with self.assertRaises(YamlError):
            loads(text)

    def test_empty_parent_treated_as_empty_mapping(self):
        out = loads("children:\n")
        self.assertEqual(out, {"children": {}})


class TestDumperBackCompat(unittest.TestCase):
    def test_dumps_flat_round_trip(self):
        data = {"run_id": "abc", "status": "draft", "worktree_path": ""}
        out = loads(dumps(data))
        self.assertEqual(out, data)

    def test_dumps_does_not_emit_lists(self):
        # The dumper is read-only for lists; it must reject list values cleanly.
        with self.assertRaises(YamlError):
            dumps({"children": [{"slug": "a"}]})


if __name__ == "__main__":
    unittest.main()
