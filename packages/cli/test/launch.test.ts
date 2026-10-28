import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeArgs, DEFAULT_PLAYBOOK } from "../src/launch.ts";

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
