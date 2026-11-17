import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store.ts";
import { createStacks, migrateStacks } from "../src/stacks.ts";
import { createApp } from "../src/server.ts";
import { taskRoutes } from "../src/task-routes.ts";

delete process.env.NODE_TEST_CONTEXT;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

test("a second prove waits for the running proof and gets its result; ship during the proof gets 409", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "awb-attach-")));
  const repo = join(root, "repo");
  mkdirSync(join(repo, ".awb"), { recursive: true });
  writeFileSync(join(repo, "add.mjs"), "export const add = (a, b) => a - b;\n");
  writeFileSync(join(repo, ".awb", "run.md"), "## test\n```sh\nnode --test --test-reporter=junit --test-reporter-destination={report} {tests}\n```\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "init");
  git(repo, "switch", "-q", "-c", "feat");
  writeFileSync(join(repo, "add.mjs"), "export const add = (a, b) => a + b;\n");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.hooksPath=/dev/null", "commit", "-qam", "fix");
  writeFileSync(
    join(root, "proof.mjs"),
    `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../add.mjs";\ntest("C1: add sums", () => assert.equal(add(2, 3), 5));\n`,
  );
  const claude = join(root, "claude");
  writeFileSync(
    claude,
    `#!/bin/sh\ncat > /dev/null\necho run >> ${join(root, "calls")}\nsleep 1\ncp ${join(root, "proof.mjs")} .awb-proof/c1.test.mjs\necho '{"type":"result","subtype":"success","num_turns":1,"total_cost_usd":0}'\n`,
  );
  chmodSync(claude, 0o755);

  const store = openStore(":memory:");
  migrateStacks(store.db);
  const stacks = createStacks(store.db, (id) => join(root, "tasks", id));
  stacks.set({ repo, branch: "feat", base: "main", tasks: [{ title: "Add", claims: [{ id: "C1", text: "add sums", proof: "test" }] }] });
  const routes = taskRoutes(stacks, { claude }, { owns: () => false } as any, () => null, root, store.db);
  const server = createApp(store, { home: root, startedAt: "" }, routes).listen(0);
  await new Promise((r) => server.once("listening", r));
  const post = (path: string, extra = {}) =>
    fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo, branch: "feat", worktree: repo, ...extra }),
    });
  const lines = async (r: Response) => (await r.text()).trim().split("\n").map((l) => JSON.parse(l));
  try {
    const first = post("/api/prove");
    await new Promise((r) => setTimeout(r, 300));
    const second = post("/api/prove", { rewrite: ["C1"] });
    const shipRes = await post("/api/ship");
    assert.equal(shipRes.status, 409);
    const [a, b] = await Promise.all([first.then(lines), second.then(lines)]);
    assert.match(b[0].log, /already running; waiting for its result; the --rewrite value C1 is ignored/);
    assert.equal(a.at(-1).result.pass, true);
    assert.deepEqual(b.at(-1), a.at(-1));
    assert.deepEqual(b.slice(1), a);
    assert.equal(readFileSync(join(root, "calls"), "utf8"), "run\n");
  } finally {
    server.close();
    store.close();
  }
});
