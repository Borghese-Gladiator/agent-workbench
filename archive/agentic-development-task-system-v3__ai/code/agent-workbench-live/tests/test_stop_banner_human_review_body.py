"""Unit tests for lib/cli/_stop_banner._build_human_review_body and friends.

Exercises the five-section ``human_review`` banner body builder against
synthetic run dirs: HUMAN_REVIEW.md fixtures with varying bullet counts,
``QACompleted`` payloads, QA reports with/without ``## Manual testing``
bodies, and ``git diff --shortstat`` resolution boundaries.
"""
from __future__ import annotations

import contextlib
import io
import pathlib
import subprocess
import unittest

from tests._helpers import make_tmp_workbench, cleanup, reset_caches  # noqa: F401
from lib.cli._stop_banner import (
    BORDER,
    print_stop_banner,
    _build_human_review_body,
    _render_summary_bullets,
    _render_testing_line,
    _render_diffstat,
    _truncate_inline,
    BULLET_COLUMN_CAP,
)


RUN_ID = "2026-05-25-banner-body-test"


# ---------- Helpers ----------


def _git(*args, cwd):
    subprocess.run(
        ["git", "-C", str(cwd), *args],
        check=True, capture_output=True, text=True,
    )


def _make_repo(tmp: pathlib.Path) -> pathlib.Path:
    """Init a tiny git repo with one base commit. Returns the repo path."""
    repo = tmp / "repo"
    repo.mkdir()
    _git("init", "-q", "-b", "main", cwd=repo)
    _git("-c", "user.email=t@x", "-c", "user.name=t",
         "commit", "--allow-empty", "-m", "base", cwd=repo)
    return repo


def _base_sha(repo: pathlib.Path) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "HEAD"],
        check=True, capture_output=True, text=True,
    ).stdout.strip()


def _make_run(tmp: pathlib.Path) -> tuple[object, str, pathlib.Path]:
    """Create a minimal staged run in `draft`. Returns (cfg, run_id, run_dir)."""
    from lib import config as cfg_mod, metadata, lifecycle
    cfg = cfg_mod.load(tmp)
    metadata.create(
        cfg, RUN_ID,
        repo_mode="existing", repo_path="/tmp/repo", repo_name="repo",
        base_ref="HEAD", worktree_name="banner-test",
        branch_name="agent/banner-test", raw_idea_path="raw-idea.md",
        scope_kind="implementation", scope_summary="banner body test",
    )
    lifecycle.init_staged_layout(cfg, RUN_ID)
    rd = metadata.run_dir(cfg, RUN_ID)
    (rd / "raw-idea.md").write_text("test idea\n")
    return cfg, RUN_ID, rd


def _write_human_review(rd: pathlib.Path, summary_bullets: list[str]) -> None:
    """Write HUMAN_REVIEW.md with the given top-level summary bullets."""
    bullet_block = "\n".join(f"- {b}" for b in summary_bullets) if summary_bullets else ""
    content = (
        f"# Human review — {RUN_ID}\n"
        "\n"
        "## Files\n"
        "\n"
        "- **Brief** — `/tmp/brief.md`\n"
        "\n"
        "## Summary of changes\n"
        "\n"
        f"{bullet_block}\n"
        "\n"
        "## Testing\n"
        "\n"
        "_Stub._\n"
        "\n"
        "## Run timeline\n"
        "\n"
        "_None._\n"
    )
    (rd / "HUMAN_REVIEW.md").write_text(content)


def _append_qa_completed(
    cfg, run_id: str, *, tests_passed: bool | None, known_issues: int = 0,
) -> None:
    from lib import events
    events.append(
        cfg, run_id, "QACompleted",
        payload={
            "qa_report_path": "/tmp/qa.md",
            "commands_path": "/tmp/cmd.txt",
            "tests_passed": tests_passed,
            "known_issues_count": known_issues,
            "artifacts_dir": "/tmp",
            "recordings_dir": "/tmp",
            "traces_dir": "/tmp",
        },
        actor={"type": "agent", "name": "tester"},
    )


def _write_qa_report(rd: pathlib.Path, *, manual_testing_body: str | None) -> None:
    """Write stages/5_validating/qa/report.md. ``manual_testing_body`` of None
    means no `## Manual testing` section at all."""
    base = "# QA report\n\n## Summary\n\n- tests_passed: true\n\n"
    if manual_testing_body is None:
        body = base
    else:
        body = base + f"## Manual testing\n\n{manual_testing_body}\n"
    qa_dir = rd / "stages" / "5_validating" / "qa"
    qa_dir.mkdir(parents=True, exist_ok=True)
    (qa_dir / "report.md").write_text(body)


