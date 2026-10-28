import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awbHome, ensureDaemon, findDaemon, readDaemonInfo } from "../src/home.ts";

const homes: string[] = [];
const newHome = () => {
  const h = realpathSync(mkdtempSync(join(tmpdir(), "awb-test-")));
  homes.push(h);
  return h;
};

after(async () => {
  for (const h of homes) {
    const d = await findDaemon(h);
    if (d) process.kill(d.pid, "SIGTERM");
  }
});

test("AWB_HOME defaults to ~/.awb", () => {
  assert.match(awbHome({}), /\/\.awb$/);
  assert.equal(awbHome({ AWB_HOME: "/tmp/x" }), "/tmp/x");
});

test("daemon.json is written by the daemon and read by the CLI", async () => {
  const home = newHome();
  const d = await ensureDaemon(home);
  assert.deepEqual(readDaemonInfo(home), d);
  assert.ok(d.port > 0);
});

test("a stale daemon.json makes the CLI start a new daemon", async () => {
  const home = newHome();
  writeFileSync(join(home, "daemon.json"), JSON.stringify({ pid: 999999, port: 1, startedAt: "x" }));
  assert.equal(await findDaemon(home), null);
  const d = await ensureDaemon(home);
  assert.notEqual(d.pid, 999999);
  assert.equal((await findDaemon(home))?.pid, d.pid);
});

test("a live pid on a port that is not our daemon counts as stale", async () => {
  const home = newHome();
  writeFileSync(join(home, "daemon.json"), JSON.stringify({ pid: process.pid, port: 1, startedAt: "x" }));
  assert.equal(await findDaemon(home), null);
});

test("many CLIs that start at once share one daemon", async () => {
  const home = newHome();
  const all = await Promise.all(Array.from({ length: 5 }, () => ensureDaemon(home)));
  assert.equal(new Set(all.map((d) => d.pid)).size, 1);
});

test("two AWB_HOME folders give two daemons on two ports", async () => {
  const [a, b] = [newHome(), newHome()];
  const [da, db] = await Promise.all([ensureDaemon(a), ensureDaemon(b)]);
  assert.notEqual(da.pid, db.pid);
  assert.notEqual(da.port, db.port);
  assert.equal((await ensureDaemon(a)).pid, da.pid, "a second call reuses the daemon");
});
