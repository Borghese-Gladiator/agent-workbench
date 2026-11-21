import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { awb, exec, git, makeWork, stubCommand, withPath } from "./harness.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MAIN = join(ROOT, "packages", "cli", "src", "main.ts");
const HOOK = join(ROOT, "packages", "cli", "src", "hook-send.ts");
const PLAYWRIGHT = join(ROOT, "node_modules", "@playwright", "test", "cli.js");

const work = makeWork();
const repo = join(work.dir, "repo");
const home = join(work.dir, "home");
const bin = join(work.dir, "bin");

const RUN_MD = `## setup
\`\`\`sh
echo "setup: nothing to install"
\`\`\`

## start
\`\`\`sh
node -e "const h=require('http'),f=require('fs');h.createServer((q,r)=>{r.setHeader('content-type','text/html');r.end(f.readFileSync('index.html'))}).listen({port})"
\`\`\`
url: http://localhost:{port}
ready: /
`;

const CLAUDE = `
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = ${JSON.stringify(MAIN)};
const HOOK = ${JSON.stringify(HOOK)};
const prompt = readFileSync(0, "utf8");
const run = (cmd, args) => spawnSync(cmd, args, { stdio: ["ignore", 2, 2] });
const awb = (...a) => run(process.execPath, ["--disable-warning=ExperimentalWarning", MAIN, ...a]);

if (process.argv.includes("--agents")) {
  const expects = {
    C1: 'await expect(page.getByRole("heading", { name: "Demo" })).toBeVisible();',
    C2: 'await expect(page.getByRole("contentinfo")).toHaveText("Footer", { timeout: 2000 });',
  };
  mkdirSync("proof-tests", { recursive: true });
  for (const [, id] of readFileSync("claims.md", "utf8").matchAll(/^- (C\\d+)/gm)) {
    const expect = expects[id] ?? 'await expect(page.getByRole("button", { name: "Missing" })).toBeVisible({ timeout: 2000 });';
    const lines = ['import { test, expect } from "@playwright/test";', 'test("' + id + ': the claim", async ({ page }) => {', '  await page.goto("/");', "  " + expect, "});", ""];
    writeFileSync("proof-tests/" + id.toLowerCase() + ".spec.ts", lines.join("\\n"));
  }
  console.log(JSON.stringify({ type: "result", subtype: "success", num_turns: 3, total_cost_usd: 0.75 }));
  process.exit(0);
}

const transcript = join(mkdtempSync(join(tmpdir(), "awb-e2e-t-")), "transcript.jsonl");
writeFileSync(transcript, JSON.stringify({ type: "assistant", message: { id: "m1", model: "claude-opus-5-5", usage: { input_tokens: 100000, output_tokens: 10000 } } }) + "\\n");
const hook = (name) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", HOOK], { input: JSON.stringify({ hook_event_name: name, tool_name: "Bash", transcript_path: transcript }), stdio: ["pipe", "ignore", "ignore"] });
const commit = (m) => run("git", ["-c", "core.hooksPath=" + devNull, "-c", "user.email=a@b", "-c", "user.name=t", "commit", "-qam", m]);

hook("PreToolUse");
if (prompt.includes('stack: "Scoreboard"')) {
  appendFileSync("index.html", '<p id="score">0</p>\\n');
  commit("scoreboard");
}
if (prompt.includes('stack: "Footer"') && existsSync(join(process.env.AWB_E2E_WORK, "fix-footer"))) {
  appendFileSync("index.html", "<footer>Footer</footer>\\n");
  commit("footer");
}
awb("prove");
awb("ship");
hook("Stop");
console.log(JSON.stringify({ type: "result", subtype: "success", num_turns: 4, total_cost_usd: 0.6, usage: { input_tokens: 100000, output_tokens: 10000 } }));
`;

