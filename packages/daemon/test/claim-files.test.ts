import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { claimHash, claimsAffected, coverageFiles, keptClaims, type Passes } from "../src/claim-files.ts";

const claims = [
  { id: "C1", text: "a", proof: "test" as const },
  { id: "C2", text: "b", proof: "test" as const },
];
const lists = new Map([
  ["C1", ["src/a.ts"]],
  ["C2", ["src/lib/"]],
]);
const ids = (changed: string[], l = lists) => claimsAffected(claims, l, changed).map((c) => c.id);

for (const [name, changed, want] of [
  ["a listed file runs its claim and keeps the other", ["src/a.ts"], ["C1"]],
  ["a folder entry covers the files under it", ["src/lib/x/y.ts"], ["C2"]],
  ["an unlisted file runs all claims", ["README.md"], ["C1", "C2"]],
  ["a lock file runs all claims", ["package-lock.json", "src/a.ts"], ["C1", "C2"]],
  ["a config file runs all claims", ["tsconfig.json"], ["C1", "C2"]],
  ["no change runs no claim", [], []],
] as const) {
  test(`claimsAffected: ${name}`, () => assert.deepEqual(ids([...changed]), want));
}

test("claimsAffected: a claim with no list runs on every change", () => {
  assert.deepEqual(ids(["src/a.ts"], new Map([["C1", ["src/a.ts"]]])), ["C1", "C2"]);
});

function coverage(worktree: string, files: Record<string, string[]>) {
  const dir = mkdtempSync(join(tmpdir(), "awb-cov-"));
  Object.entries(files).forEach(([name, urls], i) => {
    writeFileSync(join(dir, `coverage-${i}.json`), JSON.stringify({ result: [name, ...urls].map((p) => ({ url: pathToFileURL(join(worktree, p)).href })) }));
  });
  return dir;
}

test("coverageFiles lists the repo files that each test loaded, through imports too", () => {
  const wt = realpathSync(mkdtempSync(join(tmpdir(), "awb-wt-")));
  mkdirSync(join(wt, ".awb-proof"));
  const dir = coverage(wt, {
    ".awb-proof/c1.test.mjs": ["cart.mjs", "tax.mjs", "node_modules/x/index.js"],
    ".awb-proof/c2.test.mjs": ["tax.mjs"],
  });
  writeFileSync(join(dir, "coverage-9.json"), JSON.stringify({ result: [{ url: "node:internal/x" }, { url: "file:///elsewhere/y.mjs" }] }));
  writeFileSync(join(dir, "coverage-8.json"), "not json");
  assert.deepEqual([...coverageFiles(dir, wt)], [["C1", ["cart.mjs", "tax.mjs"]], ["C2", ["tax.mjs"]]]);
});

test("coverageFiles gives nothing when there is no coverage, so every claim runs", () => {
  const wt = realpathSync(mkdtempSync(join(tmpdir(), "awb-wt-")));
  assert.equal(coverageFiles(join(wt, "none"), wt).size, 0);
  assert.equal(coverageFiles(coverage(wt, {}), wt).size, 0);
});

function proofDir() {
  const dir = mkdtempSync(join(tmpdir(), "awb-kept-"));
  writeFileSync(join(dir, "c1.test.ts"), "one");
  writeFileSync(join(dir, "c2.test.ts"), "two");
  return dir;
}

const passesOf = (dir: string): Passes => ({
  C1: { sha: "s1", hash: claimHash(dir, "C1"), files: ["src/a.ts"] },
  C2: { sha: "s2", hash: claimHash(dir, "C2"), files: ["src/b.ts"] },
});

test("keptClaims keeps a claim only when its files and its test did not change", () => {
  const dir = proofDir();
  const passes = passesOf(dir);
  assert.deepEqual(keptClaims(claims, dir, passes, () => ["src/a.ts"]), { C2: "s2" });
  assert.deepEqual(keptClaims(claims, dir, passes, () => ["README.md"]), {});
  assert.deepEqual(keptClaims(claims, dir, passes, () => null), {});
  writeFileSync(join(dir, "c2.test.ts"), "changed");
  assert.deepEqual(keptClaims(claims, dir, passes, () => ["src/a.ts"]), {});
  assert.deepEqual(keptClaims(claims, dir, {}, () => ["src/a.ts"]), {});
});

test("keptClaims runs a claim that has no recorded files", () => {
  const dir = proofDir();
  const passes = passesOf(dir);
  passes.C2.files = [];
  assert.deepEqual(keptClaims(claims, dir, passes, () => ["src/a.ts"]), {});
});

test("keptClaims never keeps a claim that is not a test claim", () => {
  const dir = proofDir();
  assert.deepEqual(keptClaims([{ id: "C2", text: "b" }], dir, passesOf(dir), () => ["src/a.ts"]), {});
});
