import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runGate, claimTable, junitReport, type Claim, type GateResult, type Report } from "./gate.ts";
import { parseRunMd, parseTest, fill, fillTest, type RunMd } from "./run-md.ts";
import type { Task } from "./stacks.ts";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const PLAYWRIGHT = join(PKG, "..", "..", "node_modules", ".bin", "playwright");
const AGENTS = join(PKG, "agents", "playwright-agents.json");
const NODE_MODULES = join(PKG, "..", "..", "node_modules");

export type ProveDeps = {
  claude: string;
  writerBudgetUsd: number;
  writerTimeoutMin?: number;
  log: (line: string) => void;
};

export function claimsMarkdown(task: Pick<Task, "title" | "claims">, url: string): string {
  return `# Claims: ${task.title}\n\nSite: ${url}\n\n${task.claims.map((c) => `- ${c.id}: ${c.text}`).join("\n")}\n`;
}

export function proofConfig(url: string): string {
  return `import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "proof-tests",
  testMatch: "**/*.spec.@(ts|js)",
  outputDir: "proof/results",
  timeout: 60_000,
  reporter: [["list"], ["json", { outputFile: "proof/report.json" }]],
  use: { baseURL: ${JSON.stringify(url)}, video: "on", trace: "on" },
});
`;
}

export function testHash(dir: string): string {
  const h = createHash("sha256");
  if (!existsSync(dir)) return h.digest("hex");
  for (const f of readdirSync(dir).sort()) {
    if (!/\.(ts|js|mjs)$/.test(f)) continue;
    h.update(f).update("\0").update(readFileSync(join(dir, f))).update("\0");
  }
  return h.digest("hex");
}

const SPEC = /\.spec\.(ts|js)$/;
const TEST = /\.test\.(ts|js|mjs)$/;
export const PROOF_DIR = ".awb-proof";

const readTests = (dir: string, re: RegExp) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => re.test(f)).map((f) => readFileSync(join(dir, f), "utf8")).join("\n") : "";

export function claimsWithoutTest(claims: Claim[], dir: string): Claim[] {
  const specs = readTests(dir, SPEC);
  const tests = readTests(dir, TEST);
  return claims.filter((c) => !new RegExp(`['"\`]${c.id}\\b`).test(c.proof === "test" ? tests : specs));
}

export function removeTests(ids: string[], dir: string): string[] {
  if (!ids.length || !existsSync(dir)) return [];
  const removed = readdirSync(dir).filter((f) => {
    if (f === "seed.spec.ts" || !(SPEC.test(f) || TEST.test(f))) return false;
    const text = readFileSync(join(dir, f), "utf8");
    return ids.some((id) => new RegExp(`['"\`]${id}\\b`).test(text));
  });
  for (const f of removed) rmSync(join(dir, f));
  return removed;
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function waitReady(url: string, ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: "manual" });
      if (r.status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`the app did not answer at ${url} in ${ms / 1000} s`);
}

async function startApp(runMd: RunMd, cwd: string, log: (l: string) => void) {
  const port = await freePort();
  const url = fill(runMd.url, port).replace(/\/$/, "");
  let child: ChildProcess | null = null;
  if (runMd.start) {
    const cmd = fill(runMd.start, port);
    log(`app: ${cmd}`);
    child = spawn("sh", ["-c", cmd], { cwd, stdio: "ignore", detached: true });
  }
  const stop = () => {
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
    }
  };
  try {
    await waitReady(url + runMd.ready, 60_000);
  } catch (err) {
    stop();
    throw err;
  }
  return { url, stop };
}

export function run(cmd: string, args: string[], cwd: string, input?: string, timeoutMs = 0): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    const timer = timeoutMs ? setTimeout(() => child.kill("SIGTERM"), timeoutMs) : null;
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => resolve({ code: 127, out: String(e) }));
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, out });
    });
    child.stdin.end(input ?? "");
  });
}

export function writerPrompt(claims: Claim[], url: string, ready: string): string {
  return [
    `Use the playwright-test-generator agent to write one test for each of these claims in claims.md: ${claims.map((c) => c.id).join(", ")}.`,
    `The site is ${url}. Start from ${ready}.`,
    "Use the seed file proof-tests/seed.spec.ts.",
    "Save each test as proof-tests/<claim id in lower case>.spec.ts, for example proof-tests/c1.spec.ts.",
    "Start each test title with its claim id, for example 'C1: ...'.",
    "Test what a user sees. Do not change a test to make it pass: if the page does not do what the claim says, the test must fail.",
  ].join(" ");
}

