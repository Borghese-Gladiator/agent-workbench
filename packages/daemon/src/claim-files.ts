import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Claim } from "./gate.ts";
import { testFileClaim } from "./proof-tests.ts";

const ALWAYS_ALL = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|requirements[\w.-]*\.txt|package\.json|pyproject\.toml|tsconfig[\w.-]*\.json|\.awb\/run\.md)$/;

export type ClaimFiles = Map<string, string[]>;

export function readClaimFiles(dir: string): ClaimFiles {
  const out: ClaimFiles = new Map();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const m = f.match(/^(c\d+)\.files$/i);
    if (!m) continue;
    const paths = readFileSync(join(dir, f), "utf8").split("\n").map((l) => l.trim().replace(/^\.\//, "")).filter(Boolean);
    if (paths.length) out.set(m[1].toUpperCase(), paths);
  }
  return out;
}

const covers = (entry: string, file: string) => file === entry || file.startsWith(entry.replace(/\/?$/, "/"));

export function claimsAffected(claims: Claim[], lists: ClaimFiles, changed: string[]): Claim[] {
  if (!changed.length) return [];
  const all = [...lists.values()].flat();
  const everything = changed.some((f) => ALWAYS_ALL.test(f) || !all.some((e) => covers(e, f)));
  return claims.filter((c) => {
    const own = lists.get(c.id);
    return everything || !own || changed.some((f) => own.some((e) => covers(e, f)));
  });
}

export type Passes = Record<string, { sha: string; hash: string }>;

export function claimHash(dir: string, id: string): string {
  const h = createHash("sha256");
  if (!existsSync(dir)) return h.digest("hex");
  for (const f of readdirSync(dir).sort()) {
    if (testFileClaim(f) !== id && f.toLowerCase() !== `${id.toLowerCase()}.files`) continue;
    h.update(f).update("\0").update(readFileSync(join(dir, f))).update("\0");
  }
  return h.digest("hex");
}

export function keptClaims(claims: Claim[], dir: string, passes: Passes, changedSince: (sha: string) => string[] | null): Record<string, string> {
  const lists = readClaimFiles(dir);
  const kept: Record<string, string> = {};
  for (const c of claims) {
    const p = passes[c.id];
    if (c.proof !== "test" || !p || p.hash !== claimHash(dir, c.id)) continue;
    const changed = changedSince(p.sha);
    if (changed && claimsAffected([c], lists, changed).length === 0) kept[c.id] = p.sha;
  }
  return kept;
}

export function readPasses(folder: string): Passes {
  try {
    return JSON.parse(readFileSync(join(folder, "passes.json"), "utf8"));
  } catch {
    return {};
  }
}

export const savePasses = (folder: string, passes: Passes) => writeFileSync(join(folder, "passes.json"), JSON.stringify(passes, null, 2));
