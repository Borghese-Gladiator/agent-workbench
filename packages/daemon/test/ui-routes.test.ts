import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchDiff, proofFile } from "../src/task-routes.ts";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "awb-ui-")));

test("proofFile serves only real files inside AWB_HOME/tasks", () => {
  const home = tmp();
  const video = join(home, "tasks", "t1", "proof", "v.webm");
  mkdirSync(join(home, "tasks", "t1", "proof"), { recursive: true });
  writeFileSync(video, "x");
  writeFileSync(join(home, "awb.db"), "secret");
  const outside = join(tmp(), "o.txt");
  writeFileSync(outside, "o");
  symlinkSync(outside, join(home, "tasks", "t1", "link.txt"));

  assert.equal(proofFile(home, video), video);
  assert.equal(proofFile(home, join(home, "tasks", "t1", "..", "..", "awb.db")), null);
  assert.equal(proofFile(home, join(home, "awb.db")), null);
  assert.equal(proofFile(home, join(home, "tasks", "t1", "link.txt")), null);
  assert.equal(proofFile(home, outside), null);
  assert.equal(proofFile(home, join(home, "tasks", "t1")), null, "a folder is not a file");
  assert.equal(proofFile(home, join(home, "tasks", "nope.webm")), null);
});

test("branchDiff gives the diff of the branch against its base", () => {
  const repo = tmp();
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=t", "-c", "core.hooksPath=/dev/null", ...a], { cwd: repo });
  g("init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  g("add", ".");
  g("commit", "-qm", "a");
  g("checkout", "-q", "-b", "awb/x");
  writeFileSync(join(repo, "b.txt"), "b\n");
  g("add", ".");
  g("commit", "-qm", "b");
  const d = branchDiff(repo, "main", "awb/x");
  assert.match(d, /\+\+\+ b\/b\.txt/);
  assert.doesNotMatch(d, /a\.txt/);
  assert.equal(branchDiff(repo, "main", "no-such-branch"), "");
});

test("costOf takes the last running total, not the sum of the result rows", async () => {
  const { costOf } = await import("../src/task-routes.ts");
  const dir = tmp();
  const f = join(dir, "w.jsonl");
  const row = (c: number) => JSON.stringify({ type: "result", subtype: "success", total_cost_usd: c });
  writeFileSync(f, [row(0.5), '{"type":"assistant"}', row(1.5), row(1.5)].join("\n"));
  assert.equal(costOf(f), 1.5);
});

test("uiAsset serves UI modules as plain JavaScript and refuses paths outside the UI folder", async () => {
  const { uiAsset } = await import("../src/server.ts");
  const app = uiAsset("app.ts")!;
  assert.match(app.type, /^text\/javascript/);
  assert.doesNotMatch(app.body, /: Data\b|as Json|<string>/);
  assert.equal(uiAsset("vendor/htm-preact.js")?.type, "text/javascript; charset=utf-8");
  for (const bad of ["../src/store.ts", "..%2Fsrc%2Fstore.ts", "/etc/passwd.ts", "vendor/../../src/store.ts", "nope.ts", "index.html"]) {
    assert.equal(uiAsset(bad), null, bad);
  }
});