def _set_worktree(cfg, run_id: str, repo: pathlib.Path, base_sha: str) -> None:
    """Populate metadata's target.worktree.path + target.repo.base_ref_sha."""
    from lib import metadata
    def _m(d):
        d["target"]["worktree"]["path"] = str(repo)
        d["target"]["repo"]["base_ref_sha"] = base_sha
    metadata.update(cfg, run_id, _m)


def _commit_change(repo: pathlib.Path, name: str, content: str) -> None:
    """Commit `content` to `name` inside repo."""
    (repo / name).write_text(content)
    _git("add", name, cwd=repo)
    _git("-c", "user.email=t@x", "-c", "user.name=t",
         "commit", "-q", "-m", f"add {name}", cwd=repo)


# ---------- Summary-of-changes extraction ----------


class TestSummaryBullets(unittest.TestCase):
    def setUp(self):
        self.tmp = make_tmp_workbench()

    def tearDown(self):
        cleanup(self.tmp)
        reset_caches()

    def test_two_bullets_renders_both_no_tail(self):
        _, _, rd = _make_run(self.tmp)
        _write_human_review(rd, ["First bullet.", "Second bullet."])
        lines = _render_summary_bullets(rd / "HUMAN_REVIEW.md")
        self.assertEqual(lines, ["  - First bullet.", "  - Second bullet."])

    def test_five_bullets_truncates_with_tail(self):
        _, _, rd = _make_run(self.tmp)
        _write_human_review(
            rd,
            ["one", "two", "three", "four", "five"],
        )
        lines = _render_summary_bullets(rd / "HUMAN_REVIEW.md")
        self.assertEqual(lines, [
            "  - one",
            "  - two",
            "  - three",
            "  …(2 more in HUMAN_REVIEW.md)",
        ])

    def test_zero_bullets_renders_none_recorded(self):
        _, _, rd = _make_run(self.tmp)
        _write_human_review(rd, [])
        lines = _render_summary_bullets(rd / "HUMAN_REVIEW.md")
        self.assertEqual(lines, ["  (none recorded)"])

    def test_missing_human_review_renders_none_recorded(self):
        _, _, rd = _make_run(self.tmp)
        # No HUMAN_REVIEW.md written.
        lines = _render_summary_bullets(rd / "HUMAN_REVIEW.md")
        self.assertEqual(lines, ["  (none recorded)"])

    def test_nested_rows_are_ignored(self):
        # The renderer in human_review.py emits `  - <path>` rows below a
        # parent `- N file(s) touched:` header. The banner extractor must
        # pull only the top-level bullets, ignoring nested rows.
        _, _, rd = _make_run(self.tmp)
        content = (
            "## Summary of changes\n"
            "\n"
            "- First top-level.\n"
            "- 3 file(s) touched:\n"
            "  - `a.py`\n"
            "  - `b.py`\n"
            "  - `c.py`\n"
            "- AC coverage: 2/2 covered\n"
        )
        (rd / "HUMAN_REVIEW.md").write_text(content)
        lines = _render_summary_bullets(rd / "HUMAN_REVIEW.md")
        self.assertEqual(lines, [
            "  - First top-level.",
            "  - 3 file(s) touched:",
            "  - AC coverage: 2/2 covered",
        ])

    def test_long_bullet_truncated_at_column_cap(self):
        _, _, rd = _make_run(self.tmp)
        long_text = "x" * (BULLET_COLUMN_CAP + 50)
        _write_human_review(rd, [long_text])
        lines = _render_summary_bullets(rd / "HUMAN_REVIEW.md")
        body = lines[0][len("  - "):]  # strip the indent + dash
        self.assertEqual(len(body), BULLET_COLUMN_CAP)
        self.assertTrue(body.endswith("…"))

    def test_truncate_inline_under_limit_unchanged(self):
        self.assertEqual(_truncate_inline("short", 100), "short")

    def test_truncate_inline_collapses_newlines(self):
        self.assertEqual(_truncate_inline("a\nb", 100), "a b")


# ---------- Summary-of-testing line ----------


