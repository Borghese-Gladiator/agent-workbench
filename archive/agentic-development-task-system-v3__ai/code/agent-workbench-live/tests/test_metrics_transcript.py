"""Unit tests for lib.metrics.transcript."""
from __future__ import annotations

import json
import pathlib
import tempfile
import unittest

from lib.metrics import transcript as trans


def _write_jsonl(path: pathlib.Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")


def _make_user_command(cmd: str, ts: str, cwd: str, uuid: str = "u1") -> dict:
    return {
        "type": "user",
        "uuid": uuid,
        "timestamp": ts,
        "cwd": cwd,
        "sessionId": "s1",
        "message": {"role": "user", "content": f"<command-name>{cmd}</command-name>\n<command-args></command-args>"},
    }


def _make_user_text(text: str, ts: str, cwd: str, uuid: str = "u_text") -> dict:
    return {
        "type": "user",
        "uuid": uuid,
        "timestamp": ts,
        "cwd": cwd,
        "sessionId": "s1",
        "message": {"role": "user", "content": text},
    }


def _make_assistant(ts: str, cwd: str, model: str = "claude-opus-4-7",
                    input_tokens: int = 100, output_tokens: int = 10,
                    cache_read: int = 0, cache_create: int = 0,
                    uuid: str = "a1") -> dict:
    return {
        "type": "assistant",
        "uuid": uuid,
        "timestamp": ts,
        "cwd": cwd,
        "sessionId": "s1",
        "message": {
            "role": "assistant",
            "model": model,
            "usage": {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cache_read_input_tokens": cache_read,
                "cache_creation_input_tokens": cache_create,
            },
            "content": [{"type": "text", "text": "hello"}],
        },
    }


class TestSlugify(unittest.TestCase):
    def test_basic_slash_to_dash(self):
        self.assertEqual(
            trans.slugify_project_path("/Users/me/proj"),
            "-Users-me-proj",
        )

    def test_underscores_and_dots(self):
        # Path with underscores + dots → both collapse to dash.
        self.assertEqual(
            trans.slugify_project_path("/Users/me/agentic_v2/agent-workbench-live"),
            "-Users-me-agentic-v2-agent-workbench-live",
        )


class TestFindTranscripts(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="aw-metrics-"))

    def test_missing_dir_returns_empty(self):
        result = trans.find_transcripts("-no-such-slug", base_dir=self.tmp)
        self.assertEqual(result, [])

    def test_returns_jsonl_sorted(self):
        slug_dir = self.tmp / "-some-slug"
        slug_dir.mkdir()
        (slug_dir / "b.jsonl").write_text("{}\n")
        (slug_dir / "a.jsonl").write_text("{}\n")
        (slug_dir / "ignored.txt").write_text("nope\n")
        result = trans.find_transcripts("-some-slug", base_dir=self.tmp)
        self.assertEqual([p.name for p in result], ["a.jsonl", "b.jsonl"])


