/**
 * Unit tests for renderAdversarialReviewPrompt.
 *
 * Run: npx tsx src/server/domain/review-prompts.test.ts
 */

import { renderAdversarialReviewPrompt, type ReviewPromptWorkItem } from "./review-prompts.js";

let passed = 0;
let failed = 0;

function assertEqual(actual: string, expected: string, label: string): void {
  if (actual === expected) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.error(`  ❌ ${label}`);
    console.error("     --- expected ---");
    console.error(expected);
    console.error("     --- actual ---");
    console.error(actual);
  }
}

function assertIncludes(actual: string, needle: string, label: string): void {
  if (actual.includes(needle)) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.error(`  ❌ ${label} — missing: ${JSON.stringify(needle)}`);
  }
}

function assertNotIncludes(actual: string, needle: string, label: string): void {
  if (!actual.includes(needle)) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.error(`  ❌ ${label} — unexpectedly contained: ${JSON.stringify(needle)}`);
  }
}

const baseItem: ReviewPromptWorkItem = {
  id: "abc",
  title: "Fix login bug",
  body: "Login sometimes fails on safari.",
  acceptance_criteria: "Login works on all browsers.",
  branch_name: "fix/login",
};

console.log("renderAdversarialReviewPrompt — populated with criteria");
{
  const expected = `/codex:adversarial-review --base main challenge whether this was the right approach for Fix login bug.

Acceptance criteria:
Login works on all browsers.`;
  assertEqual(renderAdversarialReviewPrompt(baseItem), expected, "exact snapshot for populated item with criteria");

  const out = renderAdversarialReviewPrompt(baseItem);
  assertNotIncludes(out, "Task description:", "legacy 'Task description:' absent");
  assertNotIncludes(out, "Working directory:", "legacy 'Working directory:' absent");
  assertNotIncludes(out, "Branch:", "legacy 'Branch:' absent");
  assertNotIncludes(out, "Focus on:", "legacy 'Focus on:' absent");
  assertNotIncludes(out, "Constraints:", "legacy 'Constraints:' absent");
  assertNotIncludes(out, "Prefer:", "legacy 'Prefer:' absent");
  assertNotIncludes(out, "[risk area", "legacy '[risk area' placeholder absent");
  assertNotIncludes(out, "[constraint", "legacy '[constraint' placeholder absent");
  assertNotIncludes(out, "<fill in worktree path>", "legacy worktree placeholder absent");
}

console.log("renderAdversarialReviewPrompt — null acceptance criteria → invocation only");
{
  const expected = `/codex:adversarial-review --base main challenge whether this was the right approach for Fix login bug.`;
  assertEqual(
    renderAdversarialReviewPrompt({ ...baseItem, acceptance_criteria: null }),
    expected,
    "null criteria renders single invocation line",
  );
}

console.log("renderAdversarialReviewPrompt — blank acceptance criteria → invocation only");
{
  const expected = `/codex:adversarial-review --base main challenge whether this was the right approach for Fix login bug.`;
  assertEqual(
    renderAdversarialReviewPrompt({ ...baseItem, acceptance_criteria: "   " }),
    expected,
    "blank criteria renders single invocation line",
  );
}

console.log("renderAdversarialReviewPrompt — criteria surrounded by whitespace is trimmed");
{
  const out = renderAdversarialReviewPrompt({
    ...baseItem,
    acceptance_criteria: "\n\n  Works.\n",
  });
  const expected = `/codex:adversarial-review --base main challenge whether this was the right approach for Fix login bug.

Acceptance criteria:
Works.`;
  assertEqual(out, expected, "criteria trimmed");
}

console.log("renderAdversarialReviewPrompt — title with newlines is collapsed to spaces");
{
  const out = renderAdversarialReviewPrompt({ ...baseItem, title: "Fix\nlogin\r\nbug" });
  assertIncludes(
    out,
    "challenge whether this was the right approach for Fix login bug.",
    "title newlines collapsed to spaces on first line",
  );
}

console.log("renderAdversarialReviewPrompt — title with surrounding whitespace is trimmed");
{
  const out = renderAdversarialReviewPrompt({ ...baseItem, title: "  Fix bug  " });
  assertIncludes(
    out,
    "challenge whether this was the right approach for Fix bug.",
    "title trimmed on first line",
  );
}

console.log(`\nDone: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
