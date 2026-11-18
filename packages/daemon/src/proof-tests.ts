import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Claim } from "./gate.ts";

export function testHash(dir: string): string {
  const h = createHash("sha256");
  if (!existsSync(dir)) return h.digest("hex");
  for (const f of readdirSync(dir).sort()) {
    if (!/\.(ts|js|mjs|cjs|py)$/.test(f)) continue;
    h.update(f).update("\0").update(readFileSync(join(dir, f))).update("\0");
  }
  return h.digest("hex");
}

const SPEC = /\.spec\.(ts|js)$/;
export const PROOF_DIR = ".awb-proof";

export function testFileClaim(f: string): string | null {
  if (SPEC.test(f) || !/^c\d+[._][\w.-]*\.(ts|js|mjs|cjs|py)$/i.test(f)) return null;
  return f.match(/^c\d+/i)![0].toUpperCase();
}

export const repoTests = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => testFileClaim(f)).sort() : []);

const specsText = (dir: string) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => SPEC.test(f)).map((f) => readFileSync(join(dir, f), "utf8")).join("\n") : "";

const specHasClaim = (text: string, id: string) => new RegExp(`['"\`]${id}\\b`).test(text);

export function claimsWithoutTest(claims: Claim[], dir: string): Claim[] {
  const specs = specsText(dir);
  const tested = new Set(repoTests(dir).map(testFileClaim));
  return claims.filter((c) => (c.proof === "test" ? !tested.has(c.id) : !specHasClaim(specs, c.id)));
}

export function removeTests(ids: string[], dir: string): string[] {
  if (!ids.length || !existsSync(dir)) return [];
  const removed = readdirSync(dir).filter((f) => {
    const claim = testFileClaim(f);
    if (claim) return ids.includes(claim);
    if (f === "seed.spec.ts" || !SPEC.test(f)) return false;
    const text = readFileSync(join(dir, f), "utf8");
    return ids.some((id) => specHasClaim(text, id));
  });
  for (const f of removed) rmSync(join(dir, f));
  return removed;
}
