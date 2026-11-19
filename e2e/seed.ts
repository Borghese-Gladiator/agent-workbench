import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "../packages/daemon/src/store.ts";
import { createStacks, migrateStacks } from "../packages/daemon/src/stacks.ts";

const home = process.argv[2];
if (!home) throw new Error("usage: node e2e/seed.ts <folder>");
mkdirSync(home, { recursive: true });
const store = openStore(join(home, "awb.db"));
migrateStacks(store.db);
const stacks = createStacks(store.db, (id) => join(home, "tasks", id));

const repo = "/tmp/seed-repo";
const session = store.register({ id: "seed-session", repo, worktree: repo, branch: "awb/seed-done", pid: null });
for (const [hook, tool, input] of [
  ["PreToolUse", "Bash", { command: "npm test" }],
  ["PostToolUse", "Bash", { command: "npm test" }],
  ["PreToolUse", "Edit", { file_path: "src/app.ts" }],
  ["PostToolUse", "Edit", { file_path: "src/app.ts" }],
] as const) {
  store.addEvent(session.id, { hook_event_name: hook, tool_name: tool, tool_input: input, cwd: repo });
}
store.addEvent(session.id, { hook_event_name: "Stop", cwd: repo });
store.setUsage(session.id, { input: 1200, output: 300, cache_read: 5000, cache_creation: 800, cost_usd: 0.42 });
store.end(session.id, 0);

const { stack } = stacks.set({
  repo,
  branch: "awb/seed-done",
  base: "main",
  tasks: [
    { title: "Seed done task", claims: [{ id: "C1", text: "The page shows Hello" }] },
    { title: "Seed failed task", claims: [{ id: "C1", text: "The page shows Bye" }, { id: "C2", text: "Reset clears the list" }] },
  ],
});
const [done, failed] = stack.tasks;

const ok = stacks.startAttempt(done.id, session.id);
stacks.saveGate(ok, { pass: true, head: "a".repeat(40), reasons: [], rows: [{ id: "C1", tests: 1, status: "PASS", reasons: [], videos: [], traces: [] }] });
stacks.endAttempt(ok);
stacks.setStatus(done.id, "done");

const bad = stacks.startAttempt(failed.id, null);
stacks.saveGate(bad, {
  pass: false,
  head: "b".repeat(40),
  reasons: [],
  rows: [
    { id: "C1", tests: 1, status: "PASS", reasons: [], videos: [], traces: [] },
    { id: "C2", tests: 1, status: "FAIL", reasons: ["not passed"], videos: [], traces: [] },
  ],
});
stacks.endAttempt(bad);
stacks.fail(failed.id, "C2: not passed");

stacks.set({
  repo: "/tmp/seed-repo-2",
  branch: "awb/seed-waiting",
  base: "main",
  tasks: [{ title: "Seed waiting task", claims: [{ id: "C1", text: "The page shows Hi" }] }],
});
store.close();
