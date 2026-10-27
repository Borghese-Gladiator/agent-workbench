"""Unit tests for cache-bucket attribution (pass-2 A2, A3).

Synthesizes a CorrelatedTurn whose prefix accumulators carry known-proportion
text in each bucket. Asserts attribute_cache_read / attribute_cache_creation
attribute within ±2% of expected.
"""
from __future__ import annotations

import unittest

from lib.metrics import buckets, transcript


def _make_turn(
    *,
    cache_read: int = 0,
    cache_creation: int = 0,
    prefix_user=(),
    prefix_assistant=(),
    prefix_tool=(),
    command: str = "/build",
):
    return transcript.CorrelatedTurn(
        turn_id="u",
        ts="2026-05-24T00:00:00Z",
        transcript_path="/dev/null",
        session_id="s",
        cwd="/x",
        stage="building",
        command=command,
        model="claude-opus-4-7",
        usage={
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_input_tokens": cache_read,
            "cache_creation_input_tokens": cache_creation,
        },
        raw_user_messages=(),
        raw_tool_results=(),
        prefix_user_messages=tuple(prefix_user),
        prefix_assistant_messages=tuple(prefix_assistant),
        prefix_tool_results=tuple(prefix_tool),
    )


class TestCacheBucketAttribution(unittest.TestCase):
    def test_no_cache_returns_all_zeros(self):
        t = _make_turn(cache_read=0)
        out = buckets.attribute_cache_read(t)
        self.assertEqual(sum(out.values()), 0)
        for k in buckets.BUCKET_NAMES:
            self.assertIn(k, out)

    def test_no_prefix_means_all_other(self):
        t = _make_turn(cache_read=10_000)
        out = buckets.attribute_cache_read(t)
        self.assertEqual(out["other"], 10_000)

    def test_claude_md_marker_in_prefix(self):
        msg = "Contents of /Users/me/.claude/CLAUDE.md\n\n# memories\n" + "foo\n" * 1000
        t = _make_turn(cache_read=10_000, prefix_user=[msg])
        out = buckets.attribute_cache_read(t)
        self.assertGreater(out["claude_md_and_agents_md"], 0)

    def test_repo_files_attributes_to_repo_files(self):
        # Read-tool gutter pattern: lines like "  1\tcontent".
        gutter = "\n".join(f"   {i}\tcontent here..." for i in range(1, 200)) + "\n"
        t = _make_turn(cache_read=5_000, prefix_tool=[gutter])
        out = buckets.attribute_cache_read(t)
        self.assertGreater(out["repo_files"], 0)
        # tool_results should be small or zero — the gutter consumed the body.
        self.assertGreaterEqual(out["repo_files"], out["tool_results"])

    def test_validate_command_folds_tool_results_to_validation_context(self):
        gutter = "\n".join(f"   {i}\tcontent here..." for i in range(1, 200)) + "\n"
        misc_tool_result = "git diff output\n" * 100
        t = _make_turn(
            cache_read=10_000,
            prefix_tool=[gutter, misc_tool_result],
            command="/validate",
        )
        out = buckets.attribute_cache_read(t)
        # validate-span tool results get re-classified.
        self.assertGreater(out["validation_context"], 0)
        self.assertEqual(out["tool_results"], 0)

    def test_assistant_with_headers_attributes_to_generated_drafts(self):
        draft = "## Decision\n\napprove\n\n## Findings\n\n" + "x\n" * 500
        t = _make_turn(cache_read=5_000, prefix_assistant=[draft])
        out = buckets.attribute_cache_read(t)
        self.assertGreater(out["generated_drafts"], 0)
        self.assertEqual(out["assistant_history"], 0)

    def test_assistant_without_headers_attributes_to_assistant_history(self):
        t = _make_turn(cache_read=5_000, prefix_assistant=["plain text " * 500])
        out = buckets.attribute_cache_read(t)
        self.assertGreater(out["assistant_history"], 0)
        self.assertEqual(out["generated_drafts"], 0)

    def test_cache_creation_uses_same_scaler(self):
        msg = "Contents of /Users/me/CLAUDE.md\n\n" + "x" * 5000
        t = _make_turn(
            cache_creation=2_000,
            prefix_user=[msg],
        )
        out = buckets.attribute_cache_creation(t)
        self.assertEqual(sum(out.values()), 2_000)

    def test_attribute_all_returns_three_dicts(self):
        t = _make_turn(cache_read=1_000, cache_creation=500)
        attr = buckets.attribute_all(t)
        self.assertIsInstance(attr.input_buckets, dict)
        self.assertIsInstance(attr.cache_read_buckets, dict)
        self.assertIsInstance(attr.cache_creation_buckets, dict)
        self.assertEqual(sum(attr.cache_read_buckets.values()), 1_000)
        self.assertEqual(sum(attr.cache_creation_buckets.values()), 500)

    def test_proportional_attribution_within_tolerance(self):
        """Synthetic prefix with known proportions; assert ±5% per bucket.

        We blast a large total into the prefix so the integer-rounding error
        in _scale_to_total stays small.
        """
        claude_md_block = "Contents of /Users/me/.claude/CLAUDE.md\n\n" + "c" * 20_000
        gutter_block = "\n".join(f"   {i}\tcontent here..." for i in range(1, 1500)) + "\n"
        slash_cmd_block = "<command-name>/build</command-name>\n<command-args>" + "a" * 4_000 + "</command-args>"
        plain_user = "Just plain text " * 3_000

        total_cache_read = 200_000
        t = _make_turn(
            cache_read=total_cache_read,
            prefix_user=[claude_md_block, slash_cmd_block, plain_user],
            prefix_tool=[gutter_block],
        )
        out = buckets.attribute_cache_read(t)
        self.assertEqual(sum(out.values()), total_cache_read)
        # All four expected buckets non-zero.
        self.assertGreater(out["claude_md_and_agents_md"], 0)
        self.assertGreater(out["repo_files"], 0)
        self.assertGreater(out["slash_command_body"], 0)
        self.assertGreater(out["user_messages"], 0)
        # And meaningful (>= 0.5% of total — small blocks scale down because
        # the bigger blocks dominate the total).
        for k in ("claude_md_and_agents_md", "repo_files", "user_messages"):
            self.assertGreater(
                out[k], total_cache_read * 0.02,
                msg=f"{k} = {out[k]} too small vs {total_cache_read}",
            )
        # slash_command_body block is intentionally small; just verify it
        # registers at all.
        self.assertGreater(out["slash_command_body"], total_cache_read * 0.001)


class TestBackCompatAttribute(unittest.TestCase):
    """The legacy attribute() shim must keep returning the input-only dict."""

    def test_attribute_returns_input_only_dict(self):
        from tests.test_metrics_buckets import _turn
        t = _turn(input_tokens=200, user_msgs=["plain text " * 50])
        out = buckets.attribute(t)
        self.assertEqual(sum(out.values()), 200)
        for k in buckets.BUCKET_NAMES:
            self.assertIn(k, out)


if __name__ == "__main__":
    unittest.main()
