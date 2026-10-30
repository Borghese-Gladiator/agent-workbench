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
