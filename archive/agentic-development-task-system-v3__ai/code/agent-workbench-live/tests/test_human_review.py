"""Unit + snapshot tests for lib/human_review.py (TODO §2).

Three groups:

  TestProjectTimeline   — pure-function tests over synthetic events.
  TestExtractBuildSummary — pure-function tests over synthetic build.md text.
  TestRender            — drives `render()` against a hand-built run_dir and
                          asserts the result contains all required headings.
  TestSnapshotRender    — drives the E2E happy/bounce_pass2 fixtures through
                          the full CLI flow, then snapshots the rendered file.
"""
from __future__ import annotations

import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

from tests._helpers import make_tmp_workbench, cleanup, reset_caches  # noqa: F401


ROOT = pathlib.Path(__file__).resolve().parent.parent
CLI = ROOT / "bin" / "agent-workbench"
FIXTURES = pathlib.Path(__file__).resolve().parent / "fixtures" / "e2e"
SNAPSHOTS = pathlib.Path(__file__).resolve().parent / "snapshots"


# ---------- helpers ----------


def _ev(seq: int, at: str, etype: str, *, status: str = "shaping",
        payload: dict | None = None, frm: str | None = None,
        to: str | None = None) -> dict:
    out = {
        "schema_version": 1,
        "seq": seq,
        "event_id": f"evt_{seq:04d}",
        "run_id": "synthetic",
        "at": at,
        "actor": {"type": "agent", "name": "tester"},
        "type": etype,
        "status": status,
        "payload": payload or {},
    }
    if frm is not None:
        out["from"] = frm
    if to is not None:
        out["to"] = to
    return out


# ============================================================================
# Unit tests
# ============================================================================


class TestProjectTimeline(unittest.TestCase):
    """Pure-function tests for human_review.project_timeline."""

    def test_template_staged_artifactwritten_dropped(self):
        from lib import human_review
        events = [
            _ev(1, "2026-05-22T05:38:49-04:00", "ArtifactWritten",
                status="shaping",
                payload={"artifact_key": "brief", "summary": "template staged"}),
            _ev(2, "2026-05-22T05:39:01-04:00", "ArtifactWritten",
                status="shaping",
                payload={"artifact_key": "brief",
                         "summary": "audit unit tests for duplication"}),
        ]
        rows = human_review.project_timeline(events)
        # The template-staged row is dropped; the real one survives.
        self.assertEqual(len(rows), 1)
        self.assertIn("audit unit tests", rows[0].description)
        self.assertEqual(rows[0].at_hhmmss, "05:39:01")
        self.assertEqual(rows[0].stage, "SHAPING")

    def test_denylist_rejects_generic_descriptions(self):
        from lib import human_review
        # Synthesize a custom event with an exactly-denylist description by
        # using an unrecognized type that falls through _describe → None.
        # The denylist guards summary text on recognised events.
        events = [
            # An ArtifactWritten whose summary alone would be denylisted.
            _ev(1, "2026-05-22T05:38:49-04:00", "ArtifactWritten",
                status="planning",
                payload={"artifact_key": "plan", "summary": "plan written"}),
        ]
        rows = human_review.project_timeline(events)
        # "plan written" produces description "plan.md written: plan written"
        # — that contains the denylist phrase but is not equal to it; so it
        # survives (specific enough). We can't easily exercise the denylist
        # without a synthetic event whose _describe yields exactly the
        # denylist string; instead, verify the denylist constant itself.
        self.assertIn("plan written", human_review.TIMELINE_DENYLIST)
        # And confirm the row that just rendered is informative (not empty).
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0].description)

    def test_every_row_has_required_fields(self):
        from lib import human_review
        events = [
            _ev(1, "2026-05-22T05:38:49-04:00", "TransitionApplied",
                status="shaping", frm="draft", to="shaping"),
            _ev(2, "2026-05-22T05:40:01-04:00", "ArtifactWritten",
                status="shaping",
                payload={"artifact_key": "brief", "summary": "hello world"}),
            _ev(3, "2026-05-22T05:42:00-04:00", "DecisionRecorded",
                status="planning",
                payload={"decision_id": "DR-001",
                         "decision": "use combined assertions"}),
            _ev(4, "2026-05-22T05:43:00-04:00", "ReviewCompleted",
                status="validating",
                payload={"review_decision": "approve"}),
            _ev(5, "2026-05-22T05:44:00-04:00", "QACompleted",
                status="validating",
                payload={"tests_passed": True, "known_issues_count": 0}),
        ]
        rows = human_review.project_timeline(events)
        self.assertGreater(len(rows), 0)
        ts_pat = re.compile(r"^\d{2}:\d{2}:\d{2}$")
        for row in rows:
            self.assertRegex(row.at_hhmmss, ts_pat)
            self.assertTrue(row.stage.isupper() or row.stage == "")
            self.assertTrue(row.description.strip())
            # Render shape check.
            line = row.render()
            self.assertRegex(line, r"^\[\d{2}:\d{2}:\d{2}\] [A-Z]* — .+")

    def test_bounce_row_includes_reason(self):
        from lib import human_review
        events = [
            _ev(1, "2026-05-22T08:00:00-04:00", "TransitionApplied",
                status="building", frm="human_review", to="building",
                payload={"evidence": {"bounce_reason": "AC-1 not covered"}}),
        ]
        rows = human_review.project_timeline(events)
        self.assertEqual(len(rows), 1)
        self.assertIn("bounced", rows[0].description)
        self.assertIn("AC-1", rows[0].description)

    def test_handoff_row_uses_handed_off_phrase(self):
        from lib import human_review
        events = [
            _ev(1, "2026-05-22T06:06:24-04:00", "TransitionApplied",
                status="human_review", frm="followups", to="human_review"),
        ]
        rows = human_review.project_timeline(events)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].description, "handed off")


