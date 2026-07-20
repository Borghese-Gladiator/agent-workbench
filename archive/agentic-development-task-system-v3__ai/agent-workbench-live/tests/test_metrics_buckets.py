"""Unit tests for lib.metrics.buckets."""
from __future__ import annotations

import unittest

from lib.metrics import buckets, transcript


def _turn(input_tokens: int, user_msgs=(), tool_results=()):
    """Build a CorrelatedTurn shell sufficient for attribute()."""
    return transcript.CorrelatedTurn(
        turn_id="u",
        ts="2026-05-22T00:00:00Z",
        transcript_path="/dev/null",
        session_id="s",
        cwd="/x",
        stage="building",
        command="/build",
        model="claude-opus-4-7",
        usage={"input_tokens": input_tokens, "output_tokens": 0,
               "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
        raw_user_messages=tuple(user_msgs),
        raw_tool_results=tuple(tool_results),
    )


class TestAttribute(unittest.TestCase):
    def test_zero_input_returns_all_zeros(self):
        t = _turn(0)
        out = buckets.attribute(t)
        self.assertEqual(sum(out.values()), 0)
        # All bucket keys must be present.
        for k in buckets.BUCKET_NAMES:
            self.assertIn(k, out)

    def test_no_text_means_all_other(self):
        # Cache miss simulation: large input_tokens, no visible text → all
        # bytes attributed to ``other``.
        t = _turn(5000)
        out = buckets.attribute(t)
        self.assertEqual(out["other"], 5000)

    def test_sum_equals_input_tokens(self):
        user_msg = "Hello! " * 100  # ~700 chars
        tr = ["some tool result body " * 20]  # ~440 chars
        t = _turn(input_tokens=400, user_msgs=[user_msg], tool_results=tr)
        out = buckets.attribute(t)
        self.assertEqual(sum(out.values()), 400)

    def test_claude_md_marker_attributes(self):
        msg = "Contents of /Users/me/.claude/CLAUDE.md\n\n# memories\nfoo\nbar"
        t = _turn(input_tokens=200, user_msgs=[msg])
        out = buckets.attribute(t)
        self.assertGreater(out["claude_md_and_agents_md"], 0)

    def test_command_block_attributes(self):
        msg = "<command-name>/build</command-name>\n<command-message>build</command-message>\n<command-args>x</command-args>"
        t = _turn(input_tokens=200, user_msgs=[msg])
        out = buckets.attribute(t)
        self.assertGreater(out["slash_command_body"], 0)

    def test_tool_results_attributes(self):
        t = _turn(input_tokens=200, tool_results=["some tool output\n" * 30])
        out = buckets.attribute(t)
        self.assertGreater(out["tool_results"], 0)

    def test_context_imports_attributes(self):
        msg = "Read @context/auth.md and @AGENTS.md"
        t = _turn(input_tokens=100, user_msgs=[msg])
        out = buckets.attribute(t)
        self.assertGreater(out["context_imports"], 0)

    def test_user_messages_falls_through_to_user_bucket(self):
        msg = "Just plain text, no markers, no commands."
        t = _turn(input_tokens=50, user_msgs=[msg])
        out = buckets.attribute(t)
        # The bulk goes to ``user_messages`` (the catch-all for user text
        # that didn't match a more specific bucket).
        self.assertGreater(out["user_messages"] + out["other"], 0)

    def test_merge_sums_dicts(self):
        a = {k: 0 for k in buckets.BUCKET_NAMES}
        a["tool_results"] = 5
        b = {k: 0 for k in buckets.BUCKET_NAMES}
        b["tool_results"] = 7
        b["other"] = 3
        out = buckets.merge([a, b])
        self.assertEqual(out["tool_results"], 12)
        self.assertEqual(out["other"], 3)


if __name__ == "__main__":
    unittest.main()