async function runClaude(cwd: string, args: string[], prompt: string, deps: ProveDeps, logFile: string) {
  const r = await run(
    deps.claude,
    ["-p", ...args, "--max-budget-usd", String(deps.writerBudgetUsd), "--output-format", "stream-json", "--verbose"],
    cwd,
    prompt,
    (deps.writerTimeoutMin ?? 20) * 60_000,
  );
  writeFileSync(logFile, r.out);
  const last = r.out.trim().split("\n").at(-1) ?? "";
  try {
    const res = JSON.parse(last);
    deps.log(`test writer: ${res.subtype}, ${res.num_turns} turns, ${Number(res.total_cost_usd ?? 0).toFixed(2)} USD`);
  } catch {
    deps.log(`test writer exited with ${r.code}`);
  }
}

async function runWriter(folder: string, claims: Claim[], url: string, ready: string, deps: ProveDeps) {
  const mcp = join(folder, "mcp.json");
  writeFileSync(
    mcp,
    JSON.stringify({
      mcpServers: {
        "playwright-test": { command: PLAYWRIGHT, args: ["run-test-mcp-server", "--headless", "-c", join(folder, "playwright.config.ts")] },
      },
    }),
  );
  deps.log(`test writer: ${claims.map((c) => c.id).join(", ")}`);
  await runClaude(
    folder,
    ["--agents", AGENTS, "--mcp-config", mcp, "--strict-mcp-config", "--allowedTools", "Task", "Agent", "Read", "Glob", "Grep", "LS", "mcp__playwright-test__*"],
    writerPrompt(claims, url, ready),
    deps,
    join(folder, "proof", "writer.jsonl"),
  );
}

export function testWriterPrompt(claims: Claim[], script: string): string {
  return [
    "Write one integration test for each of these claims about the code in this repo:",
    ...claims.map((c) => `- ${c.id}: ${c.text}`),
    `Save each test as ${PROOF_DIR}/<claim id in lower case>.test.ts (or .test.js in a JavaScript repo), for example ${PROOF_DIR}/c1.test.ts.`,
    "Use the test framework and the style of the existing tests in this repo. Import the code with relative paths from that folder.",
    "Start each test name with its claim id, for example 'C1: ...'.",
    "Call the real code. Do not mock the logic that the claim is about.",
    `To run your tests, run: sh ${script}`,
    `Do not edit any file outside ${PROOF_DIR}. Do not change a test to make it pass: if the code does not do what the claim says, the test must fail.`,
  ].join("\n");
}