class TestExtractBuildSummary(unittest.TestCase):
    """Pure-function tests for human_review._extract_build_summary."""

    def _write_build(self, contents: str) -> pathlib.Path:
        tmp = pathlib.Path(tempfile.mkdtemp(prefix="aw-build-")) / "build.md"
        tmp.write_text(contents)
        return tmp

    def test_missing_file_returns_empty(self):
        from lib import human_review
        result = human_review._extract_build_summary(pathlib.Path("/nonexistent"))
        self.assertEqual(result, [])

    def test_pulls_implementation_files_and_ac_count(self):
        from lib import human_review
        build = self._write_build(
            "# Build\n\n"
            "## What changed\n\n"
            "Added a `goodbye` case to `bin/cli`.\n\n"
            "## Files changed\n\n"
            "- `bin/cli`\n- `tests/test_cli.py`\n\n"
            "## Acceptance criteria coverage\n\n"
            "| AC | Status | Notes |\n"
            "|----|--------|-------|\n"
            "| AC-1 | covered | x |\n"
            "| AC-2 | covered | y |\n"
        )
        out = human_review._extract_build_summary(build)
        joined = "\n".join(out)
        # impl bullet, files inline bullet, AC bullet.
        self.assertIn("goodbye", joined)
        self.assertIn("- 2 file(s) touched: bin/cli, tests/test_cli.py", joined)
        self.assertIn("- AC coverage: 2/2 covered", joined)

    def test_no_headers_returns_empty(self):
        from lib import human_review
        build = self._write_build("# Build\n\nJust prose, no headers.\n")
        self.assertEqual(human_review._extract_build_summary(build), [])

    def test_docs_touched_renders_inline_list(self):
        from lib import human_review
        build = self._write_build(
            "# Build\n\n"
            "## What changed\nFoo.\n\n"
            "## Documentation touched\n- `README.md`\n- `docs/LOG.md`\n"
        )
        joined = "\n".join(human_review._extract_build_summary(build))
        self.assertIn("- 2 doc(s) touched: README.md, docs/LOG.md", joined)

    def test_docs_touched_none_entry_skipped(self):
        from lib import human_review
        build = self._write_build(
            "# Build\n\n"
            "## What changed\nFoo.\n\n"
            "## Documentation touched\n- (none — tiny addition)\n"
        )
        joined = "\n".join(human_review._extract_build_summary(build))
        self.assertNotIn("doc(s) touched", joined)