class TestCorrelate(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="aw-metrics-"))
        self.cwd = "/Users/me/proj"

    def test_single_command_attributes_assistant_turn(self):
        path = self.tmp / "t.jsonl"
        _write_jsonl(path, [
            _make_user_command("/build", "2026-05-22T10:00:00.000Z", self.cwd),
            _make_assistant("2026-05-22T10:00:01.000Z", self.cwd, input_tokens=42),
        ])
        out = trans.correlate([path], run_cwd=self.cwd)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0].stage, "building")
        self.assertEqual(out[0].command, "/build")
        self.assertEqual(out[0].usage["input_tokens"], 42)

    def test_window_excludes_outside_turns(self):
        path = self.tmp / "t.jsonl"
        _write_jsonl(path, [
            _make_user_command("/build", "2026-05-22T10:00:00.000Z", self.cwd),
            _make_assistant("2026-05-22T10:00:01.000Z", self.cwd, input_tokens=1),
            _make_assistant("2026-05-22T11:00:00.000Z", self.cwd, input_tokens=2),
        ])
        out = trans.correlate(
            [path],
            run_cwd=self.cwd,
            window_start="2026-05-22T10:30:00+00:00",
        )
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0].usage["input_tokens"], 2)

    def test_wrong_cwd_falls_into_other(self):
        path = self.tmp / "t.jsonl"
        _write_jsonl(path, [
            _make_user_command("/build", "2026-05-22T10:00:00.000Z", "/Users/me/other"),
            _make_assistant("2026-05-22T10:00:01.000Z", "/Users/me/other", input_tokens=99),
        ])
        out = trans.correlate([path], run_cwd=self.cwd)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0].stage, "other")

    def test_subdirectory_cwd_matches(self):
        path = self.tmp / "t.jsonl"
        sub = self.cwd + "/sub"
        _write_jsonl(path, [
            _make_user_command("/validate", "2026-05-22T10:00:00.000Z", sub),
            _make_assistant("2026-05-22T10:00:01.000Z", sub, input_tokens=11),
        ])
        out = trans.correlate([path], run_cwd=self.cwd)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0].stage, "validating")

    def test_assistant_without_command_marker_is_other_stage(self):
        path = self.tmp / "t.jsonl"
        _write_jsonl(path, [
            _make_user_text("hello, no command here", "2026-05-22T10:00:00.000Z", self.cwd),
            _make_assistant("2026-05-22T10:00:01.000Z", self.cwd, input_tokens=5),
        ])
        out = trans.correlate([path], run_cwd=self.cwd)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0].stage, "other")
        self.assertEqual(out[0].command, "")

    def test_skips_non_assistant_records(self):
        path = self.tmp / "t.jsonl"
        _write_jsonl(path, [
            {"type": "permission-mode", "permissionMode": "auto"},
            _make_user_command("/build", "2026-05-22T10:00:00.000Z", self.cwd),
            _make_assistant("2026-05-22T10:00:01.000Z", self.cwd, input_tokens=10),
        ])
        out = trans.correlate([path], run_cwd=self.cwd)
        self.assertEqual(len(out), 1)

    def test_correlator_inherits_command_across_files(self):
        """Pass-2 A1. A slash command issued in file 1 continues to attribute
        assistant turns in file 2 (same session, multi-file transcript)."""
        p1 = self.tmp / "01.jsonl"
        p2 = self.tmp / "02.jsonl"
        _write_jsonl(p1, [
            _make_user_command("/build", "2026-05-22T10:00:00.000Z", self.cwd),
            _make_assistant("2026-05-22T10:00:01.000Z", self.cwd, input_tokens=11, uuid="a1"),
        ])
        _write_jsonl(p2, [
            # No fresh /build marker — but turn still belongs to /build.
            _make_assistant("2026-05-22T10:01:00.000Z", self.cwd, input_tokens=22, uuid="a2"),
        ])
        out = trans.correlate([p1, p2], run_cwd=self.cwd)
        self.assertEqual(len(out), 2)
        self.assertEqual(out[0].stage, "building")
        self.assertEqual(out[1].stage, "building",
                         "A1: command must persist across file boundary")
        self.assertEqual(out[1].command, "/build")

    def test_workbench_fallback_attributes_known_command(self):
        """Pass-2 A1. When cwd doesn't match the run but the slash command is
        workbench-known AND the cwd is under workbench_root, attribute to the
        stage rather than 'other'."""
        path = self.tmp / "t.jsonl"
        # cwd is /Users/me/sibling — NOT under self.cwd.
        sibling = "/Users/me/sibling"
        _write_jsonl(path, [
            _make_user_command("/validate", "2026-05-22T10:00:00.000Z", sibling),
            _make_assistant("2026-05-22T10:00:01.000Z", sibling, input_tokens=33),
        ])
        # workbench_root is /Users/me (parent of sibling). Should fall back.
        out = trans.correlate([path], run_cwd=self.cwd, workbench_root="/Users/me")
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0].stage, "validating",
                         "A1 fallback: workbench-driven turn attributes despite cwd mismatch")

    def test_workbench_fallback_off_when_no_command(self):
        """The fallback only fires when a known slash command is active."""
        path = self.tmp / "t.jsonl"
        sibling = "/Users/me/sibling"
        _write_jsonl(path, [
            _make_user_text("just a question, no command", "2026-05-22T10:00:00.000Z", sibling),
            _make_assistant("2026-05-22T10:00:01.000Z", sibling, input_tokens=44),
        ])
        out = trans.correlate([path], run_cwd=self.cwd, workbench_root="/Users/me")
        self.assertEqual(out[0].stage, "other")

    def test_prefix_accumulators_grow_monotonically(self):
        """Pass-2 A3. prefix_* fields on each CorrelatedTurn carry the full
        session-prefix bodies up to and including that turn."""
        path = self.tmp / "t.jsonl"
        _write_jsonl(path, [
            _make_user_command("/build", "2026-05-22T10:00:00.000Z", self.cwd),
            _make_assistant("2026-05-22T10:00:01.000Z", self.cwd, input_tokens=1, uuid="a1"),
            _make_user_text("follow-up 1", "2026-05-22T10:00:02.000Z", self.cwd, uuid="u2"),
            _make_assistant("2026-05-22T10:00:03.000Z", self.cwd, input_tokens=2, uuid="a2"),
            _make_user_text("follow-up 2", "2026-05-22T10:00:04.000Z", self.cwd, uuid="u3"),
            _make_assistant("2026-05-22T10:00:05.000Z", self.cwd, input_tokens=3, uuid="a3"),
        ])
        out = trans.correlate([path], run_cwd=self.cwd)
        self.assertEqual(len(out), 3)
        self.assertLessEqual(len(out[0].prefix_user_messages), len(out[1].prefix_user_messages))
        self.assertLessEqual(len(out[1].prefix_user_messages), len(out[2].prefix_user_messages))
        # A3 includes a slash-command marker on the first turn.
        joined = "\n".join(out[2].prefix_user_messages)
        self.assertIn("follow-up 1", joined)
        self.assertIn("follow-up 2", joined)


if __name__ == "__main__":
    unittest.main()
