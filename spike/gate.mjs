import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const [repo, claimsFile = "proof-tests/claims.md", reportFile = "proof/report.json"] = process.argv.slice(2);
if (!repo) {
  console.error("usage: node gate.mjs <repo> [claimsFile] [reportFile]");
  process.exit(2);
}

const claimIds = [...readFileSync(join(repo, claimsFile), "utf8").matchAll(/^- (C\d+):/gm)].map((m) => m[1]);
const report = JSON.parse(readFileSync(join(repo, reportFile), "utf8"));

const specs = [];
const walk = (suite) => {
  for (const spec of suite.specs ?? []) specs.push(spec);
  for (const child of suite.suites ?? []) walk(child);
};
report.suites.forEach(walk);

const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"]).toString().trim();
const shaFile = join(repo, "proof/sha.txt");
const savedSha = existsSync(shaFile) ? readFileSync(shaFile, "utf8").trim() : "";
const dirty = execFileSync("git", ["-C", repo, "status", "--porcelain", "--", "games", "packages", "portal"]).toString().trim();
const shaOk = savedSha === head && dirty === "";

const testDir = join(repo, "proof-tests");
const skipped = new Set();
for (const file of readdirSync(testDir).filter((f) => f.endsWith(".ts") || f.endsWith(".js"))) {
  const text = readFileSync(join(testDir, file), "utf8");
  for (const m of text.matchAll(/test\.(?:fixme|skip)\(\s*['"`](C\d+)/g)) skipped.add(m[1]);
}

const rows = claimIds.map((id) => {
  const mine = specs.filter((s) => new RegExp(`^${id}\\b`).test(s.title));
  const results = mine.flatMap((s) => s.tests.flatMap((t) => t.results.map((r) => ({ t, r }))));
  const reasons = [];
  if (mine.length === 0) reasons.push("no test");
  if (skipped.has(id) || results.some(({ t }) => t.status === "skipped")) reasons.push("skipped");
  if (results.some(({ r }) => r.status !== "passed")) reasons.push("not passed");
  const attached = (r, name) => r.attachments.some((a) => a.name === name && a.path && existsSync(a.path));
  if (results.some(({ r }) => !attached(r, "video") || !attached(r, "trace"))) reasons.push("no video or trace");
  if (!shaOk) reasons.push("sha mismatch or dirty source");
  return { id, tests: mine.length, status: reasons.length ? "FAIL" : "PASS", reasons: reasons.join(", ") };
});

console.table(rows);
console.log(`head ${head.slice(0, 10)}  saved ${savedSha.slice(0, 10)}  dirty source: ${dirty === "" ? "no" : "yes"}`);
process.exit(rows.every((r) => r.status === "PASS") ? 0 : 1);