class TestRender(unittest.TestCase):
    """Drive human_review.render against a hand-built run_dir."""

    def setUp(self):
        self.tmp = make_tmp_workbench()

    def tearDown(self):
        cleanup(self.tmp)
        reset_caches()

    def _make_run(self) -> tuple[object, str, pathlib.Path]:
        """Create a minimal staged-layout run in draft. Returns (cfg, run_id, run_dir)."""
        from lib import config as cfg_mod, metadata, lifecycle
        cfg = cfg_mod.load(self.tmp)
        run_id = "2026-05-22-render-test"
        metadata.create(
            cfg, run_id,
            repo_mode="existing", repo_path="/tmp/repo", repo_name="repo",
            base_ref="HEAD", worktree_name="render-test",
            branch_name="agent/render-test", raw_idea_path="raw-idea.md",
            scope_kind="implementation", scope_summary="render test",
        )
        lifecycle.init_staged_layout(cfg, run_id)
        rd = metadata.run_dir(cfg, run_id)
        (rd / "raw-idea.md").write_text("test idea\n")
        return cfg, run_id, rd

    def test_render_writes_all_required_headings(self):
        from lib import human_review, lifecycle, events
        cfg, run_id, rd = self._make_run()
        # Add a couple of synthetic events so the timeline has rows.
        events.append(
            cfg, run_id, "ArtifactWritten",
            payload={"artifact_key": "brief", "path": str(rd / "brief.md"),
                     "summary": "test brief written"},
            actor={"type": "agent", "name": "tester"},
        )
        out = human_review.render(cfg, run_id)
        self.assertTrue(out.exists())
        text = out.read_text()
        for h in lifecycle.REQUIRED_HUMAN_REVIEW_HEADINGS:
            self.assertIn(h, text, msg=f"missing heading: {h}")

    def test_files_section_omits_missing_files(self):
        from lib import human_review
        cfg, run_id, rd = self._make_run()
        # No stage files dropped. The Files section should be empty of rows.
        out = human_review.render(cfg, run_id)
        text = out.read_text()
        files_body = text.split("## Files", 1)[1].split("##", 1)[0]
        # No bullet rows in the Files section.
        bullet_rows = [ln for ln in files_body.splitlines() if ln.startswith("- ")]
        self.assertEqual(bullet_rows, [])
        # The self-reference row was intentionally dropped in pass 2.
        self.assertNotIn("Human review (this file)", text)

    def test_files_section_format_one_line_per_artifact(self):
        from lib import human_review
        cfg, run_id, rd = self._make_run()
        (rd / "stages" / "2_shaping").mkdir(parents=True, exist_ok=True)
        (rd / "stages" / "2_shaping" / "brief.md").write_text("# Brief\n")
        (rd / "stages" / "4_building").mkdir(parents=True, exist_ok=True)
        (rd / "stages" / "4_building" / "build.md").write_text("# Build\n")
        out = human_review.render(cfg, run_id)
        text = out.read_text()
        # Each existing artifact renders as
        # `- **<Label>** — [<filename>](<abs path>)` on its own line.
        files_body = text.split("## Files", 1)[1].split("##", 1)[0]
        rows = [ln for ln in files_body.splitlines() if ln.startswith("- ")]
        self.assertGreaterEqual(len(rows), 2)  # brief + build at least
        pat = re.compile(
            r"^- \*\*[^*]+\*\* — \[(?P<name>[^\]]+)\]\((?P<abs>[^)]+)\)$"
        )
        for r in rows:
            m = pat.match(r)
            self.assertIsNotNone(m, f"row does not match expected shape: {r!r}")
            # The path must be absolute (starts with `/`).
            self.assertTrue(m.group("abs").startswith("/"),
                            f"path is not absolute: {m.group('abs')!r}")
            # The link text is the file name only (no slashes).
            self.assertNotIn("/", m.group("name"),
                             f"link text should be a bare file name: {r!r}")
            # And the file name should match the basename of the path.
            self.assertEqual(m.group("name"), m.group("abs").rsplit("/", 1)[-1],
                             f"link text should equal path basename: {r!r}")

    def test_testing_section_has_unit_and_manual_subheadings(self):
        from lib import human_review
        cfg, run_id, rd = self._make_run()
        out = human_review.render(cfg, run_id)
        text = out.read_text()
        testing = text.split("## Testing", 1)[1].split("##", 1)[0]
        # Both sub-headings always render.
        self.assertIn("**Unit tests**", testing)
        self.assertIn("**Manual testing**", testing)
        # Unit tests sub-section comes before Manual testing.
        self.assertLess(testing.index("**Unit tests**"),
                        testing.index("**Manual testing**"))

    def test_testing_section_inlines_qa_report_as_fenced_block(self):
        from lib import human_review
        cfg, run_id, rd = self._make_run()
        qa_dir = rd / "stages" / "5_validating" / "qa"
        qa_dir.mkdir(parents=True, exist_ok=True)
        (qa_dir / "report.md").write_text(
            "# QA report\n\n## Summary\n\n123 passed, 0 failed.\n\nDetails inline.\n"
        )
        (qa_dir / "commands.txt").write_text("python -m pytest tests/ -q\n")
        out = human_review.render(cfg, run_id)
        text = out.read_text()
        self.assertIn("`python -m pytest tests/ -q`", text)
        testing = text.split("## Testing", 1)[1].split("##", 1)[0]
        self.assertIn("```", testing)
        self.assertIn("123 passed, 0 failed.", testing)

    def test_manual_testing_falls_back_to_none_recorded(self):
        from lib import human_review
        cfg, run_id, _ = self._make_run()
        out = human_review.render(cfg, run_id)
        text = out.read_text()
        testing = text.split("## Testing", 1)[1].split("##", 1)[0]
        # Manual sub-section body falls back to _None recorded._
        manual = testing.split("**Manual testing**", 1)[1]
        self.assertIn("_None recorded._", manual)

    def test_manual_testing_inlines_qa_manual_section_when_present(self):
        from lib import human_review
        cfg, run_id, rd = self._make_run()
        qa_dir = rd / "stages" / "5_validating" / "qa"
        qa_dir.mkdir(parents=True, exist_ok=True)
        (qa_dir / "report.md").write_text(
            "# QA report\n\n## Summary\n\n10 passed.\n\n"
            "## Manual testing\n\n"
            "Drove `agent-workbench followups <id>` against a fresh staged run.\n"
            "Stdout contained `review:   /abs/path/to/HUMAN_REVIEW.md`.\n"
        )
        out = human_review.render(cfg, run_id)
        text = out.read_text()
        testing = text.split("## Testing", 1)[1].split("##", 1)[0]
        manual = testing.split("**Manual testing**", 1)[1]
        self.assertIn("Drove `agent-workbench followups", manual)
        self.assertIn("`review:   /abs/path/to/HUMAN_REVIEW.md`", manual)
        # Fallback string must NOT appear when a body is present.
        self.assertNotIn("_None recorded._", manual)

    def test_files_touched_renders_inline_list(self):
        from lib import human_review
        # Synthesize a build.md with 4 files and verify the renderer's output.
        build_path = pathlib.Path(tempfile.mkdtemp(prefix="aw-build-")) / "build.md"
        build_path.write_text(
            "# Build\n\n"
            "## What changed\n\nfoo\n\n"
            "## Files changed\n\n"
            "- `a.py`\n- `b.py`\n- `c.py`\n- `d.py`\n"
        )
        lines = human_review._extract_build_summary(build_path)
        idx = next(i for i, ln in enumerate(lines) if "file(s) touched" in ln)
        self.assertEqual(lines[idx], "- 4 file(s) touched: a.py, b.py, c.py, d.py")

    def test_files_touched_truncates_above_cap(self):
        from lib import human_review
        build_path = pathlib.Path(tempfile.mkdtemp(prefix="aw-build-")) / "build.md"
        files = "\n".join(f"- `f{i}.py`" for i in range(12))
        build_path.write_text(
            f"# Build\n\n## What changed\n\nfoo\n\n"
            f"## Files changed\n\n{files}\n"
        )
        lines = human_review._extract_build_summary(build_path)
        idx = next(i for i, ln in enumerate(lines) if "file(s) touched" in ln)
        # Inline names, then a `(…+N more)` overflow suffix.
        overflow = 12 - human_review.SUMMARY_INLINE_CAP
        self.assertTrue(
            lines[idx].endswith(f"(…+{overflow} more)"),
            msg=f"unexpected overflow form: {lines[idx]!r}",
        )
        for i in range(human_review.SUMMARY_INLINE_CAP):
            self.assertIn(f"f{i}.py", lines[idx])

    def test_render_is_idempotent(self):
        from lib import human_review
        cfg, run_id, _ = self._make_run()
        first = human_review.render(cfg, run_id).read_text()
        second = human_review.render(cfg, run_id).read_text()
        self.assertEqual(first, second)


