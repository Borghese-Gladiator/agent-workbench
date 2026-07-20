"""Unit tests for lib.metadata.

Run from the workbench root:
    PYTHONPATH=. python3 -m unittest discover tests
"""

import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lib import _yaml
from lib.metadata import (
    INVESTIGATION_ONLY_STATUSES,
    Metadata,
    MetadataError,
    VALID_RUN_TYPES,
    VALID_STATUSES,
    load,
    new_metadata,
    save,
    transition,
    validate_beads_task_id,
    validate_run_type,
)


def _feature_md(**overrides):
    base = dict(
        run_id="2026-05-06-foo-001",
        feature_slug="foo",
        repo_key="frontend",
        repo_path="/tmp/frontend",
        github_repo="org/frontend",
        default_branch="main",
    )
    base.update(overrides)
    return new_metadata(**base)


class TestRunTypeValidation(unittest.TestCase):
    def test_valid_run_types_accepted(self):
        for rt in VALID_RUN_TYPES:
            validate_run_type(rt)  # should not raise

    def test_invalid_run_type_rejected(self):
        with self.assertRaises(MetadataError):
            validate_run_type("garbage")
        with self.assertRaises(MetadataError):
            validate_run_type("FEATURE")  # case-sensitive


class TestBeadsTaskIdValidation(unittest.TestCase):
    def test_accepted(self):
        for good in ["bd-42", "bd-a3f8e9", "wb-hc1", "wb-hc1.1", "smoke-7ex.2.1"]:
            validate_beads_task_id(good)

    def test_rejected(self):
        for bad in ["", "42", "bd-", "Bd-1", "bd 1", "bd-1!", "BD-1", "1bd-x"]:
            with self.assertRaises(MetadataError, msg=f"should reject {bad!r}"):
                validate_beads_task_id(bad)


class TestMetadataRoundTrip(unittest.TestCase):
    def test_feature_round_trip(self):
        with tempfile.TemporaryDirectory() as td:
            run_dir = Path(td)
            md = _feature_md()
            self.assertEqual(md.run_type, "feature")
            self.assertEqual(md.parent_run_id, "")
            self.assertEqual(md.beads_task_id, "")
            save(run_dir, md, touch_updated_at=False)
            loaded = load(run_dir)
            self.assertEqual(loaded.run_id, md.run_id)
            self.assertEqual(loaded.run_type, "feature")
            self.assertEqual(loaded.parent_run_id, "")

    def test_investigation_round_trip(self):
        with tempfile.TemporaryDirectory() as td:
            run_dir = Path(td)
            md = _feature_md(
                run_type="investigation",
                linear_ticket="https://linear.app/klaviyo/issue/CORE-577/x",
            )
            save(run_dir, md, touch_updated_at=False)
            loaded = load(run_dir)
            self.assertEqual(loaded.run_type, "investigation")
            self.assertEqual(
                loaded.linear_ticket,
                "https://linear.app/klaviyo/issue/CORE-577/x",
            )

    def test_bare_linear_key_round_trip(self):
        with tempfile.TemporaryDirectory() as td:
            run_dir = Path(td)
            md = _feature_md(linear_ticket="CORE-577")
            save(run_dir, md, touch_updated_at=False)
            loaded = load(run_dir)
            self.assertEqual(loaded.linear_ticket, "CORE-577")

    def test_beads_task_id_round_trip(self):
        with tempfile.TemporaryDirectory() as td:
            run_dir = Path(td)
            md = _feature_md()
            md = replace(md, beads_task_id="wb-hc1")
            save(run_dir, md, touch_updated_at=False)
            loaded = load(run_dir)
            self.assertEqual(loaded.beads_task_id, "wb-hc1")

    def test_load_legacy_metadata_without_new_fields(self):
        # A pre-investigation metadata.yaml has no parent_run_id / linear_ticket /
        # run_type / beads_task_id keys at all. Load should fill defaults.
        legacy = {
            "run_id": "2026-04-01-legacy-001",
            "feature_slug": "legacy",
            "repo_key": "frontend",
            "repo_path": "/tmp/x",
            "github_repo": "org/x",
            "default_branch": "main",
            "branch_name": "ai/2026-04-01-legacy-001",
            "worktree_path": "",
            "status": "draft",
            "pr_url": "",
            "pr_number": "",
            "remote_name": "origin",
            "github_cli_required": "false",
            "created_at": "2026-04-01T00:00:00Z",
            "updated_at": "2026-04-01T00:00:00Z",
        }
        with tempfile.TemporaryDirectory() as td:
            run_dir = Path(td)
            (run_dir / "metadata.yaml").write_text(_yaml.dumps(legacy))
            md = load(run_dir)
            self.assertEqual(md.parent_run_id, "")
            self.assertEqual(md.linear_ticket, "")
            self.assertEqual(md.run_type, "feature")
            self.assertEqual(md.beads_task_id, "")


class TestTransitionGating(unittest.TestCase):
    def test_investigation_can_enter_investigating(self):
        md = _feature_md(run_type="investigation")
        m1 = transition(md, "planned")
        m2 = transition(m1, "investigating")
        self.assertEqual(m2.status, "investigating")
        m3 = transition(m2, "investigated")
        self.assertEqual(m3.status, "investigated")

    def test_feature_cannot_enter_investigating(self):
        md = _feature_md()
        with self.assertRaises(MetadataError):
            transition(md, "investigating")
        with self.assertRaises(MetadataError):
            transition(md, "investigated")

    def test_terminal_status_protection(self):
        md = _feature_md()
        m1 = transition(md, "planned")
        m2 = transition(m1, "in_progress")
        m3 = transition(m2, "qa")
        m4 = transition(m3, "merged")
        with self.assertRaises(MetadataError):
            transition(m4, "in_progress")


class TestSaveValidation(unittest.TestCase):
    def test_save_rejects_investigation_status_on_feature_run(self):
        with tempfile.TemporaryDirectory() as td:
            run_dir = Path(td)
            md = _feature_md()
            # Bypass transition() guard by direct field manipulation; save() must
            # still catch the invariant at write time.
            tampered = replace(md, status="investigating")
            with self.assertRaises(MetadataError):
                save(run_dir, tampered)


class TestStatusInvariants(unittest.TestCase):
    def test_investigation_states_in_valid_statuses(self):
        for s in INVESTIGATION_ONLY_STATUSES:
            self.assertIn(s, VALID_STATUSES)


if __name__ == "__main__":
    unittest.main()
