import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runGate, claimTable, junitReport, type Carried, type Claim, type GateResult, type Report } from "./gate.ts";
import { parseRunMd, parseSeed, parseTest, fillTest } from "./run-md.ts";
import type { Task } from "./stacks.ts";
import { PLAYWRIGHT, git, run, startApp } from "./process.ts";
import { seedCache, seedCopy } from "./seed.ts";
import { PROOF_DIR, removeTests, repoTests, testHash } from "./proof-tests.ts";
import { runTestWriter, runWriter, writeMissing, eachClaim, type ProveDeps, type WriterEnd } from "./writer.ts";

export { run, killChildren } from "./process.ts";
export { seedCache, seedCopy } from "./seed.ts";
export { testHash, PROOF_DIR, testFileClaim, claimsWithoutTest, removeTests } from "./proof-tests.ts";
export { writerPrompt, writerEnd, writerLimit, testWriterPrompt, joinWriterEnds, type ProveDeps, type WriterEnd } from "./writer.ts";

const NODE_MODULES = join(fileURLToPath(new URL("..", import.meta.url)), "..", "..", "node_modules");

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

async function runRepoTests(folder: string, worktree: string, testCmd: string, log: (l: string) => void, from = folder, name = "junit", signal?: AbortSignal) {
  const files = repoTests(join(from, "proof-tests"));
  const work = join(worktree, PROOF_DIR);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work);
  try {
    for (const f of files) copyFileSync(join(from, "proof-tests", f), join(work, f));
    const cmd = fillTest(testCmd, files.map((f) => `${PROOF_DIR}/${f}`), join(folder, "proof", `${name}.xml`));
    log(`proof run${name === "base-junit" ? " on the base commit" : ""}: ${cmd}`);
    const r = await run("sh", ["-c", `export PYTHONDONTWRITEBYTECODE=1\n${cmd}`], worktree, "", 0, signal);
    writeFileSync(join(folder, "proof", `${name.replace(/junit$/, "test")}.log`), r.out);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function mergeBase(worktree: string, base: string | null): string | null {
  if (!base) return null;
  for (const ref of [base, `origin/${base}`]) {
    try {
      return execFileSync("git", ["merge-base", "HEAD", ref], { cwd: worktree, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
    } catch {}
  }
  return null;
}

async function runBaseTests(task: Task, folder: string, worktree: string, testCmd: string, log: (l: string) => void, signal?: AbortSignal) {
  const sha = mergeBase(worktree, task.base);
  if (!sha) return log(`base run skipped: no merge base with ${task.base ?? "(no base)"}`);
  if (git(worktree, "status", "--porcelain") !== "") return log("base run skipped: the worktree has uncommitted changes");
  const head = git(worktree, "rev-parse", "HEAD");
  const branch = git(worktree, "rev-parse", "--abbrev-ref", "HEAD");
  git(worktree, "switch", "-q", "--detach", sha);
  try {
    await runRepoTests(folder, worktree, testCmd, log, folder, "base-junit", signal);
  } finally {
    git(worktree, "switch", "-q", ...(branch === "HEAD" ? ["--detach", head] : [branch]));
  }
}

export function gateFromDisk(claims: Claim[], folder: string, worktree: string): GateResult {
  const proof = join(folder, "proof");
  const read = (f: string) => (existsSync(join(proof, f)) ? readFileSync(join(proof, f), "utf8").trim() : "");
  const report: Report = read("report.json") ? JSON.parse(read("report.json")) : { suites: [] };
  if (read("junit.xml")) report.suites.push(...junitReport(read("junit.xml")).suites);
  const startError = read("report.json") ? undefined : read("run.log").split("\n").filter(Boolean).slice(0, 3).join(" ").slice(0, 300) || undefined;
  return runGate({
    startError,
    claims,
    report,
    head: git(worktree, "rev-parse", "HEAD"),
    savedSha: read("sha.txt"),
    dirty: git(worktree, "status", "--porcelain") !== "",
    testHashAtStart: read("test-hash.txt"),
    testHashNow: testHash(join(folder, "proof-tests")),
    fileExists: existsSync,
    writerEnd: read("writer-end.txt") || undefined,
    baseReport: read("base-junit.xml") ? junitReport(read("base-junit.xml")) : undefined,
    carried: (read("carried.json") ? (JSON.parse(read("carried.json")) as CarriedTask[]) : []).map(
      (k): Carried => ({ label: k.label, claims: k.claims, report: read(`carried-${k.label}.xml`) ? junitReport(read(`carried-${k.label}.xml`)) : { suites: [] } }),
    ),
  });
}

export type CarriedTask = { label: string; claims: Claim[]; folder: string };

export type ProveResult = { gate: GateResult; table: string; folder: string; writer: WriterEnd | null };

export async function prove(task: Task, worktree: string, runMdText: string, deps: ProveDeps, rewrite: string[] = [], carried: CarriedTask[] = []): Promise<ProveResult> {
  const browserClaims = task.claims.filter((c) => c.proof !== "test");
  const testClaims = task.claims.filter((c) => c.proof === "test");
  const runMd = browserClaims.length ? parseRunMd(runMdText) : null;
  const testCmd = testClaims.length || carried.length ? parseTest(runMdText) : null;
  const seed = runMd ? parseSeed(runMdText) : null;

  mkdirSync(task.folder, { recursive: true });
  const folder = realpathSync(task.folder);
  const tests = join(folder, "proof-tests");
  const proof = join(folder, "proof");
  mkdirSync(tests, { recursive: true });
  if (!existsSync(join(folder, "node_modules"))) symlinkSync(NODE_MODULES, join(folder, "node_modules"), "junction");
  rmSync(proof, { recursive: true, force: true });
  mkdirSync(proof, { recursive: true });
  rmSync(join(worktree, PROOF_DIR), { recursive: true, force: true });

  const head = git(worktree, "rev-parse", "HEAD");
  writeFileSync(join(proof, "sha.txt"), head + "\n");

  const hintFile = join(worktree, ".awb", "prove.md");
  if (existsSync(hintFile)) deps = { ...deps, hint: readFileSync(hintFile, "utf8").trim() };

  const removed = removeTests(rewrite, tests);
  if (removed.length) deps.log(`removed for a rewrite: ${removed.join(", ")}`);

  let writer: WriterEnd | null = null;
  if (testCmd) writer = await writeMissing(testClaims, tests, proof, deps.log, (c) => eachClaim(c, (one) => runTestWriter(folder, worktree, one, testCmd, deps)));

  if (seed && !deps.seedDir) throw new Error("run.md has a '## seed' section, but no seed folder is set");
  const seedPath = seed ? seedCopy(await seedCache(seed, worktree, deps.seedDir!, proof, deps.log)) : undefined;
  const app = runMd ? await startApp(runMd, worktree, deps.log, seedPath) : null;
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
      writer = (await writeMissing(browserClaims, tests, proof, deps.log, (c) => eachClaim(c, (one) => runWriter(folder, one, app.url, runMd.ready, deps, seed?.about)))) ?? writer;
    }

    writeFileSync(join(proof, "test-hash.txt"), testHash(tests) + "\n");
    if (app) {
      deps.log("proof run: playwright test");
      const pw = await run(PLAYWRIGHT, ["test", "--config", "playwright.config.ts"], folder, "", 0, deps.signal);
      writeFileSync(join(proof, "run.log"), pw.out);
    }
    if (testClaims.length && testCmd) {
      await runRepoTests(folder, worktree, testCmd, deps.log, folder, "junit", deps.signal);
      await runBaseTests(task, folder, worktree, testCmd, deps.log, deps.signal);
    }
    if (carried.length && testCmd) {
      writeFileSync(join(proof, "carried.json"), JSON.stringify(carried));
      for (const k of carried) await runRepoTests(folder, worktree, testCmd, deps.log, k.folder, `carried-${k.label}`, deps.signal);
    }
    deps.signal?.throwIfAborted();

    const gate = gateFromDisk(task.claims, folder, worktree);
    writeFileSync(join(proof, "gate.json"), JSON.stringify(gate, null, 2));
    return { gate, table: claimTable(gate), folder, writer };
  } finally {
    app?.stop();
  }
}
