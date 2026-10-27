"""Tests for lib/metadata."""
from __future__ import annotations

import io
import pathlib
import sys
import unittest
from contextlib import redirect_stderr

from tests._helpers import make_tmp_workbench, cleanup, reset_caches
from lib import config, metadata, yaml_io


class TestMetadata(unittest.TestCase):
    def setUp(self):
        self.tmp = make_tmp_workbench()
        reset_caches()
        self.cfg = config.load(self.tmp)

    def tearDown(self):
        cleanup(self.tmp)

    def _create_run(self, run_id="2026-05-18-test"):
        return metadata.create(
            self.cfg, run_id,
            repo_mode="existing",
            repo_path="/tmp/x",
            repo_name="x",
            base_ref="HEAD",
            worktree_name="x",
            branch_name="agent/x",
            raw_idea_path="raw-idea.md",
        )

    def test_create_and_load(self):
        meta = self._create_run()
        self.assertEqual(meta["status"], "draft")
        loaded = metadata.load(self.cfg, "2026-05-18-test")
        self.assertEqual(loaded["run_id"], "2026-05-18-test")
        self.assertEqual(loaded["target"]["repo"]["path"], "/tmp/x")

    def test_metadata_error_cases(self):
        """create() refuses a second call for the same run_id; load()
        rejects a run_id that doesn't exist. Different call shapes but the
        same MetadataError contract, folded into one test."""
        self._create_run()
        with self.assertRaises(metadata.MetadataError, msg="duplicate create"):
            self._create_run()
        with self.assertRaises(metadata.MetadataError, msg="load missing run"):
            metadata.load(self.cfg, "no-such-run")

    def test_set_status_valid(self):
        self._create_run()
        metadata.set_status(self.cfg, "2026-05-18-test", "shaping")
        meta = metadata.load(self.cfg, "2026-05-18-test")
        self.assertEqual(meta["status"], "shaping")

    def test_set_status_invalid(self):
        self._create_run()
        with self.assertRaises(metadata.MetadataError):
            metadata.set_status(self.cfg, "2026-05-18-test", "bogus")

    def test_round_trip_preserves_artifacts(self):
        self._create_run()
        def _m(d):
            d["artifacts"]["brief"] = "brief.md"
        metadata.update(self.cfg, "2026-05-18-test", _m)
        meta = metadata.load(self.cfg, "2026-05-18-test")
        self.assertEqual(meta["artifacts"]["brief"], "brief.md")
        self.assertIsNone(meta["artifacts"]["answers"])

    def test_list_runs(self):
        self._create_run("2026-05-18-a")
        self._create_run("2026-05-18-b")
        runs = metadata.list_runs(self.cfg)
        self.assertEqual(runs, ["2026-05-18-a", "2026-05-18-b"])

    def test_create_includes_build_block(self):
        """TODO §1e: new runs have a build: telemetry block."""
        meta = self._create_run("2026-05-20-build")
        self.assertIn("build", meta)
        self.assertIsNone(meta["build"]["iterations"])
        self.assertIsNone(meta["build"]["exit_reason"])
        self.assertEqual(meta["build"]["max_iterations"], 5)

    def test_load_without_build_block_backcompat(self):
        """A flat-layout run.yaml missing the build: key must still load
        (TODO §1e back-compat for pre-renovate runs)."""
        rd = self.cfg.runs_path / "legacy"
        rd.mkdir(parents=True)
        (rd / "metadata.yaml").write_text("""schema_version: 1
run_id: legacy
status: draft
created_at: 2025-12-01T00:00:00
updated_at: 2025-12-01T00:00:00
target:
  repo:
    mode: existing
    path: /tmp/x
    name: x
    base_ref: HEAD
    fingerprint: null
    created_by_run: null
  worktree:
    name: x
    path: null
    branch_name: agent/x
    created: false
    base_ref: HEAD
    initial_commit_sha: null
scope:
  kind: implementation
  summary: ''
artifacts:
  raw_idea: raw-idea.md
  answers: null
  brief: null
  plan: null
  preflight: null
  assumptions: null
  decisions: null
  implementation_summary: null
  diff_summary: null
  review_report: null
  qa_report: null
  audit: null
  handoff: null
validation:
  required: true
  review_completed: false
  qa_completed: false
  qa_recorded: false
  tests_passed: null
  known_issues_count: 0
completion:
  accepted_by: null
  completion_ref: null
  completed_at: null
  abandoned_reason: null
""")
        loaded = metadata.load(self.cfg, "legacy")
        self.assertEqual(loaded["status"], "draft")
        self.assertNotIn("build", loaded)


# ---------- Schema validator: pure unit tests against synthetic dicts ----------