async function runTestWriter(folder: string, worktree: string, claims: Claim[], testCmd: string, deps: ProveDeps) {
  const head = git(worktree, "rev-parse", "HEAD");
  if (git(worktree, "status", "--porcelain") !== "") throw new Error("commit your changes first: the test writer needs a clean worktree");
  const work = join(worktree, PROOF_DIR);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work);
  const script = join(folder, "writer-test.sh");
  writeFileSync(script, `cd ${JSON.stringify(worktree)}\n${testCmd.replaceAll("{tests}", `${PROOF_DIR}/*`).replaceAll("{report}", "/dev/null")}\n`);
  deps.log(`test writer: ${claims.map((c) => c.id).join(", ")}`);
  try {
    await runClaude(
      worktree,
      ["--strict-mcp-config", "--allowedTools", "Read", "Glob", "Grep", "LS", `Edit(./${PROOF_DIR}/**)`, `Write(./${PROOF_DIR}/**)`, `Bash(sh ${script})`],
      testWriterPrompt(claims, script),
      deps,
      join(folder, "proof", "test-writer.jsonl"),
    );
    const changed = git(worktree, "status", "--porcelain", "--", ".", `:!${PROOF_DIR}`);
    if (git(worktree, "rev-parse", "HEAD") !== head || changed) {
      git(worktree, "reset", "-q", "--hard", head);
      git(worktree, "clean", "-qfd", "-e", PROOF_DIR);
      throw new Error("the test writer changed the source or the commit; the change is undone");
    }
    for (const f of readdirSync(work).filter((f) => TEST.test(f))) copyFileSync(join(work, f), join(folder, "proof-tests", f));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function runRepoTests(folder: string, worktree: string, testCmd: string, log: (l: string) => void) {
  const files = readdirSync(join(folder, "proof-tests")).filter((f) => TEST.test(f)).sort();
  const work = join(worktree, PROOF_DIR);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work);
  try {
    for (const f of files) copyFileSync(join(folder, "proof-tests", f), join(work, f));
    const cmd = fillTest(testCmd, files.map((f) => `${PROOF_DIR}/${f}`), join(folder, "proof", "junit.xml"));
    log(`proof run: ${cmd}`);
    const r = await run("sh", ["-c", cmd], worktree);
    writeFileSync(join(folder, "proof", "test.log"), r.out);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function gateFromDisk(claims: Claim[], folder: string, worktree: string): GateResult {
  const proof = join(folder, "proof");
  const read = (f: string) => (existsSync(join(proof, f)) ? readFileSync(join(proof, f), "utf8").trim() : "");
  const report: Report = read("report.json") ? JSON.parse(read("report.json")) : { suites: [] };
  if (read("junit.xml")) report.suites.push(...junitReport(read("junit.xml")).suites);
  return runGate({
    claims,
    report,
    head: git(worktree, "rev-parse", "HEAD"),
    savedSha: read("sha.txt"),
    dirty: git(worktree, "status", "--porcelain") !== "",
    testHashAtStart: read("test-hash.txt"),
    testHashNow: testHash(join(folder, "proof-tests")),
    fileExists: existsSync,
  });
}

export type ProveResult = { gate: GateResult; table: string; folder: string };

export async function prove(task: Task, worktree: string, deps: ProveDeps, rewrite: string[] = []): Promise<ProveResult> {
  const runMdFile = join(worktree, ".awb", "run.md");
  if (!existsSync(runMdFile)) throw new Error(`no run file: write ${runMdFile} with a '## start' or '## test' section`);
  const runMdText = readFileSync(runMdFile, "utf8");
  const browserClaims = task.claims.filter((c) => c.proof !== "test");
  const testClaims = task.claims.filter((c) => c.proof === "test");
  const runMd = browserClaims.length ? parseRunMd(runMdText) : null;
  const testCmd = testClaims.length ? parseTest(runMdText) : null;

  mkdirSync(task.folder, { recursive: true });
  const folder = realpathSync(task.folder);
  const tests = join(folder, "proof-tests");
  const proof = join(folder, "proof");
  mkdirSync(tests, { recursive: true });
  if (!existsSync(join(folder, "node_modules"))) symlinkSync(NODE_MODULES, join(folder, "node_modules"), "dir");
  rmSync(proof, { recursive: true, force: true });
  mkdirSync(proof, { recursive: true });
  rmSync(join(worktree, PROOF_DIR), { recursive: true, force: true });

  const head = git(worktree, "rev-parse", "HEAD");
  writeFileSync(join(proof, "sha.txt"), head + "\n");

  const removed = removeTests(rewrite, tests);
  if (removed.length) deps.log(`removed for a rewrite: ${removed.join(", ")}`);

  if (testCmd) {
    const missing = claimsWithoutTest(testClaims, tests);
    if (missing.length) await runTestWriter(folder, worktree, missing, testCmd, deps);
  }

  const app = runMd ? await startApp(runMd, worktree, deps.log) : null;
  try {
    if (runMd && app) {
      writeFileSync(join(folder, "claims.md"), claimsMarkdown({ title: task.title, claims: browserClaims }, app.url));
      writeFileSync(join(folder, "playwright.config.ts"), proofConfig(app.url));
      if (!existsSync(join(tests, "seed.spec.ts"))) {
        writeFileSync(
          join(tests, "seed.spec.ts"),
          `import { test } from "@playwright/test";\ntest("seed", async ({ page }) => {\n  await page.goto(${JSON.stringify(runMd.ready)});\n});\n`,
        );
      }
      const missing = claimsWithoutTest(browserClaims, tests);
      if (missing.length) await runWriter(folder, missing, app.url, runMd.ready, deps);
    }

    writeFileSync(join(proof, "test-hash.txt"), testHash(tests) + "\n");
    if (app) {
      deps.log("proof run: playwright test");
      const pw = await run(PLAYWRIGHT, ["test", "--config", "playwright.config.ts"], folder);
      writeFileSync(join(proof, "run.log"), pw.out);
    }
    if (testCmd) await runRepoTests(folder, worktree, testCmd, deps.log);

    const gate = gateFromDisk(task.claims, folder, worktree);
    writeFileSync(join(proof, "gate.json"), JSON.stringify(gate, null, 2));
    return { gate, table: claimTable(gate), folder };
  } finally {
    app?.stop();
  }
}
