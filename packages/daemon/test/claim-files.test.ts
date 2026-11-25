import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimHash, claimsAffected, keptClaims, readClaimFiles } from "../src/claim-files.ts";
import { testWriterPrompt } from "../src/writer.ts";

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

test("readClaimFiles reads each .files file and ignores blank lines and a leading ./", () => {
  const dir = mkdtempSync(join(tmpdir(), "awb-files-"));
  writeFileSync(join(dir, "c1.files"), "./src/a.ts\n\n  src/b.ts  \n");
  writeFileSync(join(dir, "c2.test.ts"), "");
  assert.deepEqual([...readClaimFiles(dir)], [["C1", ["src/a.ts", "src/b.ts"]]]);
});

function proofDir() {
  const dir = mkdtempSync(join(tmpdir(), "awb-kept-"));
  writeFileSync(join(dir, "c1.test.ts"), "one");
  writeFileSync(join(dir, "c1.files"), "src/a.ts\n");
  writeFileSync(join(dir, "c2.test.ts"), "two");
  writeFileSync(join(dir, "c2.files"), "src/b.ts\n");
  return dir;
}

test("keptClaims keeps a claim only when its files and its test did not change", () => {
  const dir = proofDir();
  const passes = { C1: { sha: "s1", hash: claimHash(dir, "C1") }, C2: { sha: "s2", hash: claimHash(dir, "C2") } };
  assert.deepEqual(keptClaims(claims, dir, passes, () => ["src/a.ts"]), { C2: "s2" });
  assert.deepEqual(keptClaims(claims, dir, passes, () => ["README.md"]), {});
  assert.deepEqual(keptClaims(claims, dir, passes, () => null), {});
  writeFileSync(join(dir, "c2.test.ts"), "changed");
  assert.deepEqual(keptClaims(claims, dir, passes, () => ["src/a.ts"]), {});
  assert.deepEqual(keptClaims(claims, dir, {}, () => ["src/a.ts"]), {});
});

test("keptClaims never keeps a claim that is not a test claim", () => {
  const dir = proofDir();
  const passes = { C2: { sha: "s2", hash: claimHash(dir, "C2") } };
  assert.deepEqual(keptClaims([{ id: "C2", text: "b" }], dir, passes, () => ["src/a.ts"]), {});
});

test("the test writer prompt asks for a .files file for each claim", () => {
  assert.match(testWriterPrompt(claims, "s.sh"), /c1\.files/);
});