def _make_good_metadata() -> dict:
    """Hand-rolled, schema-clean metadata dict. Tests mutate copies to
    exercise individual failure modes."""
    return {
        "schema_version": 1,
        "run_id": "2026-05-27-test",
        "status": "draft",
        "created_at": "2026-05-27T10:00:00-04:00",
        "updated_at": "2026-05-27T10:00:00-04:00",
        "target": {
            "repo": {
                "mode": "existing",
                "path": "/tmp/x",
                "name": "x",
                "base_ref": "HEAD",
                "base_ref_sha": None,
                "fingerprint": None,
                "created_by_run": None,
            },
            "worktree": {
                "name": "x",
                "path": None,
                "branch_name": "agent/x",
                "created": False,
                "base_ref": "HEAD",
                "initial_commit_sha": None,
            },
        },
        "scope": {"kind": "implementation", "summary": ""},
        "artifacts": {"raw_idea": "raw-idea.md"},
        "validation": {
            "required": True,
            "review_completed": False,
            "qa_completed": False,
            "qa_recorded": False,
            "tests_passed": None,
            "known_issues_count": 0,
        },
        "completion": {
            "accepted_by": None,
            "completion_ref": None,
            "completed_at": None,
            "abandoned_reason": None,
        },
        "build": {"iterations": None, "exit_reason": None, "max_iterations": 5},
    }


class TestValidator(unittest.TestCase):
    """Pure tests for metadata.validate() against the shipped schema."""

    def setUp(self):
        # Loaded once via the lru-cached helper; cheap.
        schema_path = (
            pathlib.Path(__file__).resolve().parent.parent
            / "schemas"
            / "run-metadata.yaml"
        )
        self.schema = metadata._load_schema_from_path(schema_path)

    def _problems(self, data: dict) -> list[metadata.Problem]:
        return metadata.validate(data, schema=self.schema)

    def _codes_at(self, data: dict, path: str) -> list[str]:
        return [p.code for p in self._problems(data) if p.path == path]

    def test_clean_metadata_has_no_problems(self):
        self.assertEqual(self._problems(_make_good_metadata()), [])

    def test_missing_top_level_required_field(self):
        cases = [
            "schema_version", "run_id", "status", "created_at",
            "updated_at", "target", "scope", "artifacts",
            "validation", "completion",
        ]
        for key in cases:
            with self.subTest(missing=key):
                d = _make_good_metadata()
                del d[key]
                codes = self._codes_at(d, key)
                self.assertIn("missing_required", codes)

    def test_missing_nested_required_field(self):
        cases = [
            ("target.repo.mode", ("target", "repo", "mode")),
            ("target.repo.path", ("target", "repo", "path")),
            ("target.repo.name", ("target", "repo", "name")),
            ("target.repo.base_ref", ("target", "repo", "base_ref")),
            ("target.worktree.name", ("target", "worktree", "name")),
            ("target.worktree.branch_name", ("target", "worktree", "branch_name")),
            ("target.worktree.created", ("target", "worktree", "created")),
            ("target.worktree.base_ref", ("target", "worktree", "base_ref")),
            ("validation.required", ("validation", "required")),
            ("validation.known_issues_count", ("validation", "known_issues_count")),
        ]
        for path, parts in cases:
            with self.subTest(missing=path):
                d = _make_good_metadata()
                container = d
                for p in parts[:-1]:
                    container = container[p]
                del container[parts[-1]]
                codes = self._codes_at(d, path)
                self.assertIn("missing_required", codes)

    def test_mistyped_scalar(self):
        # target should be a dict; a string trips wrong_type at 'target'.
        d = _make_good_metadata()
        d["target"] = "not a dict"
        codes = self._codes_at(d, "target")
        self.assertIn("wrong_type", codes)

    def test_mistyped_nested_scalar(self):
        # validation.required is bool; passing an int (not bool) is wrong.
        d = _make_good_metadata()
        d["validation"]["required"] = 1  # int, not bool
        codes = self._codes_at(d, "validation.required")
        self.assertIn("wrong_type", codes)

    def test_enum_violation_on_status(self):
        d = _make_good_metadata()
        d["status"] = "shapeing"  # typo
        codes = self._codes_at(d, "status")
        self.assertIn("enum_violation", codes)

    def test_enum_violation_on_repo_mode(self):
        d = _make_good_metadata()
        d["target"]["repo"]["mode"] = "weird"
        codes = self._codes_at(d, "target.repo.mode")
        self.assertIn("enum_violation", codes)

    def test_unknown_extra_top_level_key_flagged_as_unknown(self):
        d = _make_good_metadata()
        d["favorite_color"] = "blue"
        problems = self._problems(d)
        unknown = [p for p in problems if p.code == "unknown_key"]
        self.assertTrue(any(p.path == "favorite_color" for p in unknown))

    def test_unknown_extra_nested_key_flagged_as_unknown(self):
        d = _make_good_metadata()
        d["target"]["repo"]["nme"] = "typo"
        problems = self._problems(d)
        unknown = [p for p in problems if p.code == "unknown_key"]
        self.assertTrue(
            any(p.path == "target.repo.nme" for p in unknown),
            f"expected unknown_key at target.repo.nme, got {[p.path for p in unknown]}",
        )

    def test_eq_violation_on_schema_version(self):
        d = _make_good_metadata()
        d["schema_version"] = 2
        codes = self._codes_at(d, "schema_version")
        self.assertIn("eq_violation", codes)

    def test_scope_and_artifacts_are_free_form(self):
        # Free-form blocks must still BE dicts, but their contents are not
        # deep-validated. We can stuff anything inside.
        d = _make_good_metadata()
        d["scope"]["nonsense_subkey"] = ["a", "list", "of", "stuff"]
        d["artifacts"]["wholly_invented_field"] = {"nested": "thing"}
        self.assertEqual(self._problems(d), [])

    def test_int_does_not_accept_bool(self):
        # Python bool subclasses int. Schema says known_issues_count is int.
        # If we accidentally accept True, real bugs slip through.
        d = _make_good_metadata()
        d["validation"]["known_issues_count"] = True
        codes = self._codes_at(d, "validation.known_issues_count")
        self.assertIn("wrong_type", codes)


