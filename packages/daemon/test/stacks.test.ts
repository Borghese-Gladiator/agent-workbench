import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../src/store.ts";
import { createStacks, migrateStacks, validateTasks, StackError } from "../src/stacks.ts";

const setup = () => {
  const store = openStore(":memory:");
  migrateStacks(store.db);
  return createStacks(store.db, (id) => `/home/tasks/${id}`);
};
const task = (title = "Scoreboard", claims = [{ id: "C1", text: "shows 0" }]) => ({ title, claims });
const where = { repo: "/r", branch: "awb/x", base: "main" };

test("create a stack of one, bound to the branch", () => {
  const s = setup();
  const { stack, changes } = s.set({ ...where, tasks: [task()] });
  assert.equal(stack.version, 1);
  assert.equal(stack.tasks.length, 1);
  const [t] = stack.tasks;
  assert.equal(t.status, "waiting");
  assert.equal(t.branch, "awb/x");
  assert.equal(t.folder, `/home/tasks/${t.id}`);
  assert.deepEqual(changes.added, [t.id]);
  assert.equal(s.taskForBranch("/r", "awb/x")?.id, t.id);
  assert.equal(s.taskForBranch("/other", "awb/x"), undefined);
});

test("replace a waiting task: the change is listed and the version goes up", () => {
  const s = setup();
  const { stack } = s.set({ ...where, tasks: [task()] });
  const id = stack.tasks[0].id;
  const r = s.set({ ...where, stackId: stack.id, version: 1, tasks: [{ id, ...task("Scoreboard v2") }] });
  assert.deepEqual(r.changes.changed, [id]);
  assert.equal(r.stack.version, 2);
  assert.equal(r.stack.tasks[0].title, "Scoreboard v2");

  const same = s.set({ ...where, stackId: stack.id, version: 2, tasks: [{ id, ...task("Scoreboard v2") }] });
  assert.equal(same.stack.version, 2, "no change, no new version");
});

for (const [name, run, msg] of [
  [
    "a change to a started task",
    (s: ReturnType<typeof setup>, stackId: string, id: string) => {
      s.setStatus(id, "doing");
      s.set({ ...where, stackId, version: 1, tasks: [{ id, ...task("new title") }] });
    },
    /only waiting tasks can change/,
  ],
  [
    "the removal of a started task",
    (s: ReturnType<typeof setup>, stackId: string, id: string) => {
      s.setStatus(id, "doing");
      s.set({ ...where, stackId, version: 1, tasks: [task("other")] });
    },
    /only waiting tasks can be removed/,
  ],
  ["a stale version", (s: ReturnType<typeof setup>, stackId: string, id: string) => s.set({ ...where, stackId, version: 7, tasks: [{ id, ...task() }] }), /stale stack version/],
  ["a second task on a branch that has one", (s: ReturnType<typeof setup>) => s.set({ ...where, tasks: [task()] }), /already has task/],
] as const) {
  test(`refuses ${name}, and changes nothing`, () => {
    const s = setup();
    const { stack } = s.set({ ...where, tasks: [task()] });
    const id = stack.tasks[0].id;
    assert.throws(() => run(s, stack.id, id), (e: unknown) => e instanceof StackError && msg.test(e.message));
    const after = s.get(stack.id)!;
    assert.equal(after.version, 1);
    assert.equal(after.tasks.length, 1);
    assert.equal(after.tasks[0].title, "Scoreboard");
  });
}

for (const [name, tasks] of [
  ["no tasks", []],
  ["no title", [{ title: " ", claims: [{ id: "C1", text: "x" }] }]],
  ["no claims", [{ title: "t", claims: [] }]],
  ["a bad claim id", [{ title: "t", claims: [{ id: "one", text: "x" }] }]],
  ["a duplicate claim id", [{ title: "t", claims: [{ id: "C1", text: "x" }, { id: "C1", text: "y" }] }]],
] as const) {
  test(`validation refuses ${name}`, () => {
    assert.throws(() => validateTasks(tasks), StackError);
  });
}

test("attempts and gate results are kept for each try", () => {
  const s = setup();
  const { stack } = s.set({ ...where, tasks: [task()] });
  const id = stack.tasks[0].id;
  const a = s.startAttempt(id, null);
  s.saveGate(a, { pass: false, rows: [], head: "abc", reasons: ["x"] });
  s.endAttempt(a);
  const [h] = s.history(id);
  assert.equal(h.gates[0].pass, false);
  assert.equal(h.gates[0].commit_sha, "abc");
  assert.ok(h.ended_at);
});

test("ship saves the PR and sets done; a closed task still shows, and the branch can take a new task", () => {
  const s = setup();
  const { stack } = s.set({ ...where, tasks: [task()] });
  const id = stack.tasks[0].id;
  s.setPr(id, 51, "https://gh/pr/51");
  assert.deepEqual(s.shipped().map((t) => [t.id, t.pr_number, t.repo]), [[id, 51, "/r"]]);
  assert.equal(s.task(id)?.status, "done");
  s.setStatus(id, "closed");
  assert.equal(s.shipped().length, 0);
  assert.equal(s.taskForBranch("/r", "awb/x")?.status, "closed");
  const next = s.set({ ...where, tasks: [task("Again")] });
  assert.equal(s.taskForBranch("/r", "awb/x")?.id, next.stack.tasks[0].id);
});