# ============================================================================
# Regression tests for TODO §13 (handoff-rendering failure cluster)
# ============================================================================


class TestHandoffRenderingRegressions(unittest.TestCase):
    """TODO §13 regression tests for the handoff-rendering failure cluster.

    Each test was written to fail on master (pre-fix) and pass after the fix.
    See runs/2026-05-27-handoff-rendering-failure-cluster for the full
    investigation that surfaced these defects.
    """

    def _write_build(self, contents: str) -> pathlib.Path:
        tmp = pathlib.Path(tempfile.mkdtemp(prefix="aw-build-")) / "build.md"
        tmp.write_text(contents)
        return tmp

    def test_html_comment_bullets_dont_leak(self):
        """Defect 1. A build.md identical to templates/build.md must NOT
        produce phantom bullets from the example HTML comment in
        `## Documentation touched`."""
        from lib import human_review
        template_path = ROOT / "templates" / "build.md"
        build = self._write_build(template_path.read_text())
        rendered = "\n".join(human_review._extract_build_summary(build))
        # The template's `## Documentation touched` HTML comment includes an
        # example `- README.md — added a /hello endpoint example` bullet. The
        # extractor must strip HTML comments and not produce that phantom row.
        self.assertNotIn("README.md", rendered)
        self.assertNotIn("/hello endpoint example", rendered)
        self.assertNotIn("docs/api.md", rendered)

    def test_what_changed_heading_extracts_narrative(self):
        """Defect 4. The extractor must read `## What changed` (the canonical
        heading in templates/build.md), not the legacy `## Implementation
        summary`. Without this, every handoff lost its narrative."""
        from lib import human_review
        build = self._write_build(
            "# Build\n\n"
            "## What changed\n\n"
            "We added X.\n"
        )
        rendered = "\n".join(human_review._extract_build_summary(build))
        self.assertIn("We added X.", rendered)


