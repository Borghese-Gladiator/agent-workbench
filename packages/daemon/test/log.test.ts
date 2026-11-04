import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLog, expire, keepDays, logText, readLog, redact, rotatedFiles } from "../src/log.ts";
import { reportCliError } from "../../cli/src/home.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "awb-log-"));

test("each call writes one JSON line with ts, level, source and event, and drops empty fields", () => {
  const dir = tmp();
  const log = createLog(dir);
  log("info", "runner", "run.start", { run: "r1", task: undefined, reason: null });
  log("error", "prove", "error", { task: "t1", error: new Error("app did not start") });
  const raw = readFileSync(join(dir, "awb.jsonl"), "utf8").trim().split("\n");
  assert.equal(raw.length, 2);
  const [a, b] = raw.map((l) => JSON.parse(l));
  assert.match(a.ts, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual({ ...a, ts: "" }, { ts: "", level: "info", source: "runner", event: "run.start", run: "r1" });
  assert.equal(b.error, "app did not start", "an Error becomes its message");
});

test("a secret in any field is removed before it reaches the file", () => {
  const dir = tmp();
  const key = "sk-ant-" + "a".repeat(30);
  createLog(dir)("warn", "cli", "error", { error: `bad token ${key}`, nested: { t: "ghp_" + "b".repeat(36) } });
  const text = readFileSync(join(dir, "awb.jsonl"), "utf8");
  assert.ok(!text.includes(key) && !text.includes("ghp_"));
  assert.match(text, /\[Anthropic key removed\]/);
  assert.match(text, /\[GitHub token removed\]/);
  assert.equal(redact("nothing here"), "nothing here");
});

test("readLog filters by task prefix, level and above, source and time, and keeps the order", () => {
  const dir = tmp();
  const log = createLog(dir);
  log("debug", "runner", "a", { task: "abc123" });
  log("info", "runner", "b", { task: "abc123" });
  log("warn", "prove", "c", { task: "abc123" });
  log("error", "ship", "d", { task: "zzz999" });
  const events = (f: Parameters<typeof readLog>[1]) => readLog(dir, f).map((l) => l.event).join("");
  assert.equal(events({}), "abcd");
  assert.equal(events({ task: "abc" }), "abc");
  assert.equal(events({ level: "warn" }), "cd");
  assert.equal(events({ source: "runner" }), "ab");
  assert.equal(events({ since: "2999-01-01" }), "");
  assert.equal(events({ limit: 2 }), "cd", "the limit keeps the newest lines");
});

test("rotation starts a new file at the size limit, and readLog reads the rotated files oldest first", () => {
  const dir = tmp();
  const log = createLog(dir, { maxBytes: 200 });
  for (let i = 0; i < 12; i++) log("info", "runner", `e${i}`, { pad: "x".repeat(60) });
  assert.ok(readdirSync(dir).length > 1, "the log rotated");
  assert.deepEqual(readLog(dir).map((l) => l.event), Array.from({ length: 12 }, (_, i) => `e${i}`));
});

test("logText gives one readable line with short ids", () => {
  const s = logText({ ts: "2026-11-04T10:00:00.000Z", level: "error", source: "runner", event: "task.failed", task: "0e751a8c-1234", run: "7f2c9d10-aaaa", reason: "timeout" });
  assert.equal(s, "2026-11-04 10:00:00 ERROR runner.task.failed task=0e751a8c run=7f2c9d10 reason=timeout");
});

test("a CLI error goes to the log file when the daemon is down", async () => {
  const home = tmp();
  assert.equal(await reportCliError(home, "prove", 1, "no task on this branch"), "file");
  const [line] = readLog(join(home, "logs"));
  assert.equal(line.source, "cli");
  assert.equal(line.level, "error");
  assert.equal(line.command, "prove");
  assert.equal(line.error, "no task on this branch");
});

test("rotation keeps every file by default: the expiration setting is none", () => {
  const dir = tmp();
  const log = createLog(dir, { maxBytes: 100, keepDays: null });
  for (let i = 0; i < 30; i++) log("info", "runner", `e${i}`, { pad: "x".repeat(60) });
  const files = rotatedFiles(dir);
  assert.ok(files.length >= 20, `only ${files.length} rotated files`);
  assert.ok(files.every((f) => /^awb\.\d{8}T\d{9}Z(-\d+)?\.jsonl$/.test(f)), "a rotated file keeps one fixed name");
  assert.equal(readLog(dir).length, 30, "no line is lost");
});

test("AWB_LOG_KEEP_DAYS is none unless set, and only then deletes rotated files older than N days", () => {
  assert.equal(keepDays({}), null);
  assert.equal(keepDays({ AWB_LOG_KEEP_DAYS: "none" }), null);
  assert.equal(keepDays({ AWB_LOG_KEEP_DAYS: "0" }), null);
  assert.equal(keepDays({ AWB_LOG_KEEP_DAYS: "abc" }), null);
  assert.equal(keepDays({ AWB_LOG_KEEP_DAYS: "90" }), 90);

  const dir = tmp();
  const old = join(dir, "awb.20250101T000000000Z.jsonl");
  const recent = join(dir, "awb.20261101T000000000Z.jsonl");
  writeFileSync(old, "{}\n");
  writeFileSync(recent, "{}\n");
  writeFileSync(join(dir, "awb.jsonl"), "{}\n");
  const now = Date.parse("2026-11-04T00:00:00Z");
  utimesSync(old, new Date("2025-01-01"), new Date("2025-01-01"));
  utimesSync(recent, new Date("2026-11-01"), new Date("2026-11-01"));

  assert.deepEqual(expire(dir, null, now), [], "none deletes nothing");
  assert.equal(readdirSync(dir).length, 3);
  assert.deepEqual(expire(dir, 30, now), ["awb.20250101T000000000Z.jsonl"]);
  assert.deepEqual(readdirSync(dir).sort(), ["awb.20261101T000000000Z.jsonl", "awb.jsonl"], "the current file is never deleted");
});
