import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenTotals } from "../src/usage.ts";
import { openStore } from "../src/store.ts";

const row = (id: string, input: number, output: number) =>
  JSON.stringify({
    type: "assistant",
    message: { id, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 } },
  });

test("token totals for a session dedup rows by message.id", () => {
  const file = join(mkdtempSync(join(tmpdir(), "awb-usage-")), "t.jsonl");
  writeFileSync(
    file,
    [row("m1", 3, 7), row("m1", 3, 7), JSON.stringify({ type: "user", message: { content: "hi" } }), "not json", row("m2", 1, 2), ""].join("\n"),
  );
  assert.deepEqual(tokenTotals(file), { input: 4, output: 9, cache_read: 20, cache_creation: 10 });
});

test("the feed row has the totals and the last tool, and state follows the hooks", () => {
  const store = openStore(":memory:");
  store.register({ id: "s", repo: "/r", worktree: "/r", branch: "main" });
  assert.equal(store.feedRow("s")!.state, "idle");
  store.addEvent("s", { hook_event_name: "PreToolUse", tool_name: "Bash" });
  assert.equal(store.feedRow("s")!.state, "busy");
  store.addEvent("s", { hook_event_name: "Stop" });
  store.setUsage("s", { input: 1, output: 2, cache_read: 3, cache_creation: 4 });
  const f = store.feedRow("s")!;
  assert.equal(f.state, "idle");
  assert.equal(f.last_tool, "Bash");
  assert.deepEqual(f.usage, { input: 1, output: 2, cache_read: 3, cache_creation: 4 });
  store.end("s", 0);
  assert.equal(store.feedRow("s")!.state, "ended");
});
