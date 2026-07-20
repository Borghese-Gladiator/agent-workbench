"""Unit tests for the ASM/DR block parser in lib/cli/cmd_plan.py."""
from __future__ import annotations

import unittest

from lib.cli import cmd_plan


SINGLE_LINE_DR = """\
### DR-001
- **Decision**: use net/http.
- **Rationale**: stdlib is enough.
- **Alternatives considered**: gin, fiber.
- **Why not the alternatives**: extra dependency.
"""

MULTI_LINE_DR = """\
### DR-001
- **Decision**: keep the date in the run_id, not datetime.now(),
  so the worktree path stays idempotent across re-invocations of
  `start` for the same run.
- **Rationale**: an idempotent path is reproducible from the run record
  alone; calling now() makes the path drift if the call happens twice.
- **Alternatives considered**: pass today through as an argument.
- **Why not the alternatives**: leaks date wiring into every caller.
"""

MULTI_LINE_ASM = """\
### ASM-001
- **Text**: `make_worktree_path` is the only place the worktree dirname
  is composed; grep before the change confirmed a single caller.
- **Reason**: keeping the function signature narrow.
- **Impact**: low
"""


class TestFieldParserSingleLine(unittest.TestCase):
    def test_captures_single_line_body(self):
        out = cmd_plan._extract_decision_blocks(SINGLE_LINE_DR)
        self.assertEqual(len(out), 1)
        dr = out[0]
        self.assertEqual(dr["decision_id"], "DR-001")
        self.assertEqual(dr["decision"], "use net/http.")
        self.assertEqual(dr["rationale"], "stdlib is enough.")
        self.assertEqual(dr["alternatives_considered"], "gin, fiber.")
        self.assertEqual(dr["why_not_alternatives"], "extra dependency.")


class TestFieldParserMultiLine(unittest.TestCase):
    def test_decision_body_wraps_across_lines(self):
        out = cmd_plan._extract_decision_blocks(MULTI_LINE_DR)
        self.assertEqual(len(out), 1)
        dr = out[0]
        self.assertEqual(dr["decision_id"], "DR-001")
        # All three wrapped lines should be folded into the decision body.
        self.assertIn("keep the date in the run_id", dr["decision"])
        self.assertIn("idempotent across re-invocations", dr["decision"])
        self.assertIn("for the same run.", dr["decision"])
        # And the rationale's continuation line is captured too.
        self.assertIn("makes the path drift", dr["rationale"])

    def test_assumption_body_wraps_across_lines(self):
        out = cmd_plan._extract_assumption_blocks(MULTI_LINE_ASM)
        self.assertEqual(len(out), 1)
        asm = out[0]
        self.assertEqual(asm["assumption_id"], "ASM-001")
        self.assertIn("only place the worktree dirname", asm["text"])
        self.assertIn("single caller.", asm["text"])
        self.assertEqual(asm["impact"], "low")

    def test_continuation_does_not_leak_into_next_field(self):
        # Each `- **Label**:` boundary terminates the previous field, even
        # if the previous field had no blank line before it.
        out = cmd_plan._extract_decision_blocks(MULTI_LINE_DR)
        dr = out[0]
        # `decision` must not start mentioning the rationale.
        self.assertNotIn("Rationale", dr["decision"])
        # `rationale` must not include the alternatives bullet.
        self.assertNotIn("Alternatives considered", dr["rationale"])


if __name__ == "__main__":
    unittest.main()