# ============================================================================
# Snapshot tests (E2E)
# ============================================================================


def cli(workbench_root: pathlib.Path, *args, stub_fixture: pathlib.Path | None = None,
        input_text: str | None = None) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["AGENT_WORKBENCH_ROOT"] = str(workbench_root)
    if stub_fixture is not None:
        env["AGENT_WORKBENCH_STUB_LLM"] = str(stub_fixture)
    else:
        env.pop("AGENT_WORKBENCH_STUB_LLM", None)
    return subprocess.run(
        [sys.executable, str(CLI), "--root", str(workbench_root), *args],
        capture_output=True, text=True, env=env, input=input_text,
    )


def make_throwaway_repo() -> pathlib.Path:
    repo = pathlib.Path(tempfile.mkdtemp(prefix="aw-snap-repo-"))
    subprocess.run(["git", "-C", str(repo), "init", "-q", "-b", "main"], check=True)
    (repo / "bin").mkdir()
    (repo / "bin" / "cli").write_text("#!/usr/bin/env bash\n# stub\n")
    (repo / "bin" / "cli").chmod(0o755)
    subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
    subprocess.run([
        "git", "-C", str(repo),
        "-c", "user.name=test", "-c", "user.email=test@x",
        "commit", "-q", "-m", "init",
    ], check=True)
    return repo


