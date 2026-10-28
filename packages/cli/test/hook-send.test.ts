import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eventBody, sendHook, HOOK_EVENTS } from "../src/hook-send.ts";
import { openStore } from "../../daemon/src/store.ts";
import { createApp } from "../../daemon/src/server.ts";

const HOOK_BIN = fileURLToPath(new URL("../bin/awb-hook", import.meta.url));
const newHome = () => realpathSync(mkdtempSync(join(tmpdir(), "awb-hook-")));

const store = openStore(":memory:");
const app = createApp(store, { home: "/h", startedAt: "x" });
await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
const home = newHome();
writeFileSync(join(home, "daemon.json"), JSON.stringify({ pid: process.pid, port: (app.address() as AddressInfo).port }));
after(() => app.close());

for (const hook of HOOK_EVENTS) {
  test(`${hook} maps to one event row`, async () => {
    const s = store.register({ id: `s-${hook}`, repo: "/r", worktree: "/r/wt", branch: "feat" });
    const tool = hook.endsWith("ToolUse") ? { tool_name: "Bash", tool_input: { command: "ls" } } : {};
    const payload = { hook_event_name: hook, session_id: "claude-1", cwd: "/r/wt", ...tool };
    assert.equal(await sendHook(JSON.stringify(payload), { AWB_HOME: home, AWB_SESSION_ID: s.id }), true);

    const [ev, ...more] = store.events(s.id);
    assert.equal(more.length, 0);
    assert.equal(ev.hook, hook);
    assert.equal(ev.repo, "/r");
    assert.equal(ev.worktree, "/r/wt");
    assert.equal(ev.branch, "feat");
    assert.equal(ev.claude_session_id, "claude-1");
    assert.equal(ev.tool_name, hook.endsWith("ToolUse") ? "Bash" : null);
    assert.deepEqual(JSON.parse(ev.payload), payload);
  });
}

test("bad JSON on stdin is still recorded, not dropped", () => {
  const b = eventBody("not json", "s1");
  assert.equal((b.payload as any).hook_event_name, "unparsed");
});

for (const [name, env] of [
  ["the daemon is down", { AWB_HOME: newHome(), AWB_SESSION_ID: "x" }],
  ["AWB_SESSION_ID is not set", { AWB_HOME: home }],
  ["the session is unknown to the daemon", { AWB_HOME: home, AWB_SESSION_ID: "nope" }],
] as const) {
  test(`the hook sender exits 0 with no output when ${name}`, () => {
    const t = Date.now();
    const r = spawnSync(HOOK_BIN, { input: '{"hook_event_name":"Stop"}', env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    assert.ok(Date.now() - t < 3000, "it exits fast");
  });
}

test("sendHook returns false when daemon.json names a port with no listener", async () => {
  const dead = newHome();
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  writeFileSync(join(dead, "daemon.json"), JSON.stringify({ pid: 1, port }));
  assert.equal(await sendHook("{}", { AWB_HOME: dead, AWB_SESSION_ID: "x" }), false);
});
