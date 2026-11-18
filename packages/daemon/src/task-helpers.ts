import { readFileSync, realpathSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, sep } from "node:path";
import type { Stacks, Task } from "./stacks.ts";
import type { CarriedTask } from "./prove.ts";

export function proofFile(home: string, path: string): string | null {
  try {
    const root = realpathSync(join(home, "tasks")) + sep;
    const real = realpathSync(path);
    return real.startsWith(root) && statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

export function branchDiff(repo: string, base: string, branch: string): string {
  const ref = (r: string) => {
    for (const c of [r, `origin/${r}`]) {
      try {
        execFileSync("git", ["rev-parse", "--verify", "-q", c], { cwd: repo, stdio: "ignore" });
        return c;
      } catch {}
    }
    return null;
  };
  const b = ref(base);
  const h = ref(branch);
  if (!b || !h) return "";
  return execFileSync("git", ["diff", `${b}...${h}`], { cwd: repo, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
}

export const TYPES: Record<string, string> = {
  ".webm": "video/webm",
  ".zip": "application/zip",
  ".png": "image/png",
  ".json": "application/json",
  ".log": "text/plain; charset=utf-8",
  ".jsonl": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export function costOf(transcript: string): number {
  let cost = 0;
  for (const line of readFileSync(transcript, "utf8").split("\n")) {
    if (!line.includes('"total_cost_usd"')) continue;
    try {
      const r = JSON.parse(line);
      if (r.type === "result") cost = Number(r.total_cost_usd) || cost;
    } catch {}
  }
  return cost;
}

export const toolCallsOf = (transcript: string) => readFileSync(transcript, "utf8").match(/"type":\s*"tool_use"/g)?.length ?? 0;

export type Json = Record<string, any>;

export function carriedClaims(stacks: Stacks, t: Task): CarriedTask[] {
  const below = stacks.get(t.stack_id)?.tasks.filter((x) => x.position < t.position) ?? [];
  return below.flatMap((x) => {
    const gate = stacks.history(x.id).flatMap((a) => a.gates).findLast((g) => g.pass);
    const passed = new Set<string>(gate ? gate.result.rows.filter((r: any) => r.status === "PASS").map((r: any) => r.id) : []);
    const claims = x.claims.filter((c) => c.proof === "test" && passed.has(c.id));
    return claims.length ? [{ label: `T${x.position + 1}`, claims, folder: x.folder }] : [];
  });
}

export function isAwbSession(pid: number): boolean {
  try {
    return /cli\/src\/main\.ts/.test(execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }));
  } catch {
    return false;
  }
}

export function stopSessions(pids: number[], isSession = isAwbSession): number[] {
  return pids.filter((pid) => {
    if (!isSession(pid)) return false;
    try {
      process.kill(pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  });
}
