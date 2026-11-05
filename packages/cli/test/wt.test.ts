import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render, remove, scan, wtRoot } from "../src/wt.ts";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, stdio: "ignore" });

function fixture() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "awb-wt-")));
  const repo = join(tmp, "myrepo");
  const root = join(tmp, "worktrees");
  mkdirSync(repo);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  sh(repo, "worktree", "add", "-q", "-b", "feat/a", join(root, "myrepo", "feat-a"));
  sh(repo, "worktree", "add", "-q", "-b", "feat/b", join(root, "myrepo", "feat-b"));
  mkdirSync(join(root, "myrepo", "stale"));
  writeFileSync(join(root, "myrepo", "feat-b", "x.txt"), "x");
  return { root, repo };
}

test("the root comes from the flag, then AWB_WORKTREES, then the Klaviyo or home default", () => {
  assert.equal(wtRoot("/a", { AWB_WORKTREES: "/b" }), "/a");
  assert.equal(wtRoot(undefined, { AWB_WORKTREES: "/b" }), "/b");
  assert.equal(wtRoot(undefined, {}, "/h/Klaviyo/Repos/app/src", "/h"), "/h/Klaviyo/Repos/LOCAL_worktrees");
  assert.equal(wtRoot(undefined, {}, "/h/Klaviyo/Repos", "/h"), "/h/Klaviyo/Repos/LOCAL_worktrees");
  assert.equal(wtRoot(undefined, {}, "/h/Klaviyo/Reposx", "/h"), "/h/LOCAL_worktrees");
  assert.equal(wtRoot(undefined, {}, "/h/GitHub/agent-workbench", "/h"), "/h/LOCAL_worktrees");
});

test("scan groups worktrees by repo and reads branch and dirty state", async () => {
  const { root } = fixture();
  const list = await scan(root);
  assert.deepEqual(
    list.map((w) => [w.repo, w.name, w.branch, w.dirty]),
    [
      ["myrepo", "feat-a", "feat/a", 0],
      ["myrepo", "feat-b", "feat/b", 1],
      ["myrepo", "stale", "", 0],
    ],
  );
  assert.match(render(list), /^myrepo \(3\)\n {2}feat\/a .*clean[\s\S]*1 changed[\s\S]*stale .*not a worktree$/);
  assert.deepEqual(await scan(root, "other"), []);
});

test("remove deletes a clean worktree and refuses a dirty one", async () => {
  const { root, repo } = fixture();
  const [a, b] = await scan(root);
  assert.equal(await remove(a), null);
  assert.match((await remove(b))!, /modified or untracked/);
  const left = execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" });
  assert.doesNotMatch(left, /feat-a/);
  assert.match(left, /feat-b/);
});