class TestTestingLine(unittest.TestCase):
    def setUp(self):
        self.tmp = make_tmp_workbench()

    def tearDown(self):
        cleanup(self.tmp)
        reset_caches()

    def test_no_qa_event_returns_none_recorded(self):
        _, _, rd = _make_run(self.tmp)
        line = _render_testing_line([], rd)
        self.assertEqual(line, "None recorded.")

    def test_passed_no_known_issues_no_manual_one_sentence(self):
        cfg, run_id, rd = _make_run(self.tmp)
        _append_qa_completed(cfg, run_id, tests_passed=True, known_issues=0)
        from lib import events
        events_list = list(events.iter_events(cfg, run_id))
        line = _render_testing_line(events_list, rd)
        self.assertEqual(line, "Unit tests passed; no known issues.")

    def test_failed_with_manual_testing_two_sentences(self):
        cfg, run_id, rd = _make_run(self.tmp)
        _append_qa_completed(cfg, run_id, tests_passed=False, known_issues=2)
        _write_qa_report(rd, manual_testing_body="Drove the feature in a real session.")
        from lib import events
        events_list = list(events.iter_events(cfg, run_id))
        line = _render_testing_line(events_list, rd)
        self.assertEqual(
            line,
            "Unit tests failed (see HUMAN_REVIEW.md). "
            "A dogfood/manual run was recorded.",
        )

    def test_passed_with_known_issues_uses_count_form(self):
        cfg, run_id, rd = _make_run(self.tmp)
        _append_qa_completed(cfg, run_id, tests_passed=True, known_issues=3)
        from lib import events
        events_list = list(events.iter_events(cfg, run_id))
        line = _render_testing_line(events_list, rd)
        self.assertEqual(line, "Unit tests passed (3 known issue(s)).")

    def test_passed_with_manual_placeholder_no_second_sentence(self):
        # A "_None recorded._" placeholder in the QA report's Manual testing
        # section must NOT trigger the dogfood sentence.
        cfg, run_id, rd = _make_run(self.tmp)
        _append_qa_completed(cfg, run_id, tests_passed=True, known_issues=0)
        _write_qa_report(rd, manual_testing_body="_None recorded._")
        from lib import events
        events_list = list(events.iter_events(cfg, run_id))
        line = _render_testing_line(events_list, rd)
        self.assertEqual(line, "Unit tests passed; no known issues.")

    def test_passed_no_qa_report_at_all_no_second_sentence(self):
        cfg, run_id, rd = _make_run(self.tmp)
        _append_qa_completed(cfg, run_id, tests_passed=True, known_issues=0)
        # No QA report written.
        from lib import events
        events_list = list(events.iter_events(cfg, run_id))
        line = _render_testing_line(events_list, rd)
        self.assertEqual(line, "Unit tests passed; no known issues.")

    def test_tests_passed_none_returns_unrecorded_form(self):
        # The event schema requires tests_passed to be a bool, but the
        # builder defensively handles the None case (e.g. an event from a
        # broken / future schema variant). Synthesize the event by handing
        # the builder a hand-rolled events list.
        _, _, rd = _make_run(self.tmp)
        events_list = [{
            "type": "QACompleted",
            "payload": {"tests_passed": None, "known_issues_count": 0},
        }]
        line = _render_testing_line(events_list, rd)
        self.assertEqual(line, "Test outcome unrecorded.")


# ---------- Diffstat ----------


class TestDiffstat(unittest.TestCase):
    def setUp(self):
        self.tmp = make_tmp_workbench()

    def tearDown(self):
        cleanup(self.tmp)
        reset_caches()

    def test_no_worktree_or_base_ref_returns_unavailable(self):
        meta = {"target": {"repo": {}, "worktree": {}}}
        self.assertEqual(
            _render_diffstat(meta),
            "unavailable (base_ref unresolved).",
        )

    def test_unresolvable_symbolic_ref_returns_unavailable(self):
        repo = _make_repo(self.tmp)
        meta = {
            "target": {
                "repo": {"base_ref": "no-such-ref", "base_ref_sha": None},
                "worktree": {"path": str(repo)},
            }
        }
        self.assertEqual(
            _render_diffstat(meta),
            "unavailable (base_ref unresolved).",
        )

    def test_resolvable_empty_diff_returns_zero_files_changed(self):
        repo = _make_repo(self.tmp)
        base_sha = _base_sha(repo)
        meta = {
            "target": {
                "repo": {"base_ref": "HEAD", "base_ref_sha": base_sha},
                "worktree": {"path": str(repo)},
            }
        }
        self.assertEqual(
            _render_diffstat(meta),
            "0 files changed, +0 / −0 lines",
        )

    def test_real_diff_renders_target_format(self):
        repo = _make_repo(self.tmp)
        base_sha = _base_sha(repo)
        _commit_change(repo, "feature.txt", "alpha\nbeta\ngamma\n")
        meta = {
            "target": {
                "repo": {"base_ref": "HEAD", "base_ref_sha": base_sha},
                "worktree": {"path": str(repo)},
            }
        }
        out = _render_diffstat(meta)
        # 1 file with 3 added lines, 0 deletions.
        self.assertEqual(out, "1 files changed, +3 / −0 lines")

    def test_lazy_resolve_symbolic_succeeds_when_sha_missing(self):
        # base_ref_sha is None, but the symbolic name 'HEAD' resolves in
        # the worktree — we should still get a usable diffstat.
        repo = _make_repo(self.tmp)
        meta = {
            "target": {
                "repo": {"base_ref": "HEAD", "base_ref_sha": None},
                "worktree": {"path": str(repo)},
            }
        }
        # No commits beyond base — diff is empty but the ref resolved.
        out = _render_diffstat(meta)
        self.assertEqual(out, "0 files changed, +0 / −0 lines")


