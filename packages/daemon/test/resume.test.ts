import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { openStore } from "../src/store.ts";
import { createStacks, migrateStacks } from "../src/stacks.ts";
import { createApp } from "../src/server.ts";
import { taskRoutes } from "../src/task-routes.ts";

test("GET /api/resume finds the claude session by session id, task id prefix and repo", async () => {
  const store = openStore(":memory:");
  migrateStacks(store.db);
  const stacks = createStacks(store.db, (id) => `/home/tasks/${id}`);
  const routes = taskRoutes(stacks, {} as any, {} as any, () => null, "", store.db);
  const server = createApp(store, { home: "", startedAt: "" }, routes).listen(0);
  await new Promise((r) => server.once("listening", r));
  const get = async (q: string) => {
    const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/resume?${q}`);
    return [r.status, await r.json()] as const;
  };
  try {
    const a = store.register({ id: "sess-a", repo: "/r", worktree: "/w/a", branch: "a" });
    store.addEvent(a.id, { hook_event_name: "SessionStart", session_id: "old" });
    store.addEvent(a.id, { hook_event_name: "Stop", session_id: "claude-a" });
    store.addEvent(a.id, { hook_event_name: "Notification" });
    store.register({ id: "sess-empty", repo: "/r", worktree: "/w/e", branch: "e" });

    assert.deepEqual((await get("id=sess-a"))[1], { session_id: "sess-a", repo: "/r", worktree: "/w/a", branch: "a", at: a.started_at, claude_session_id: "claude-a" });
    const [s404, e404] = await get("id=sess-empty");
    assert.equal(s404, 404);
    assert.match(e404.error, /sess-empty/);
    assert.equal((await get("repo=/r"))[1].claude_session_id, "claude-a");

    const [task] = stacks.set({ repo: "/r", branch: "main", base: "main", tasks: [{ title: "T", claims: [{ id: "C1", text: "x" }] }] }).stack.tasks;
    const [noAttempt, err] = await get(`id=${task.id.slice(0, 8)}`);
    assert.equal(noAttempt, 404);
    assert.match(err.error, new RegExp(task.id.slice(0, 8)));
    stacks.startAttempt(task.id, a.id);
    await new Promise((r) => setTimeout(r, 5));
    const b = store.register({ id: "sess-b", repo: "/r", worktree: "/w/b", branch: "b" });
    store.addEvent(b.id, { hook_event_name: "Stop", session_id: "claude-b" });
    stacks.startAttempt(task.id, b.id);
    stacks.startAttempt(task.id, null);
    const [ok, r] = await get(`id=${task.id.slice(0, 8)}`);
    assert.equal(ok, 200);
    assert.deepEqual([r.claude_session_id, r.worktree, r.task_id], ["claude-b", "/w/b", task.id]);
    assert.equal((await get("repo=/r"))[1].claude_session_id, "claude-b");

    const [none, noneErr] = await get("id=nothing-here");
    assert.equal(none, 404);
    assert.match(noneErr.error, /nothing-here/);
    assert.equal((await get("repo=/other"))[0], 404);
  } finally {
    server.close();
    store.close();
  }
});
