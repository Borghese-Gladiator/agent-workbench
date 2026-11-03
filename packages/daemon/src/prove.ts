import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runGate, claimTable, type Claim, type GateResult, type Report } from "./gate.ts";
import { parseRunMd, fill, type RunMd } from "./run-md.ts";
import type { Task } from "./stacks.ts";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const PLAYWRIGHT = join(PKG, "..", "..", "node_modules", ".bin", "playwright");
const AGENTS = join(PKG, "agents", "playwright-agents.json");
const NODE_MODULES = join(PKG, "..", "..", "node_modules");

export type ProveDeps = {
  claude: string;
  writerBudgetUsd: number;
  writerTimeoutMin?: number;
  budget?: () => string | null;
  log: (line: string) => void;
};

export type WriterEnd = { end: string; usd: number | null };

export function claimsMarkdown(task: Pick<Task, "title" | "claims">, url: string): string {
  return `# Claims: ${task.title}\n\nSite: ${url}\n\n${task.claims.map((c) => `- ${c.id}: ${c.text}`).join("\n")}\n`;
}

export function proofConfig(url: string): string {
  return `import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "proof-tests",
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

export function claimsWithoutTest(claims: Claim[], dir: string): Claim[] {
  const text = existsSync(dir)
    ? readdirSync(dir).filter((f) => /\.spec\.(ts|js)$/.test(f)).map((f) => readFileSync(join(dir, f), "utf8")).join("\n")
    : "";
  return claims.filter((c) => !new RegExp(`['"\`]${c.id}\\b`).test(text));
}

export function removeTests(ids: string[], dir: string): string[] {
  if (!ids.length || !existsSync(dir)) return [];
  const removed = readdirSync(dir).filter((f) => {
    if (f === "seed.spec.ts" || !/\.spec\.(ts|js)$/.test(f)) return false;
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

export function run(cmd: string, args: string[], cwd: string, input?: string, timeoutMs = 0): Promise<{ code: number; out: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, timeoutMs)
      : null;
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => resolve({ code: 127, out: String(e), timedOut }));
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, out, timedOut });
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

export function writerEnd(out: string, timedOut: boolean, code: number, timeoutMin: number): WriterEnd {
  let res: any = null;
  for (const line of out.split("\n")) {
    if (!line.includes('"type":"result"')) continue;
    try {
      res = JSON.parse(line);
    } catch {}
  }
  const usd = res && typeof res.total_cost_usd === "number" ? res.total_cost_usd : null;
  if (timedOut) return { end: `timeout after ${timeoutMin} min`, usd };
  if (res) return { end: res.subtype === "success" ? `success, ${res.num_turns} turns` : String(res.subtype), usd };
  return { end: `exit ${code}`, usd };
}

async function runWriter(folder: string, claims: Claim[], url: string, ready: string, deps: ProveDeps): Promise<WriterEnd> {
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
  const r = await run(
    deps.claude,
    [
      "-p",
      "--agents", AGENTS,
      "--mcp-config", mcp,
      "--strict-mcp-config",
      "--allowedTools", "Task", "Agent", "Read", "Glob", "Grep", "LS", "mcp__playwright-test__*",
      "--max-budget-usd", String(deps.writerBudgetUsd),
      "--output-format", "stream-json", "--verbose",
    ],
    folder,
    writerPrompt(claims, url, ready),
    (deps.writerTimeoutMin ?? 30) * 60_000,
  );
  writeFileSync(join(folder, "proof", "writer.jsonl"), r.out);
  const w = writerEnd(r.out, r.timedOut, r.code, deps.writerTimeoutMin ?? 30);
  writeFileSync(join(folder, "proof", "writer-end.txt"), w.end + "\n");
  deps.log(`test writer: ${w.end}${w.usd === null ? "" : `, ${w.usd.toFixed(2)} USD`}`);
  return w;
}

export function gateFromDisk(claims: Claim[], folder: string, worktree: string): GateResult {
  const proof = join(folder, "proof");
  const read = (f: string) => (existsSync(join(proof, f)) ? readFileSync(join(proof, f), "utf8").trim() : "");
  const report: Report = read("report.json") ? JSON.parse(read("report.json")) : { suites: [] };
  return runGate({
    claims,
    report,
    head: git(worktree, "rev-parse", "HEAD"),
    savedSha: read("sha.txt"),
    dirty: git(worktree, "status", "--porcelain") !== "",
    testHashAtStart: read("test-hash.txt"),
    testHashNow: testHash(join(folder, "proof-tests")),
    fileExists: existsSync,
    writerEnd: read("writer-end.txt") || undefined,
  });
}

export type ProveResult = { gate: GateResult; table: string; folder: string; writer: WriterEnd | null };

export async function prove(task: Task, worktree: string, deps: ProveDeps, rewrite: string[] = []): Promise<ProveResult> {
  const runMdFile = join(worktree, ".awb", "run.md");
  if (!existsSync(runMdFile)) throw new Error(`no run file: write ${runMdFile} with a '## start' section`);
  const runMd = parseRunMd(readFileSync(runMdFile, "utf8"));

  mkdirSync(task.folder, { recursive: true });
  const folder = realpathSync(task.folder);
  const tests = join(folder, "proof-tests");
  const proof = join(folder, "proof");
  mkdirSync(tests, { recursive: true });
  if (!existsSync(join(folder, "node_modules"))) symlinkSync(NODE_MODULES, join(folder, "node_modules"), "dir");
  rmSync(proof, { recursive: true, force: true });
  mkdirSync(proof, { recursive: true });

  const head = git(worktree, "rev-parse", "HEAD");
  writeFileSync(join(proof, "sha.txt"), head + "\n");

  const app = await startApp(runMd, worktree, deps.log);
  try {
    writeFileSync(join(folder, "claims.md"), claimsMarkdown(task, app.url));
    writeFileSync(join(folder, "playwright.config.ts"), proofConfig(app.url));
    if (!existsSync(join(tests, "seed.spec.ts"))) {
      writeFileSync(
        join(tests, "seed.spec.ts"),
        `import { test } from "@playwright/test";\ntest("seed", async ({ page }) => {\n  await page.goto(${JSON.stringify(runMd.ready)});\n});\n`,
      );
    }

    const removed = removeTests(rewrite, tests);
    if (removed.length) deps.log(`removed for a rewrite: ${removed.join(", ")}`);
    const missing = claimsWithoutTest(task.claims, tests);
    let writer: WriterEnd | null = null;
    if (missing.length) {
      const over = deps.budget?.();
      if (over) throw new Error(`the test writer did not start: ${over}`);
      writer = await runWriter(folder, missing, app.url, runMd.ready, deps);
    }

    writeFileSync(join(proof, "test-hash.txt"), testHash(tests) + "\n");
    deps.log("proof run: playwright test");
    const pw = await run(PLAYWRIGHT, ["test", "--config", "playwright.config.ts"], folder);
    writeFileSync(join(proof, "run.log"), pw.out);

    const gate = gateFromDisk(task.claims, folder, worktree);
    writeFileSync(join(proof, "gate.json"), JSON.stringify(gate, null, 2));
    return { gate, table: claimTable(gate), folder, writer };
  } finally {
    app.stop();
  }
}
