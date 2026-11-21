import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store.ts";
import { RESTART_REASON, createStacks, migrateStacks } from "../src/stacks.ts";
import { createRunner, resumeStopped, STOPPED_BY_YOU, type Session } from "../src/runner.ts";
import { currentLimit, setStackLimit } from "../src/config.ts";
import { killLeftovers, setLeftoverFile } from "../src/process.ts";
import { runGate } from "../src/gate.ts";

const tasks = [1, 2, 3].map((n) => ({ title: `T${n}`, claims: [{ id: "C1", text: "x" }] }));
const make = () => {
  const store = openStore(":memory:");
  migrateStacks(store.db);
  const stacks = createStacks(store.db, (id) => `/tmp/awb-restart/${id}`);
  const { stack } = stacks.set({ repo: "/r", branch: "main", base: "main", tasks });
  return { store, stacks, stack };
};

test("stopAfterTask: the current task ends, no next task starts, the run says 'stopped by you'", async () => {
  const { stacks, stack } = make();
  let release!: () => void;
  const gate = new Promise<void>((ok) => (release = ok));
  const session: Session = async (t) => {
    await gate;
    stacks.setPr(t.id, 1, "u");
  };
  const runner = createRunner(stacks, () => session);
  const state = runner.start(stack.id);
  await new Promise((r) => setImmediate(r));
  assert.equal(runner.stopAfterTask(stack.id)?.id, state.id);
  release();
  for (let i = 0; i < 50 && state.state === "running"; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual([state.state, state.reason], ["stopped", STOPPED_BY_YOU]);
  assert.deepEqual(stacks.get(stack.id)!.tasks.map((t) => t.status), ["done", "waiting", "waiting"]);
  assert.equal(runner.stopAfterTask(stack.id), null);
});

test("the limit can be a function, so awb limit applies to the next run", () => {
  const { stacks, stack } = make();
  let max = 0;
  const runner = createRunner(stacks, () => () => new Promise(() => {}), { maxStacks: () => max });
  assert.throws(() => runner.start(stack.id), /limit is 0/);
  max = 1;
  assert.equal(runner.start(stack.id).state, "running");
});

test("config: awb limit is stored, bounded, and wins over the env default", () => {
  const home = mkdtempSync(join(tmpdir(), "awb-config-"));
  assert.equal(currentLimit(home, "3"), 3);
  assert.equal(setStackLimit(home, 4), 4);
  assert.equal(currentLimit(home, "3"), 4);
  assert.throws(() => setStackLimit(home, 6), /1 to 5/);
  assert.throws(() => setStackLimit(home, "x"), /1 to 5/);
});

test("resumeStopped: a restart-stopped run starts again from the first waiting task", () => {
  const { stacks, stack } = make();
  const [t1, t2] = stack.tasks;
  stacks.saveRun({ id: "r1", stackId: stack.id, state: "running", current: t1.id, reason: null });
  stacks.setStatus(t1.id, "done");
  stacks.setStatus(t2.id, "doing");
  stacks.recover();
  assert.equal(stacks.task(t2.id)!.fail_reason, RESTART_REASON);
  const runner = createRunner(stacks, () => () => new Promise(() => {}));
  const r = resumeStopped(stacks, runner);
  assert.equal(r.started.length, 1);
  assert.equal(r.started[0].stackId, stack.id);
  assert.equal(stacks.task(t2.id)!.status, "doing");
  assert.equal(stacks.run("r1")!.reason, "daemon restart, resumed");
  assert.deepEqual(resumeStopped(stacks, runner), { started: [], skipped: [] }, "a second call finds nothing");
});

test("leftover app servers: stop only a pid whose command still matches", () => {
  const dir = mkdtempSync(join(tmpdir(), "awb-left-"));
  const file = join(dir, "apps.json");
  setLeftoverFile(file);
  writeFileSync(file, JSON.stringify([{ pid: 2_000_000_000, cmd: "next start" }]));
  assert.equal(killLeftovers(file), 0);
  assert.equal(readFileSync(file, "utf8"), "[]");
});

test("the gate reports the Playwright start error, not 'no test'", () => {
  const input = { claims: [{ id: "C1", text: "x" }], report: { suites: [] }, head: "a", savedSha: "a", dirty: false, testHashAtStart: "h", testHashNow: "h", fileExists: () => true, startError: "Error: browserType.launch" };
  assert.deepEqual(runGate(input).rows[0].reasons, ["Playwright did not start: Error: browserType.launch"]);
  assert.deepEqual(runGate({ ...input, startError: undefined }).rows[0].reasons, ["no test"]);
});
