import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeArgs, awbSettings, DEFAULT_PLAYBOOK } from "../src/launch.ts";
import { HOOK_EVENTS } from "../src/hook-send.ts";

test("settings register the hook sender for every hook type, with AWB_HOME", () => {
  const s = awbSettings("/h", "/opt/it's/awb-hook");
  assert.deepEqual(s.env, { AWB_HOME: "/h" });
  assert.deepEqual(Object.keys(s.hooks), [...HOOK_EVENTS]);
  for (const [name, [entry]] of Object.entries(s.hooks)) {
    assert.equal(entry.hooks[0].command, `'/opt/it'\\''s/awb-hook'`);
    assert.equal("matcher" in entry, name.endsWith("ToolUse"));
  }
});

for (const passThrough of [["--resume"], ["--resume", "abc"], ["-p", "hello world"], []]) {
  test(`pass-through ${JSON.stringify(passThrough)} reaches claude unchanged and last`, () => {
    const args = claudeArgs(passThrough, DEFAULT_PLAYBOOK, { env: { AWB_HOME: "/h" } });
    assert.deepEqual(args.slice(4), passThrough);
    assert.equal(args[0], "--append-system-prompt");
    assert.match(args[1], /awb playbook/);
    assert.equal(args[2], "--settings");
    assert.deepEqual(JSON.parse(args[3]), { env: { AWB_HOME: "/h" } });
  });
}
