import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../src/store.ts";
import { createStacks, migrateStacks, parseSince, StackError } from "../src/stacks.ts";
import { failReason, runStack, type RunState } from "../src/runner.ts";
import type { GateResult } from "../src/gate.ts";

const setup = () => {
  const store = openStore(":memory:");
  migrateStacks(store.db);
  return createStacks(store.db, (id) => `/home/tasks/${id}`);
};
const t = (title: string) => ({ title, claims: [{ id: "C1", text: `${title} works` }, { id: "C2", text: "more" }] });
const gate = (pass: boolean): GateResult => ({
  pass,
  head: "abcdef1234567",
  reasons: [],
  rows: [
    { id: "C1", tests: 1, status: pass ? "PASS" : "FAIL", reasons: pass ? [] : ["not passed"], videos: [], traces: [] },
    { id: "C2", tests: 1, status: "PASS", reasons: [], videos: [], traces: [] },
  ],
});

test("parseSince takes 7d, 12h, 30m and a date, and refuses junk", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  assert.equal(parseSince("7d", now), "2026-10-23T12:00:00.000Z");
  assert.equal(parseSince("12h", now), "2026-10-30T00:00:00.000Z");
  assert.equal(parseSince("30m", now), "2026-10-30T11:30:00.000Z");
  assert.equal(parseSince("2026-10-01", now), "2026-10-01T00:00:00.000Z");
  assert.throws(() => parseSince("last week", now), StackError);
});

test("list filters by status and repo, and has the failed claims of the last gate", () => {
  const s = setup();
  const a = s.set({ repo: "/games", branch: "main", base: "main", tasks: [t("A"), t("B")] }).stack;
  const c = s.set({ repo: "/fender", branch: "x", base: "main", tasks: [t("C")] }).stack;
  const [ta] = a.tasks;
  const at = s.startAttempt(ta.id, null);
  s.saveGate(at, gate(false));
  s.fail(ta.id, "the gate failed");

  const failed = s.list({ status: ["failed"] });
  assert.deepEqual(failed.map((x) => [x.title, x.failed_claims, x.fail_reason, x.repo]), [["A", ["C1"], "the gate failed", "/games"]]);
  assert.deepEqual(s.list({ repo: "/fender" }).map((x) => x.id), [c.tasks[0].id]);
  assert.equal(s.list().length, 3);
  assert.deepEqual(s.list({ status: ["waiting", "failed"], repo: "/games" }).map((x) => x.title).sort(), ["A", "B"]);
  assert.equal(s.list({ since: "2999-01-01T00:00:00Z" }).length, 0);
});

test("find takes an id prefix of 6 or more characters", () => {
  const s = setup();
  const [x] = s.set({ repo: "/r", branch: "b", base: "main", tasks: [t("A")] }).stack.tasks;
  assert.equal(s.find(x.id.slice(0, 8))?.id, x.id);
  assert.equal(s.find("ffffffff-none"), undefined);
  assert.throws(() => s.find(x.id.slice(0, 3)), /6 or more/);
});

test("task rm removes waiting tasks, bumps the version and computes the bases again", () => {
  const s = setup();
  const { stack } = s.set({ repo: "/r", branch: "feat", base: "main", tasks: [t("A"), t("B"), t("C")] });
  const [a, b, c] = stack.tasks;
  assert.deepEqual(s.remove([b.id.slice(0, 8)]), [b.id]);
  const after = s.get(stack.id)!;
  assert.equal(after.version, 2);
  assert.deepEqual(after.tasks.map((x) => [x.id, x.position, x.base]), [[a.id, 0, "main"], [c.id, 1, a.branch]]);
});

test("task rm refuses all when one task has started", () => {
  const s = setup();
  const { stack } = s.set({ repo: "/r", branch: "feat", base: "main", tasks: [t("A"), t("B")] });
  const [a, b] = stack.tasks;
  s.setStatus(a.id, "doing");
  assert.throws(() => s.remove([b.id, a.id]), /only waiting tasks can be removed/);
  assert.equal(s.get(stack.id)!.tasks.length, 2);
  assert.equal(s.get(stack.id)!.version, 1);
});

test("the runner saves the gate failure as the reason, and a retry clears it", async () => {
  const s = setup();
  const { stack } = s.set({ repo: "/r", branch: "feat", base: "main", tasks: [t("A"), t("B")] });
  const [a] = stack.tasks;
  const state: RunState = { id: "r", stackId: stack.id, state: "running", current: null, reason: null };
  const r = await runStack(s, stack.id, async (task) => s.saveGate(s.startAttempt(task.id, null), gate(false)), state);
  const reason = "the gate failed at abcdef1234: C1 not passed";
  assert.equal(r.reason, reason);
  assert.equal(s.task(a.id)!.fail_reason, reason);
  s.retry(a.id);
  assert.deepEqual([s.task(a.id)!.status, s.task(a.id)!.fail_reason], ["waiting", null]);
});

test("failReason without a gate, and with a pass but no ship", () => {
  const s = setup();
  const [a] = s.set({ repo: "/r", branch: "b", base: "main", tasks: [t("A")] }).stack.tasks;
  assert.match(failReason(s, a.id), /never ran awb prove/);
  s.saveGate(s.startAttempt(a.id, null), gate(true));
  assert.match(failReason(s, a.id), /without awb ship/);
});
