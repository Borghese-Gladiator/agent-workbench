import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createScheduler, isDue, migrateJobs, nextRun, parseJobs, ScheduleError, type Exec } from "../src/schedule.ts";

const job = { name: "standup", at: "10:00", prompt: "x", cwd: "/repo" };
const at = (iso: string) => new Date(iso);

function setup(exec: Exec) {
  const home = mkdtempSync(join(tmpdir(), "awb-sched-"));
  writeFileSync(join(home, "schedule.json"), JSON.stringify([job]));
  const db = new DatabaseSync(":memory:");
  migrateJobs(db);
  const s = createScheduler(home, db, () => {}, exec);
  const rows = () => (db.prepare("SELECT job, day, state, end FROM job_runs ORDER BY started_at").all() as any[]).map((r) => ({ ...r }));
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { s, rows, settle, db };
}

const ok: Exec = async () => ({ code: 0, out: "hello", timedOut: false });

test("a job is due only at or after its time, on its days, once a day", () => {
  const cases: [string, string | undefined, boolean][] = [
    ["2026-11-19T09:59:00", undefined, false],
    ["2026-11-19T10:00:00", undefined, true],
    ["2026-11-19T15:30:00", undefined, true],
    ["2026-11-19T10:00:00", "2026-11-19", false],
    ["2026-11-19T10:00:00", "2026-11-18", true],
    ["2026-11-21T10:00:00", undefined, false],
  ];
  for (const [now, last, due] of cases) assert.equal(isDue(job, at(now), last), due, `${now} last=${last}`);
});

test("nextRun skips today when it ran, and skips the weekend", () => {
  assert.equal(nextRun(job, at("2026-11-19T09:00:00"), null), at("2026-11-19T10:00:00").toISOString());
  assert.equal(nextRun(job, at("2026-11-19T11:00:00"), "2026-11-19"), at("2026-11-20T10:00:00").toISOString());
  assert.equal(nextRun(job, at("2026-11-20T11:00:00"), "2026-11-20"), at("2026-11-23T10:00:00").toISOString());
});

test("parseJobs rejects a bad name, time, prompt, day, a missing cwd or a duplicate", () => {
  const { cwd: _, ...noCwd } = job;
  const bad = [{ ...job, name: "Bad Name" }, { ...job, at: "25:00" }, { ...job, prompt: "" }, { ...job, days: [7] }, noCwd, { ...job, cwd: "" }];
  for (const j of bad) assert.throws(() => parseJobs(JSON.stringify([j])));
  assert.throws(() => parseJobs(JSON.stringify([job, job])), /two jobs/);
  assert.throws(() => parseJobs("{}"));
  assert.equal(parseJobs(JSON.stringify([job])).length, 1);
});

test("a due job writes a running row, then a done row with its output, and does not run twice in a day", async () => {
  let release!: () => void;
  const { s, rows, settle } = setup(() => new Promise((r) => (release = () => r({ code: 0, out: "hello", timedOut: false }))));
  await s.tick(at("2026-11-19T10:01:00"));
  assert.deepEqual(rows(), [{ job: "standup", day: "2026-11-19", state: "running", end: null }]);
  release();
  await settle();
  assert.deepEqual(rows(), [{ job: "standup", day: "2026-11-19", state: "done", end: "done" }]);
  assert.equal(s.output(s.runs()[0].id), "hello");
  await s.tick(at("2026-11-19T10:05:00"));
  await settle();
  assert.equal(rows().length, 1);
});

test("a done job keeps only stdout in its output, and a failed job keeps the merged stream", async () => {
  const done = setup(async () => ({ code: 0, out: "warning\ntext", stdout: "text", timedOut: false }));
  await done.s.tick(at("2026-11-19T10:01:00"));
  await done.settle();
  assert.equal(done.s.output(done.s.runs()[0].id), "text");
  const failed = setup(async () => ({ code: 3, out: "warning\nboom", stdout: "", timedOut: false }));
  await failed.s.tick(at("2026-11-19T10:01:00"));
  await failed.settle();
  assert.equal(failed.s.output(failed.s.runs()[0].id), "warning\nboom");
});

test("a failed job is recorded as failed and does not run again the same day", async () => {
  const { s, rows, settle } = setup(async () => ({ code: 3, out: "boom", timedOut: false }));
  await s.tick(at("2026-11-19T10:01:00"));
  await settle();
  assert.deepEqual(rows(), [{ job: "standup", day: "2026-11-19", state: "failed", end: "exit 3" }]);
  await s.tick(at("2026-11-19T10:05:00"));
  await settle();
  assert.equal(rows().length, 1);
});

test("a run left running by a dead daemon is marked stopped and the job runs again", async () => {
  const { s, rows, settle, db } = setup(ok);
  db.prepare("INSERT INTO job_runs (id, job, day, state, started_at) VALUES ('old', 'standup', '2026-11-19', 'running', '2026-11-19T10:00:00Z')").run();
  assert.equal(s.recover(at("2026-11-19T10:30:00")), 1);
  await s.tick(at("2026-11-19T10:31:00"));
  await settle();
  assert.deepEqual(rows().map((r) => r.state), ["stopped", "done"]);
});

test("runNow starts a job at any time, and refuses an unknown job or one that is running", async () => {
  let release!: () => void;
  const { s, rows, settle } = setup(() => new Promise((r) => (release = () => r({ code: 0, out: "", timedOut: false }))));
  s.runNow("standup", at("2026-11-21T03:00:00"));
  assert.throws(() => s.runNow("standup"), (e) => e instanceof ScheduleError && e.status === 409);
  assert.throws(() => s.runNow("nope"), (e) => e instanceof ScheduleError && e.status === 404);
  assert.equal(s.status().jobs[0].running, true);
  release();
  await settle();
  assert.equal(rows()[0].state, "done");
  assert.equal(s.status().jobs[0].last?.state, "done");
});
