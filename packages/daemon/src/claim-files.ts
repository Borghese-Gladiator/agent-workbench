import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Claim } from "./gate.ts";
import { PROOF_DIR, testFileClaim } from "./proof-tests.ts";

const ALWAYS_ALL = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|requirements[\w.-]*\.txt|package\.json|pyproject\.toml|tsconfig[\w.-]*\.json|\.awb\/run\.md)$/;

export type ClaimFiles = Map<string, string[]>;
export type Passes = Record<string, { sha: string; hash: string; files: string[] }>;

const inside = (p: string, base: string) => {
  const r = relative(base, p);
  return r !== "" && !r.startsWith("..") && !isAbsolute(r);
};

export function coverageFiles(dir: string, worktree: string): ClaimFiles {
  const out: ClaimFiles = new Map();
  if (!existsSync(dir)) return out;
  const root = realpathSync(worktree);
  const proof = join(root, PROOF_DIR);
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    let paths: string[];
    try {
      const urls: string[] = (JSON.parse(readFileSync(join(dir, f), "utf8")).result ?? []).map((r: { url: string }) => r.url);
      paths = urls.filter((u) => u.startsWith("file:")).map((u) => fileURLToPath(u));
    } catch {
      continue;
    }
    const ids = paths.filter((p) => inside(p, proof)).map((p) => testFileClaim(basename(p))).filter((id): id is string => !!id);
    if (!ids.length) continue;
    const files = paths
      .filter((p) => inside(p, root) && !inside(p, proof) && !p.split(sep).includes("node_modules"))
      .map((p) => relative(root, p).split(sep).join("/"));
    for (const id of ids) out.set(id, [...new Set([...(out.get(id) ?? []), ...files])].sort());
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

export function claimHash(dir: string, id: string): string {
  const h = createHash("sha256");
  if (!existsSync(dir)) return h.digest("hex");
  for (const f of readdirSync(dir).sort()) {
    if (testFileClaim(f) !== id) continue;
    h.update(f).update("\0").update(readFileSync(join(dir, f))).update("\0");
  }
  return h.digest("hex");
}

export function keptClaims(claims: Claim[], dir: string, passes: Passes, changedSince: (sha: string) => string[] | null): Record<string, string> {
  const lists: ClaimFiles = new Map(Object.entries(passes).map(([id, p]) => [id, p.files]));
  const kept: Record<string, string> = {};
  for (const c of claims) {
    const p = passes[c.id];
    if (c.proof !== "test" || !p?.files.length || p.hash !== claimHash(dir, c.id)) continue;
    const changed = changedSince(p.sha);
    if (changed && claimsAffected([c], lists, changed).length === 0) kept[c.id] = p.sha;
  }
  return kept;
}

export function readPasses(folder: string): Passes {
  try {
    const all = JSON.parse(readFileSync(join(folder, "passes.json"), "utf8")) as Passes;
    return Object.fromEntries(Object.entries(all).filter(([, p]) => Array.isArray(p?.files)));
  } catch {
    return {};
  }
}

export const savePasses = (folder: string, passes: Passes) => writeFileSync(join(folder, "passes.json"), JSON.stringify(passes, null, 2));
