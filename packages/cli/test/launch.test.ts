import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { claudeArgs, awbSettings, DEFAULT_PLAYBOOK, SKILLS_DIR, PLUGIN_DIR } from "../src/launch.ts";
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

test("settings deny gh pr create and writes to the daemon files and the proof, not to the worktrees", () => {
  const deny = awbSettings("/h/.awb").permissions.deny;
  assert.deepEqual(deny, [
    "Bash(gh pr create:*)",
    "Edit(//h/.awb/awb.db*)",
    "Edit(//h/.awb/daemon.json)",
    "Edit(//h/.awb/tasks/**)",
  ]);
  assert.ok(!deny.some((r) => r.includes("worktrees")));
});

for (const passThrough of [["--resume"], ["--resume", "abc"], ["-p", "hello world"], []]) {
  test(`pass-through ${JSON.stringify(passThrough)} reaches claude unchanged and last`, () => {
    const args = claudeArgs(passThrough, DEFAULT_PLAYBOOK, { env: { AWB_HOME: "/h" } });
    assert.deepEqual(args.slice(6), passThrough);
    assert.deepEqual(args.slice(4, 6), ["--plugin-dir", PLUGIN_DIR]);
    assert.ok(existsSync(join(PLUGIN_DIR, ".claude-plugin", "plugin.json")));
    assert.equal(args[0], "--append-system-prompt");
    assert.match(args[1], /awb playbook/);
    assert.equal(args[2], "--settings");
    assert.deepEqual(JSON.parse(args[3]), { env: { AWB_HOME: "/h" } });
  });
}

test("the playbook points UI work at the build-ui skill by a real path", () => {
  const prompt = claudeArgs([], DEFAULT_PLAYBOOK, {})[1];
  assert.ok(!prompt.includes("{skills}"));
  const skill = join(SKILLS_DIR, "build-ui.md");
  assert.ok(prompt.includes(skill));
  for (const f of [skill, join(SKILLS_DIR, "theme", "globals.css"), join(SKILLS_DIR, "theme", "design.md")]) assert.ok(existsSync(f), f);
});