# ---------- Integration: full banner via print_stop_banner ----------


def _render_banner(cfg, run_id: str) -> str:
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        print_stop_banner("human_review", run_id, cfg=cfg)
    return buf.getvalue()


class TestFullBanner(unittest.TestCase):
    def setUp(self):
        self.tmp = make_tmp_workbench()

    def tearDown(self):
        cleanup(self.tmp)
        reset_caches()

    def test_five_sections_in_order(self):
        cfg, run_id, rd = _make_run(self.tmp)
        _write_human_review(rd, ["alpha bullet", "beta bullet"])
        _append_qa_completed(cfg, run_id, tests_passed=True, known_issues=0)
        # No QA report — testing line is the single sentence form.
        # Worktree: a tiny repo so diffstat renders the empty form.
        repo = _make_repo(self.tmp)
        _set_worktree(cfg, run_id, repo, _base_sha(repo))

        out = _render_banner(cfg, run_id)
        # Sections appear in order.
        positions = {}
        for label in (
            "Review:",
            "Summary of changes",
            "Summary of testing",
            "Diffstat:",
            "Next moves (human-triggered, type in a session):",
        ):
            self.assertIn(label, out, msg=f"missing section: {label}")
            positions[label] = out.index(label)
        ordered = list(positions.values())
        self.assertEqual(ordered, sorted(ordered),
                         msg=f"sections out of order: {positions}")

        # Frame.
        self.assertTrue(out.startswith(BORDER + "\n"))
        self.assertTrue(out.rstrip("\n").endswith(BORDER))

        # Absolute path to HUMAN_REVIEW.md.
        self.assertIn(str((rd / "HUMAN_REVIEW.md").resolve()), out)

        # Three slash-form decision lines.
        self.assertIn(f"/complete {run_id}", out)
        self.assertIn(f"/bounce {run_id}", out)
        self.assertIn(f"/abandon {run_id}", out)
        # Shell-form must be absent.
        self.assertNotIn("agent-workbench complete", out)
        self.assertNotIn("agent-workbench bounce", out)
        self.assertNotIn("agent-workbench abandon", out)

    def test_summary_truncation_in_full_banner(self):
        cfg, run_id, rd = _make_run(self.tmp)
        _write_human_review(rd, ["a", "b", "c", "d", "e"])
        _append_qa_completed(cfg, run_id, tests_passed=True, known_issues=0)
        repo = _make_repo(self.tmp)
        _set_worktree(cfg, run_id, repo, _base_sha(repo))
        out = _render_banner(cfg, run_id)
        self.assertIn("…(2 more in HUMAN_REVIEW.md)", out)

    def test_no_qa_event_renders_none_recorded(self):
        cfg, run_id, rd = _make_run(self.tmp)
        _write_human_review(rd, ["a"])
        repo = _make_repo(self.tmp)
        _set_worktree(cfg, run_id, repo, _base_sha(repo))
        # No QACompleted event.
        out = _render_banner(cfg, run_id)
        # The literal "None recorded." appears as the testing line.
        self.assertIn("None recorded.", out)

    def test_ascii_only_no_color_escapes(self):
        cfg, run_id, rd = _make_run(self.tmp)
        _write_human_review(rd, ["a"])
        _append_qa_completed(cfg, run_id, tests_passed=True, known_issues=0)
        repo = _make_repo(self.tmp)
        _set_worktree(cfg, run_id, repo, _base_sha(repo))
        out = _render_banner(cfg, run_id)
        # No ANSI escape sequences.
        self.assertNotIn("\x1b[", out)


# ---------- Body builder with no cfg ----------


class TestNoConfigFallback(unittest.TestCase):
    def test_no_cfg_body_renders_only_next_moves(self):
        body = _build_human_review_body(cfg=None, run_id=RUN_ID)
        # First line is the Next moves header.
        self.assertEqual(
            body[0],
            "Next moves (human-triggered, type in a session):",
        )
        # Exactly three decision lines after the header.
        self.assertEqual(len(body), 4)
        self.assertIn(f"/complete {RUN_ID}", body[1])
        self.assertIn(f"/bounce {RUN_ID}", body[2])
        self.assertIn(f"/abandon {RUN_ID}", body[3])


if __name__ == "__main__":
    unittest.main()
