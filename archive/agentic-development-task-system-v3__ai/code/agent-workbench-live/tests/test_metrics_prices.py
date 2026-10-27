"""Unit tests for lib.metrics.prices."""
from __future__ import annotations

import io
import pathlib
import sys
import tempfile
import unittest

from lib.metrics import prices


GOOD = """schema_version: 1
models:
  claude-opus-4-7:
    input_per_mtok: 15.0
    output_per_mtok: 75.0
    cache_read_per_mtok: 1.5
    cache_creation_per_mtok: 18.75
"""


class TestLoad(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="aw-prices-"))
        prices.reset_warning_cache()

    def _write(self, body: str) -> pathlib.Path:
        p = self.tmp / "prices.yaml"
        p.write_text(body)
        return p

    def test_valid_file(self):
        table = prices.load(self._write(GOOD))
        self.assertIn("claude-opus-4-7", table)
        self.assertEqual(table["claude-opus-4-7"].input_per_mtok, 15.0)
        self.assertEqual(table["claude-opus-4-7"].cache_read_per_mtok, 1.5)

    def test_missing_file(self):
        with self.assertRaises(prices.PricesError):
            prices.load(self.tmp / "missing.yaml")

    def test_missing_models_key(self):
        body = "schema_version: 1\n"
        with self.assertRaises(prices.PricesError):
            prices.load(self._write(body))

    def test_negative_rate_rejected(self):
        body = """schema_version: 1
models:
  m1:
    input_per_mtok: -1
    output_per_mtok: 1
    cache_read_per_mtok: 1
    cache_creation_per_mtok: 1
"""
        with self.assertRaises(prices.PricesError):
            prices.load(self._write(body))

    def test_missing_rate_key(self):
        body = """schema_version: 1
models:
  m1:
    input_per_mtok: 1
    output_per_mtok: 1
    cache_read_per_mtok: 1
"""
        with self.assertRaises(prices.PricesError):
            prices.load(self._write(body))


class TestCost(unittest.TestCase):
    def setUp(self):
        prices.reset_warning_cache()
        self.table = {
            "m1": prices.Rates(
                input_per_mtok=15.0,
                output_per_mtok=75.0,
                cache_read_per_mtok=1.5,
                cache_creation_per_mtok=18.75,
            )
        }

    def test_zero_usage_zero_cost(self):
        c = prices.cost_usd({"input_tokens": 0, "output_tokens": 0,
                             "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
                            "m1", self.table)
        self.assertEqual(c, 0.0)

    def test_basic_math(self):
        c = prices.cost_usd({
            "input_tokens": 1_000_000,
            "output_tokens": 0,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
        }, "m1", self.table)
        self.assertAlmostEqual(c, 15.0, places=6)

    def test_unknown_model_warns_once_and_returns_zero(self):
        # Capture stderr.
        buf = io.StringIO()
        old = sys.stderr
        sys.stderr = buf
        try:
            c1 = prices.cost_usd(
                {"input_tokens": 100, "output_tokens": 0,
                 "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
                "claude-mystery-9", self.table,
            )
            c2 = prices.cost_usd(
                {"input_tokens": 200, "output_tokens": 0,
                 "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
                "claude-mystery-9", self.table,
            )
        finally:
            sys.stderr = old
        self.assertEqual(c1, 0.0)
        self.assertEqual(c2, 0.0)
        # Should warn once, not twice.
        self.assertEqual(buf.getvalue().count("claude-mystery-9"), 1)

    def test_empty_model_string_no_warning(self):
        buf = io.StringIO()
        old = sys.stderr
        sys.stderr = buf
        try:
            c = prices.cost_usd(
                {"input_tokens": 100, "output_tokens": 0,
                 "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
                "", self.table,
            )
        finally:
            sys.stderr = old
        self.assertEqual(c, 0.0)
        # No warning for empty model.
        self.assertNotIn("unknown model", buf.getvalue())


if __name__ == "__main__":
    unittest.main()