const GH = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const w = process.env.AWB_E2E_WORK;
const file = join(w, "gh.json");
const s = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { prs: {}, assets: {} };
const a = process.argv.slice(2);
appendFileSync(join(w, "gh-calls.txt"), a.join(" ") + "\\n");
const save = () => writeFileSync(file, JSON.stringify(s));
const url = (n) => "https://github.com/example/demo/pull/" + n;
switch (a[0] + " " + a[1]) {
  case "pr create": {
    const n = Object.keys(s.prs).length + 1;
    s.prs[a[a.indexOf("--head") + 1]] = n;
    save();
    console.log(url(n));
    break;
  }
  case "pr view": {
    const x = a[2];
    const n = /^\\d+$/.test(x) ? Number(x) : x.includes("/pull/") ? Number(x.split("/pull/")[1]) : s.prs[x];
    if (!n) process.exit(1);
    console.log(JSON.stringify({ number: n, url: url(n), state: "OPEN" }));
    break;
  }
  case "release view":
    if (!s.assets[a[2]]) process.exit(1);
    console.log(JSON.stringify({ assets: s.assets[a[2]].map((n) => ({ name: n, url: "https://example.com/" + n })) }));
    break;
  case "release create":
    s.assets[a[2]] = [];
    save();
    break;
  case "release upload":
    s.assets[a[2]].push(...a.slice(3).filter((x) => x !== "--clobber").map((f) => basename(f)));
    save();
    break;
}
`;

const claude = stubCommand(bin, "claude", CLAUDE);
stubCommand(bin, "gh", GH);
const env = withPath(
  { ...process.env, AWB_HOME: home, AWB_SYNC_MS: "3600000", AWB_QUIET_MIN: "1", AWB_TASK_TIMEOUT_MIN: "5", AWB_NOTIFY: "0", AWB_CLAUDE: claude, AWB_WRITER_CLAUDE: claude, AWB_E2E_WORK: work.dir },
  bin,
);

const STACK = {
  tasks: [
    { title: "Scoreboard", claims: [{ id: "C1", text: "The page shows the Demo heading." }] },
    { title: "Footer", claims: [{ id: "C1", text: "The page shows the Demo heading." }, { id: "C2", text: "The page shows a footer." }] },
    { title: "Broken", claims: [{ id: "C1", text: "The page shows the Demo heading." }, { id: "C3", text: "The page shows a Missing button." }] },
  ],
};

let ids: string[] = [];
let api = "";
let runOut = { code: 0, stdout: "" };

const show = async (id: string) => JSON.parse((await awb(["show", id, "--json"], { cwd: repo, env })).stdout);
const post = (path: string, body: unknown) =>
  fetch(api + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

before(async () => {
  await git(work.dir, "init", "-q", "--bare", "origin.git");
  mkdirSync(join(repo, ".awb"), { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, ".awb", "run.md"), RUN_MD);
  writeFileSync(join(repo, "index.html"), "<!doctype html><title>demo</title><h1>Demo</h1>\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "demo app");
  await git(repo, "remote", "add", "origin", join(work.dir, "origin.git"));
  await git(repo, "push", "-q", "-u", "origin", "main");
  await git(repo, "remote", "set-head", "origin", "main");

  const set = await awb(["stack", "set", "--json"], { cwd: repo, env, input: JSON.stringify(STACK) });
  assert.equal(set.code, 0, set.stderr);
  ids = JSON.parse(set.stdout).stack.tasks.map((t: { id: string }) => t.id);
  runOut = await awb(["run", "--wait", "--json"], { cwd: repo, env });

  const { port } = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8"));
  api = `http://127.0.0.1:${port}`;
  await post("/api/sessions", { repo, worktree: repo, branch: "lost-branch", pid: 999999 });
  const quiet = await post("/api/sessions", { repo, worktree: repo, branch: "quiet-branch", pid: process.pid });
  await post("/api/events", { awb_session_id: quiet.id, payload: { hook_event_name: "PreToolUse", tool_name: "Read" } });
  const db = new DatabaseSync(join(home, "awb.db"));
  db.prepare("UPDATE events SET at = ? WHERE session_id = ?").run(new Date(Date.now() - 5 * 60000).toISOString(), quiet.id);
  db.close();
});

after(async () => {
  await awb(["daemon", "stop"], { env });
  work.remove();
});

test("the run stops at the Footer task, and the reason names C2", () => {
  assert.notEqual(runOut.code, 0, "the run did not stop at the Footer task");
  const run = JSON.parse(runOut.stdout);
  assert.equal(run.state, "stopped");
  assert.match(runOut.stdout, /C2/);
});

test("Scoreboard has a PR, Footer failed, Broken is waiting", async () => {
  const [one, two, three] = await Promise.all(ids.map(show));
  assert.equal(`${one.status} ${one.pr_number}`, "done 1");
  assert.equal(two.status, "failed");
  assert.equal(three.status, "waiting");
});

test("the browser test of the UI passes", async () => {
  const r = await exec(process.execPath, [PLAYWRIGHT, "test", "--config", "e2e/ui.config.ts"], {
    cwd: ROOT,
    env: { ...env, AWB_URL: api, AWB_T1: ids[0], AWB_T2: ids[1], AWB_T3: ids[2] },
  });
  assert.equal(r.code, 0, r.stdout + r.stderr);
});
