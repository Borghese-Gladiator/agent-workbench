"""Integration test for lib.metrics.writer.record_run_metrics.

Synthesizes a transcript JSONL + a run's metadata + events.jsonl in a temp
workbench, then runs record_run_metrics and asserts the resulting
metrics.jsonl has the expected row shape.
"""
from __future__ import annotations

import json
import pathlib
import shutil
import tempfile
import unittest

from tests._helpers import make_tmp_workbench  # noqa: F401
from tests.test_metrics_summary import _write_metadata


def _transcript_record_user_cmd(cmd: str, ts: str, cwd: str) -> dict:
    return {
        "type": "user", "uuid": f"u-{cmd}", "timestamp": ts, "cwd": cwd,
        "sessionId": "s1",
        "message": {"role": "user",
                    "content": f"<command-name>{cmd}</command-name>\n<command-args></command-args>"},
    }


def _transcript_record_assistant(ts: str, cwd: str, *, input_tokens: int,
                                 output_tokens: int = 5, model: str = "claude-opus-4-7") -> dict:
    return {
        "type": "assistant", "uuid": f"a-{ts}", "timestamp": ts, "cwd": cwd,
        "sessionId": "s1",
        "message": {
            "role": "assistant", "model": model,
            "usage": {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0,
            },
            "content": [{"type": "text", "text": "ok"}],
        },
    }


class TestRecordRunMetrics(unittest.TestCase):
    def setUp(self):
        self.tmp = make_tmp_workbench()
        # The workbench root is cfg.root; we need to seed metrics/prices.yaml.
        (self.tmp / "metrics").mkdir(parents=True, exist_ok=True)
        prices_src = pathlib.Path(__file__).resolve().parent.parent / "metrics" / "prices.yaml"
        shutil.copy(prices_src, self.tmp / "metrics" / "prices.yaml")
        from lib import config as config_mod
        self.cfg = config_mod.load(self.tmp)

        self.run_id = "r-int"
        self.run_dir = self.cfg.runs_path / self.run_id
        # Use a directory we control as cwd.
        self.run_cwd = pathlib.Path(tempfile.mkdtemp(prefix="aw-int-cwd-"))
        _write_metadata(self.run_dir, self.run_id, status="human_review")
        # Override target.repo.path to point at our cwd so the project-slug
        # locator finds the seeded transcript.
        from lib import metadata
        def _m(d):
            d["target"]["repo"]["path"] = str(self.run_cwd)
            d["target"]["worktree"]["path"] = str(self.run_cwd)
        metadata.update(self.cfg, self.run_id, _m)

        # Seed a transcript at ~/.claude/projects/<slug>/. We can't use real
        # ~/.claude; redirect via the transcripts_dir() function — set the
        # base via monkey-patch in a subclass-style approach: instead, point
        # find_transcripts at our temp by monkey-patching transcripts_dir.
        self.fake_home = pathlib.Path(tempfile.mkdtemp(prefix="aw-int-home-"))
        self.transcripts_root = self.fake_home / ".claude" / "projects"
        from lib.metrics import transcript as trans
        slug = trans.slugify_project_path(str(self.run_cwd))
        slug_dir = self.transcripts_root / slug
        slug_dir.mkdir(parents=True)
        t = slug_dir / "session.jsonl"
        records = [
            _transcript_record_user_cmd("/build", "2026-05-22T10:00:00.000Z", str(self.run_cwd)),
            _transcript_record_assistant("2026-05-22T10:00:01.000Z", str(self.run_cwd),
                                         input_tokens=120, output_tokens=10),
            _transcript_record_user_cmd("/validate", "2026-05-22T10:05:00.000Z", str(self.run_cwd)),
            _transcript_record_assistant("2026-05-22T10:05:01.000Z", str(self.run_cwd),
                                         input_tokens=200, output_tokens=15),
        ]
        with t.open("w") as f:
            for r in records:
                f.write(json.dumps(r) + "\n")
        # Monkey-patch transcripts_dir() for the duration of the test.
        self._orig_td = trans.transcripts_dir
        trans.transcripts_dir = lambda: self.transcripts_root

        # Seed events.jsonl so build_outcome rows can be derived.
        self.run_dir.mkdir(parents=True, exist_ok=True)
        events_lines = [
            {"type": "TransitionApplied", "from": "building", "to": "validating",
             "at": "2026-05-22T10:04:30Z", "payload": {}},
            {"type": "ReviewCompleted", "at": "2026-05-22T10:05:30Z",
             "payload": {"review_decision": "approve"}},
        ]
        with (self.run_dir / "events.jsonl").open("w") as f:
            for e in events_lines:
                f.write(json.dumps(e) + "\n")

    def tearDown(self):
        from lib.metrics import transcript as trans
        trans.transcripts_dir = self._orig_td

    def test_writer_creates_metrics_jsonl(self):
        from lib.metrics import writer
        from lib.metrics import summary as summ
        p = writer.record_run_metrics(self.cfg, self.run_id)
        self.assertTrue(p.exists())
        rows = []
        with p.open("r") as f:
            for line in f:
                rows.append(json.loads(line))
        # At least 1 header, 2 turns, 1 build_outcome, 2 line_count rows.
        kinds = [r["kind"] for r in rows]
        self.assertEqual(kinds.count("header"), 1)
        self.assertEqual(kinds.count("turn"), 2)
        self.assertEqual(kinds.count("build_outcome"), 1)
        self.assertEqual(kinds.count("line_count"), 2)

        # The summary now works.
        s = summ.summarize(self.cfg, self.run_id)
        self.assertEqual(s.total_input, 320)
        self.assertEqual(s.total_output, 25)
        self.assertEqual(s.validate_attempts, 1)
        self.assertEqual(s.approves, 1)
        # Cost > 0 since prices.yaml has Opus rates.
        self.assertGreater(s.cost_generated_usd, 0.0)

    def test_writer_is_idempotent(self):
        from lib.metrics import writer
        writer.record_run_metrics(self.cfg, self.run_id)
        first = (self.run_dir / "metrics.jsonl").read_text()
        writer.record_run_metrics(self.cfg, self.run_id)
        second = (self.run_dir / "metrics.jsonl").read_text()
        # Header timestamps differ, but the turn / line_count payloads match.
        def _strip_at(text: str) -> str:
            keep = []
            for line in text.splitlines():
                row = json.loads(line)
                row.pop("at", None)
                keep.append(json.dumps(row, sort_keys=True))
            return "\n".join(keep)
        self.assertEqual(_strip_at(first), _strip_at(second))


if __name__ == "__main__":
    unittest.main()