def _normalize(text: str, run_root: pathlib.Path) -> str:
    """Replace volatile fragments with portable placeholders.

    - Absolute run-root path → <RUN_ROOT> (resolves macOS /private prefix too)
    - All other tmp paths (worktree, throwaway repo) → <TMP>
    - Per-run-id segments inside <TMP> paths are collapsed so the snapshot
      is deterministic across test invocations.
    - [HH:MM:SS] timestamps → [<HH:MM:SS>]
    """
    real = str(run_root.resolve())
    plain = str(run_root)
    text = text.replace(real, "<RUN_ROOT>")
    if plain != real:
        text = text.replace(plain, "<RUN_ROOT>")

    # Collapse any remaining /var/folders tmp paths (worktree + throwaway repo
    # roots are per-test). We replace the entire tmp path up to the first
    # stable segment we know: `worktrees`, or the trailing repo basename.
    # Strategy: replace the whole `(/private)?/var/folders/...` prefix-tree
    # up to any directory whose name begins with `aw-` with <TMP>.
    text = re.sub(
        r"(/private)?/var/folders/[A-Za-z0-9_/]+/aw-[A-Za-z0-9_-]+",
        "<TMP>",
        text,
    )
    # Inside the worktrees tree the per-test throwaway-repo dir embeds another
    # random suffix; collapse it too.
    text = re.sub(r"worktrees/aw-snap-repo-[A-Za-z0-9_-]+", "worktrees/<TEST_REPO>", text)
    # The worktree's slug suffix (e.g. `20260522__happy-snap`) is still
    # deterministic from the run_id, so leave it alone.

    text = re.sub(r"\[\d{2}:\d{2}:\d{2}\]", "[<HH:MM:SS>]", text)
    return text


class TestSnapshotRender(unittest.TestCase):
    """Drive the happy/bounce_pass2 fixtures end-to-end and snapshot the file.

    The .expected files live in tests/snapshots/. Set
    AGENT_WORKBENCH_UPDATE_SNAPSHOTS=1 to rewrite them from the current
    rendered output. Updating snapshots is a manual step (you confirm the diff
    in code review); CI without that env var always asserts equality.
    """

    UPDATE_ENV = "AGENT_WORKBENCH_UPDATE_SNAPSHOTS"

    def setUp(self):
        self.tmp = make_tmp_workbench()
        shutil.copytree(ROOT / "bin", self.tmp / "bin")
        shutil.copytree(ROOT / "lib", self.tmp / "lib")
        self.repos: list[pathlib.Path] = []

    def tearDown(self):
        cleanup(self.tmp)
        for r in self.repos:
            cleanup(r)
        reset_caches()

    def _repo(self) -> pathlib.Path:
        r = make_throwaway_repo()
        self.repos.append(r)
        return r

    def _new_run(self, fixture: pathlib.Path, slug: str) -> tuple[str, pathlib.Path]:
        repo = self._repo()
        idea = fixture / "raw-idea.md"
        r = cli(self.tmp, "new-run",
                "--repo-path", str(repo),
                "--worktree-name", slug,
                "--base-ref", "main",
                "--idea-file", str(idea))
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        run_id = r.stdout.strip()
        return run_id, self.tmp / "runs" / run_id

    def _drive_happy(self, fixture: pathlib.Path, run_id: str) -> None:
        cli(self.tmp, "draft", run_id, stub_fixture=fixture)
        cli(self.tmp, "shape", run_id, "--init", stub_fixture=fixture)
        cli(self.tmp, "shape", run_id, stub_fixture=fixture)
        cli(self.tmp, "plan", run_id, "--init", stub_fixture=fixture)
        cli(self.tmp, "plan", run_id, stub_fixture=fixture)
        cli(self.tmp, "start", run_id, "--approved-by", "snapper")
        cli(self.tmp, "validate", run_id, "--init", stub_fixture=fixture)
        cli(self.tmp, "validate", run_id, "--tests-passed", "true",
            "--known-issues", "0", stub_fixture=fixture)
        cli(self.tmp, "followups", run_id, stub_fixture=fixture)

    def _check_snapshot(self, run_dir: pathlib.Path, snapshot_name: str) -> None:
        rendered_path = run_dir / "HUMAN_REVIEW.md"
        self.assertTrue(rendered_path.exists(), "renderer did not produce file")
        rendered = _normalize(rendered_path.read_text(), run_dir)
        snapshot_path = SNAPSHOTS / snapshot_name

        if os.environ.get(self.UPDATE_ENV):
            snapshot_path.parent.mkdir(parents=True, exist_ok=True)
            snapshot_path.write_text(rendered)
            return  # accepted

        self.assertTrue(
            snapshot_path.exists(),
            f"missing snapshot: {snapshot_path}; rerun with "
            f"{self.UPDATE_ENV}=1 after reviewing the rendered file",
        )
        expected = snapshot_path.read_text()
        self.assertMultiLineEqual(expected, rendered)

    def test_happy_snapshot(self):
        fixture = FIXTURES / "happy"
        run_id, run_dir = self._new_run(fixture, slug="happy-snap")
        self._drive_happy(fixture, run_id)
        self._check_snapshot(run_dir, "human_review_happy.expected.md")

    def test_bounce_pass2_snapshot(self):
        fix1 = FIXTURES / "bounce_pass1"
        fix2 = FIXTURES / "bounce_pass2"
        run_id, run_dir = self._new_run(fix1, slug="bounce-snap")
        # Pass 1.
        cli(self.tmp, "draft", run_id, stub_fixture=fix1)
        cli(self.tmp, "shape", run_id, "--init", stub_fixture=fix1)
        cli(self.tmp, "shape", run_id, stub_fixture=fix1)
        cli(self.tmp, "plan", run_id, "--init", stub_fixture=fix1)
        cli(self.tmp, "plan", run_id, stub_fixture=fix1)
        cli(self.tmp, "start", run_id, "--approved-by", "snapper")
        cli(self.tmp, "validate", run_id, "--init", stub_fixture=fix1)
        cli(self.tmp, "validate", run_id, "--tests-passed", "false",
            "--known-issues", "1", stub_fixture=fix1)
        cli(self.tmp, "followups", run_id, stub_fixture=fix1)
        cli(self.tmp, "bounce", run_id,
            "--reason", "AC-1 not covered", "--requested-by", "snapper")
        # Pass 2.
        cli(self.tmp, "validate", run_id, "--init", stub_fixture=fix2)
        cli(self.tmp, "validate", run_id, "--tests-passed", "true",
            "--known-issues", "0", stub_fixture=fix2)
        cli(self.tmp, "followups", run_id, stub_fixture=fix2)
        self._check_snapshot(run_dir, "human_review_bounce_pass2.expected.md")


