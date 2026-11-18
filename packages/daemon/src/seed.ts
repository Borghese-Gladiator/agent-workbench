import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quote, type Seed } from "./run-md.ts";
import { run } from "./process.ts";

export async function seedCache(seed: Seed, worktree: string, dir: string, proof: string, log: (l: string) => void): Promise<string> {
  const h = createHash("sha256").update(seed.cmd);
  for (const f of seed.key) h.update("\0").update(f).update("\0").update(readFileSync(join(worktree, f)));
  const cache = join(dir, h.digest("hex").slice(0, 16));
  if (existsSync(cache)) return cache;
  mkdirSync(dir, { recursive: true });
  const tmp = mkdtempSync(join(dir, ".tmp-"));
  log(`seed: ${seed.cmd}`);
  const r = await run("sh", ["-c", seed.cmd.replaceAll("{seed}", quote(tmp))], worktree);
  if (r.code !== 0) {
    rmSync(tmp, { recursive: true, force: true });
    writeFileSync(join(proof, "seed.log"), r.out);
    throw new Error(`the seed command failed with exit ${r.code}; see ${join(proof, "seed.log")}`);
  }
  try {
    renameSync(tmp, cache);
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    if (!existsSync(cache)) throw err;
  }
  return cache;
}

export function seedCopy(cache: string): string {
  const copy = mkdtempSync(join(tmpdir(), "awb-seed-"));
  cpSync(cache, copy, { recursive: true });
  return copy;
}
