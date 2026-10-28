import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findDaemon } from "./home.ts";

type Check = { name: string; ok: boolean; detail: string; fix?: string };

function chromiumInstalled(): boolean {
  const dir = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), "Library", "Caches", "ms-playwright");
  const linux = join(homedir(), ".cache", "ms-playwright");
  return [dir, linux].some((d) => existsSync(d) && readdirSync(d).some((n) => n.startsWith("chromium")));
}

export async function doctor(home: string): Promise<boolean> {
  const checks: Check[] = [];

  try {
    const v = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
    checks.push({ name: "claude", ok: true, detail: v });
  } catch {
    checks.push({ name: "claude", ok: false, detail: "not found on PATH", fix: "npm i -g @anthropic-ai/claude-code" });
  }

  const chromium = chromiumInstalled();
  checks.push({
    name: "chromium",
    ok: chromium,
    detail: chromium ? "Playwright Chromium found" : "no Playwright Chromium",
    fix: "npx playwright install chromium",
  });

  const daemon = await findDaemon(home);
  checks.push({
    name: "daemon",
    ok: !!daemon,
    detail: daemon ? `pid ${daemon.pid} on port ${daemon.port}` : "not running",
    fix: "awb daemon start",
  });

  for (const c of checks) {
    console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name.padEnd(9)} ${c.detail}${c.ok || !c.fix ? "" : `\n     fix: ${c.fix}`}`);
  }
  return checks.every((c) => c.ok);
}
