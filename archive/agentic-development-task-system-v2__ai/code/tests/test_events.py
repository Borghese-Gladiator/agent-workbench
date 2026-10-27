"""Unit tests for lib.events.

Run from the workbench root:
    PYTHONPATH=. python3 -m unittest discover tests
"""

import json
import multiprocessing
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lib.events import Event, EventError, append, last_transition, read_all


def _append_in_subproc(run_dir_str: str, event_type: str, actor: str) -> None:
    """Helper for the concurrent-append test. Must be top-level for pickling."""
    # Re-import inside the subprocess because lib may not be on sys.path there.
    import sys as _sys
    _sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from lib.events import Event as _Event, append as _append  # noqa
    _append(Path(run_dir_str), _Event(event_type=event_type, actor=actor))


class TestAppendAndRead(unittest.TestCase):
    def test_round_trip(self):
        with tempfile.TemporaryDirectory() as td:
            run_dir = Path(td)
            event = Event(
                event_type="TaskCreated",
                actor="script:new-feature.sh",
                to_state="draft",
                payload={"repo_key": "frontend"},
            )
            append(run_dir, event)
            events = read_all(run_dir)
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0].event_type, "TaskCreated")
            self.assertEqual(events[0].actor, "script:new-feature.sh")
            self.assertEqual(events[0].to_state, "draft")
            self.assertEqual(events[0].payload, {"repo_key": "frontend"})
            self.assertTrue(events[0].created_at.endswith("Z"))

    def test_missing_file_reads_empty(self):
        with tempfile.TemporaryDirectory() as td:
            self.assertEqual(read_all(Path(td)), [])

    def test_append_requires_run_dir(self):
        with self.assertRaises(EventError):
            append(Path("/nonexistent/path/runs/foo"), Event(event_type="x", actor="y"))

    def test_append_requires_event_type(self):
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(EventError):
                append(Path(td), Event(event_type="", actor="x"))

    def test_append_requires_actor(self):
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(EventError):
                append(Path(td), Event(event_type="x", actor=""))

    def test_malformed_line_raises(self):
        with tempfile.TemporaryDirectory() as td:
            run_dir = Path(td)
            (run_dir / "events.jsonl").write_text("not json at all\n")
            with self.assertRaises(EventError):
                read_all(run_dir)

    def test_non_object_json_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            run_dir = Path(td)
            (run_dir / "events.jsonl").write_text("[1,2,3]\n")
            with self.assertRaises(EventError):
                read_all(run_dir)

    def test_missing_required_field_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            run_dir = Path(td)
            (run_dir / "events.jsonl").write_text(
                json.dumps({"event_type": "x"}) + "\n"
            )
            with self.assertRaises(EventError):
                read_all(run_dir)

    def test_blank_lines_skipped(self):
        with tempfile.TemporaryDirectory() as td:
            run_dir = Path(td)
            append(run_dir, Event(event_type="A", actor="x"))
            # Inject a blank line by re-opening manually.
            with (run_dir / "events.jsonl").open("a") as f:
                f.write("\n")
            append(run_dir, Event(event_type="B", actor="x"))
            events = read_all(run_dir)
            self.assertEqual([e.event_type for e in events], ["A", "B"])


class TestLastTransition(unittest.TestCase):
    def test_returns_most_recent_transition(self):
        with tempfile.TemporaryDirectory() as td:
            run_dir = Path(td)
            append(run_dir, Event(event_type="TaskCreated", actor="x", to_state="draft"))
            append(
                run_dir,
                Event(
                    event_type="TransitionApplied",
                    actor="x",
                    from_state="draft",
                    to_state="in_progress",
                ),
            )
            append(run_dir, Event(event_type="ArtifactWritten", actor="x"))
            append(
                run_dir,
                Event(
                    event_type="TransitionApplied",
                    actor="x",
                    from_state="in_progress",
                    to_state="in_review",
                ),
            )
            last = last_transition(run_dir)
            self.assertIsNotNone(last)
            self.assertEqual(last.to_state, "in_review")

    def test_none_when_no_transitions(self):
        with tempfile.TemporaryDirectory() as td:
            run_dir = Path(td)
            append(run_dir, Event(event_type="ArtifactWritten", actor="x"))
            self.assertIsNone(last_transition(run_dir))

    def test_none_when_no_file(self):
        with tempfile.TemporaryDirectory() as td:
            self.assertIsNone(last_transition(Path(td)))


class TestConcurrentAppend(unittest.TestCase):
    def test_two_processes_both_land(self):
        # POSIX O_APPEND is atomic for writes <= PIPE_BUF (4096 on macOS/Linux).
        # Our event lines are well under that, so both subprocs' writes must
        # land cleanly without interleaving.
        with tempfile.TemporaryDirectory() as td:
            run_dir = Path(td)
            ctx = multiprocessing.get_context("spawn")
            procs = [
                ctx.Process(target=_append_in_subproc, args=(str(run_dir), f"E{i}", "x"))
                for i in range(2)
            ]
            for p in procs:
                p.start()
            for p in procs:
                p.join(timeout=10)
                self.assertEqual(p.exitcode, 0)
            events = read_all(run_dir)
            self.assertEqual(len(events), 2)
            types = sorted(e.event_type for e in events)
            self.assertEqual(types, ["E0", "E1"])


if __name__ == "__main__":
    unittest.main()