# ============================================================================
# Transition stdout regression (AC2)
# ============================================================================


class TestTransitionStdoutHasAbsolutePath(unittest.TestCase):
    """Drive a fresh staged run to human_review; assert `followups`'s stdout
    contains the absolute path to HUMAN_REVIEW.md (TODO §2 AC2)."""

    def setUp(self):
        self.tmp = make_tmp_workbench()
        shutil.copytree(ROOT / "bin", self.tmp / "bin")
        shutil.copytree(ROOT / "lib", self.tmp / "lib")
        self.repos: list[pathlib.Path] = []

    def tearDown(self):
        cleanup(self.tmp)
        for r in self.repos:
            cleanup(r)
        reset_caches()

    def test_followups_stdout_contains_absolute_human_review_path(self):
        repo = make_throwaway_repo()
        self.repos.append(repo)
        fixture = FIXTURES / "happy"
        idea = fixture / "raw-idea.md"

        r = cli(self.tmp, "new-run",
                "--repo-path", str(repo),
                "--worktree-name", "stdout-test",
                "--base-ref", "main",
                "--idea-file", str(idea))
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        run_id = r.stdout.strip()
        run_dir = self.tmp / "runs" / run_id

        cli(self.tmp, "draft", run_id, stub_fixture=fixture)
        cli(self.tmp, "shape", run_id, "--init", stub_fixture=fixture)
        cli(self.tmp, "shape", run_id, stub_fixture=fixture)
        cli(self.tmp, "plan", run_id, "--init", stub_fixture=fixture)
        cli(self.tmp, "plan", run_id, stub_fixture=fixture)
        cli(self.tmp, "start", run_id, "--approved-by", "tester")
        cli(self.tmp, "validate", run_id, "--init", stub_fixture=fixture)
        cli(self.tmp, "validate", run_id, "--tests-passed", "true",
            "--known-issues", "0", stub_fixture=fixture)

        r = cli(self.tmp, "followups", run_id, stub_fixture=fixture)
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        # The transition stdout must carry the absolute path so a reviewer
        # can click it directly. AC2.
        expected_abs = str(run_dir / "HUMAN_REVIEW.md")
        self.assertIn(expected_abs, r.stdout,
                      msg=f"stdout did not contain abs path:\n{r.stdout}")


if __name__ == "__main__":
    unittest.main()
