import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Claim } from "./gate.ts";

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
