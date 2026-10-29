import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../src/store.ts";
import { createStacks, migrateStacks, taskBranch } from "../src/stacks.ts";
import { runStack, taskPrompt, type RunState, type Session } from "../src/runner.ts";

const setup = () => {
  const store = openStore(":memory:");
  migrateStacks(store.db);
  return createStacks(store.db, (id) => `/home/tasks/${id}`);
};
const where = { repo: "/r", branch: "main", base: "main" };
const three = ["Accounts", "Save results", "Leaderboard"].map((title) => ({ title, claims: [{ id: "C1", text: `${title} works` }] }));
const state = (stackId: string): RunState => ({ id: "run", stackId, state: "running", current: null, reason: null });

test("a stack of three: one branch for each task, and the bases form a chain", () => {
  const s = setup();
  const { stack } = s.set({ ...where, tasks: three });
  const [a, b, c] = stack.tasks;
  assert.equal(a.branch, taskBranch("Accounts", a.id));
  assert.match(a.branch!, /^awb\/accounts-[0-9a-f]{6}$/);
  assert.deepEqual([a.base, b.base, c.base], ["main", a.branch, b.branch]);
  assert.equal(stack.base, "main");
});

test("a replace that moves a waiting task computes the bases again", () => {
  const s = setup();
  const { stack } = s.set({ ...where, tasks: three });
  const [a, b, c] = stack.tasks;
  const r = s.set({ ...where, stackId: stack.id, version: 1, tasks: [a, c, b].map(({ id, title, claims }) => ({ id, title, claims })) });
  const [x, y, z] = r.stack.tasks;
  assert.deepEqual([x.id, y.id, z.id], [a.id, c.id, b.id]);
  assert.deepEqual([x.base, y.base, z.base], ["main", a.branch, c.branch]);
});

test("a new task in a replace gets its own branch on top", () => {
  const s = setup();
  const { stack } = s.set({ ...where, tasks: three.slice(0, 2) });
  const r = s.set({ ...where, stackId: stack.id, version: 1, tasks: [...stack.tasks.map(({ id, title, claims }) => ({ id, title, claims })), three[2]] });
  const [, b, c] = r.stack.tasks;
  assert.match(c.branch!, /^awb\/leaderboard-/);
  assert.equal(c.base, b.branch);
});

const shipping = (s: ReturnType<typeof setup>, fail: Set<string>, seen: string[]): Session => async (task) => {
  seen.push(task.title);
  if (!fail.has(task.title)) s.setPr(task.id, seen.length, `https://gh/pr/${seen.length}`);
};

test("the runner does all three tasks in order", async () => {
  const s = setup();
  const { stack } = s.set({ ...where, tasks: three });
  const seen: string[] = [];
  const r = await runStack(s, stack.id, shipping(s, new Set(), seen), state(stack.id));
  assert.deepEqual(seen, ["Accounts", "Save results", "Leaderboard"]);
  assert.equal(r.state, "done");
  assert.deepEqual(s.get(stack.id)!.tasks.map((t) => t.status), ["done", "done", "done"]);
});

test("a task with no PR fails and stops the stack; a retry continues it", async () => {
  const s = setup();
  const { stack } = s.set({ ...where, tasks: three });
  const seen: string[] = [];
  const fail = new Set(["Save results"]);
  const r = await runStack(s, stack.id, shipping(s, fail, seen), state(stack.id));
  assert.deepEqual(seen, ["Accounts", "Save results"]);
  assert.equal(r.state, "stopped");
  assert.equal(r.current, stack.tasks[1].id);
  assert.deepEqual(s.get(stack.id)!.tasks.map((t) => t.status), ["done", "failed", "waiting"]);

  const again = await runStack(s, stack.id, shipping(s, fail, seen), state(stack.id));
  assert.equal(again.state, "stopped", "a failed task is not run again without a retry");
  assert.equal(seen.length, 2);

  fail.clear();
  s.setStatus(stack.tasks[1].id, "waiting");
  const retry = await runStack(s, stack.id, shipping(s, fail, seen), state(stack.id));
  assert.deepEqual(seen.slice(2), ["Save results", "Leaderboard"]);
  assert.equal(retry.state, "done");
});

test("a session that throws marks the task failed with the reason", async () => {
  const s = setup();
  const { stack } = s.set({ ...where, tasks: three });
  const r = await runStack(s, stack.id, async () => { throw new Error("git worktree add failed"); }, state(stack.id));
  assert.equal(r.reason, "git worktree add failed");
  assert.equal(s.get(stack.id)!.tasks[0].status, "failed");
});

test("the task prompt has the claims and the titles of the tasks below", () => {
  const s = setup();
  const { stack } = s.set({ ...where, tasks: three });
  const [a, b, c] = stack.tasks;
  const p = taskPrompt(c, [a, b]);
  assert.match(p, /"Leaderboard"/);
  assert.match(p, /- C1: Leaderboard works/);
  assert.match(p, /below this one are done.*"Accounts", "Save results"/);
  assert.match(p, new RegExp(`branch ${c.branch}`));
  assert.match(taskPrompt(a, []), /first task of the stack/);
});
