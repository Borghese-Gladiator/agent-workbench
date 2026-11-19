import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { awb, git, makeWork } from "./harness.ts";

const work = makeWork();
const wt = join(work.dir, "wt");
const env = { ...process.env, AWB_HOME: join(work.dir, "home"), AWB_WORKTREES: wt };

before(async () => {
  for (const r of ["alpha", "beta"]) {
    mkdirSync(join(work.dir, r));
    await git(join(work.dir, r), "init", "-q", "-b", "main");
    await git(join(work.dir, r), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  }
  await git(join(work.dir, "alpha"), "worktree", "add", "-q", "-b", "feat/one", join(wt, "alpha", "feat-one"));
  await git(join(work.dir, "alpha"), "worktree", "add", "-q", "-b", "feat/two", join(wt, "alpha", "feat-two"));
  await git(join(work.dir, "beta"), "worktree", "add", "-q", "-b", "fix/x", join(wt, "beta", "fix-x"));
  writeFileSync(join(wt, "alpha", "feat-two", "dirty.txt"), "");
  mkdirSync(join(wt, "beta", "leftover"));
});

after(() => work.remove());

test("list groups by repo, shows branch, changes and plain folders", async () => {
  const { stdout } = await awb(["wt"], { env });
  assert.match(stdout, /^alpha \(2\)$/m);
  assert.match(stdout, /^beta \(2\)$/m);
  assert.match(stdout, /feat\/two .*1 changed/);
  assert.match(stdout, /leftover .*not a worktree/);
});

test("a repo filter shows only that repo", async () => {
  const { stdout } = await awb(["wt", "beta"], { env });
  assert.match(stdout, /^beta \(2\)$/m);
  assert.doesNotMatch(stdout, /alpha/);
});

test("--json lists every worktree with its branch", async () => {
  const { stdout } = await awb(["wt", "--json"], { env });
  const list = JSON.parse(stdout);
  assert.equal(list.length, 4);
  assert.equal(list.find((w: { name: string }) => w.name === "feat-one").branch, "feat/one");
});

test("a missing root exits 1", async () => {
  const { code } = await awb(["wt", "--root", join(work.dir, "nope")], { env });
  assert.equal(code, 1);
});