# ---------- Mode behavior (warn vs strict) via load() ----------


class TestValidationMode(unittest.TestCase):
    def setUp(self):
        self.tmp = make_tmp_workbench()
        reset_caches()
        self.cfg = config.load(self.tmp)
        metadata.create(
            self.cfg, "2026-05-27-mode",
            repo_mode="existing",
            repo_path="/tmp/x",
            repo_name="x",
            base_ref="HEAD",
            worktree_name="x",
            branch_name="agent/x",
            raw_idea_path="raw-idea.md",
        )

    def tearDown(self):
        cleanup(self.tmp)

    def _corrupt_with_typo(self) -> pathlib.Path:
        """Add an unknown nested key 'target.repo.nme' and write back. Returns
        the path so we can prove we mutated the right copy."""
        p = self.cfg.runs_path / "2026-05-27-mode" / "metadata.yaml"
        data = yaml_io.loads(p.read_text())
        data["target"]["repo"]["nme"] = "typo"  # unknown key
        p.write_text(yaml_io.dumps(data))
        return p

    def _set_mode(self, mode: str) -> None:
        # Mutate the on-disk config so cfg picks it up after reload.
        cfg_path = self.tmp / "agent-workbench.yaml"
        raw = yaml_io.loads(cfg_path.read_text())
        raw.setdefault("policies", {})["metadata_validation"] = mode
        cfg_path.write_text(yaml_io.dumps(raw))
        self.cfg = config.load(self.tmp)

    def test_warn_mode_silent_on_unknown_key(self):
        # Default policy in shipped agent-workbench.yaml is 'warn'.
        # Unknown keys are tolerated silently under warn (additive backcompat).
        self._corrupt_with_typo()
        buf = io.StringIO()
        with redirect_stderr(buf):
            loaded = metadata.load(self.cfg, "2026-05-27-mode")
        self.assertEqual(loaded["target"]["repo"]["nme"], "typo")
        self.assertEqual(buf.getvalue(), "")

    def test_strict_mode_raises_on_unknown_key(self):
        self._corrupt_with_typo()
        self._set_mode("strict")
        with self.assertRaises(metadata.MetadataError) as ctx:
            metadata.load(self.cfg, "2026-05-27-mode")
        self.assertIn("unknown_key", str(ctx.exception))
        self.assertIn("target.repo.nme", str(ctx.exception))

    def test_warn_mode_emits_stderr_for_real_violations(self):
        # Wrong type is a real violation, not just an unknown key.
        # Warn mode must SHOW IT (to stderr) and still return data.
        p = self.cfg.runs_path / "2026-05-27-mode" / "metadata.yaml"
        data = yaml_io.loads(p.read_text())
        data["validation"]["known_issues_count"] = "not-a-number"
        p.write_text(yaml_io.dumps(data))

        buf = io.StringIO()
        with redirect_stderr(buf):
            loaded = metadata.load(self.cfg, "2026-05-27-mode")
        self.assertEqual(loaded["validation"]["known_issues_count"], "not-a-number")
        stderr = buf.getvalue()
        self.assertIn("validation.known_issues_count", stderr)
        self.assertIn("wrong_type", stderr)
        self.assertIn("run=2026-05-27-mode", stderr)

    def test_strict_mode_raises_on_real_violation(self):
        p = self.cfg.runs_path / "2026-05-27-mode" / "metadata.yaml"
        data = yaml_io.loads(p.read_text())
        data["status"] = "shapeing"
        # set_status enforces enum, so we have to write through yaml directly.
        p.write_text(yaml_io.dumps(data))
        self._set_mode("strict")
        with self.assertRaises(metadata.MetadataError) as ctx:
            metadata.load(self.cfg, "2026-05-27-mode")
        self.assertIn("status", str(ctx.exception))

    def test_unrecognized_mode_falls_back_to_warn(self):
        self._set_mode("yolo")
        # Real violation under fallback-to-warn: should emit to stderr, not raise.
        p = self.cfg.runs_path / "2026-05-27-mode" / "metadata.yaml"
        data = yaml_io.loads(p.read_text())
        data["target"]["repo"]["mode"] = "weird"
        p.write_text(yaml_io.dumps(data))

        buf = io.StringIO()
        with redirect_stderr(buf):
            metadata.load(self.cfg, "2026-05-27-mode")
        stderr = buf.getvalue()
        self.assertIn("metadata_validation='yolo'", stderr)  # fallback note
        self.assertIn("enum_violation", stderr)


# ---------- Duplicate-file integrity check (always-on) ----------


class TestDuplicateMetadataIntegrity(unittest.TestCase):
    def setUp(self):
        self.tmp = make_tmp_workbench()
        reset_caches()
        self.cfg = config.load(self.tmp)
        metadata.create(
            self.cfg, "2026-05-27-dup",
            repo_mode="existing",
            repo_path="/tmp/x",
            repo_name="x",
            base_ref="HEAD",
            worktree_name="x",
            branch_name="agent/x",
            raw_idea_path="raw-idea.md",
        )

    def tearDown(self):
        cleanup(self.tmp)

    def _plant_duplicate(self) -> pathlib.Path:
        rd = self.cfg.runs_path / "2026-05-27-dup"
        nested = rd / "stages" / "1_draft"
        nested.mkdir(parents=True)
        dup = nested / "metadata.yaml"
        dup.write_text((rd / "metadata.yaml").read_text())
        return dup

    def test_duplicate_metadata_hard_fails_warn_mode(self):
        dup = self._plant_duplicate()
        with self.assertRaises(metadata.MetadataError) as ctx:
            metadata.load(self.cfg, "2026-05-27-dup")
        msg = str(ctx.exception)
        self.assertIn("multiple metadata.yaml", msg)
        self.assertIn(str(dup), msg)

    def test_duplicate_metadata_hard_fails_strict_mode(self):
        # Same outcome under strict — duplicates are an integrity error, not
        # a schema violation, so policy mode doesn't change behavior.
        cfg_path = self.tmp / "agent-workbench.yaml"
        raw = yaml_io.loads(cfg_path.read_text())
        raw.setdefault("policies", {})["metadata_validation"] = "strict"
        cfg_path.write_text(yaml_io.dumps(raw))
        self.cfg = config.load(self.tmp)

        self._plant_duplicate()
        with self.assertRaises(metadata.MetadataError) as ctx:
            metadata.load(self.cfg, "2026-05-27-dup")
        self.assertIn("multiple metadata.yaml", str(ctx.exception))


# ---------- Real-data smoke (runs against the repo if it's there) ----------


class TestRealRunsLoadClean(unittest.TestCase):
    """Acceptance criterion #2: existing runs load without warnings.

    Skipped if the master-side runs/ dir isn't reachable (e.g. running this
    test pack out of context).
    """

    REAL_RUNS = pathlib.Path(
        "/Users/timothy.shee/GitHub/new-tech-monorepo/"
        "agentic-development-task-system-v3__ai/agent-workbench-live/runs"
    )

    def test_each_real_run_validates_clean(self):
        if not self.REAL_RUNS.is_dir():
            self.skipTest(f"real runs dir not found: {self.REAL_RUNS}")
        schema_path = (
            pathlib.Path(__file__).resolve().parent.parent
            / "schemas"
            / "run-metadata.yaml"
        )
        schema = metadata._load_schema_from_path(schema_path)
        bad = []
        for meta_file in sorted(self.REAL_RUNS.glob("*/metadata.yaml")):
            data = yaml_io.loads(meta_file.read_text())
            problems = metadata.validate(data, schema=schema)
            non_unknown = [p for p in problems if p.code != "unknown_key"]
            if non_unknown:
                bad.append(
                    (meta_file.parent.name, [(p.code, p.path, p.message) for p in non_unknown])
                )
        self.assertEqual(bad, [], f"real-run schema violations: {bad}")


if __name__ == "__main__":
    unittest.main()
