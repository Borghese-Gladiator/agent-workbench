import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { findDaemon } from "./home.ts";
import { readLog } from "../../daemon/src/log.ts";

export type Check = { name: string; ok: boolean; detail: string; fix?: string };

const getJson = async (url: string) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return r.json();
};

export async function logChecks(logDir: string, alloy: string, loki: string, maxLagMs = 120_000, tailed = logDir): Promise<Check[]> {
  try {
    const r = await fetch(`${alloy}/-/ready`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) throw new Error(`answered ${r.status}`);
  } catch {
    return [{ name: "alloy", ok: true, detail: `off (no answer on ${alloy}); the remote log view is optional` }];
  }
  const checks: Check[] = [{ name: "alloy", ok: true, detail: `ready on ${alloy}` }];
  if (resolve(tailed) !== resolve(logDir)) {
    return [...checks, { name: "loki", ok: true, detail: `skipped: Alloy reads ${tailed}, not ${logDir}` }];
  }
  const local = readLog(logDir, { limit: 1 }).at(-1);
  if (!local) return [...checks, { name: "loki", ok: true, detail: "no local log line yet" }];
  const start = (Date.parse(local.ts) - 86_400_000) * 1e6;
  try {
    const q = new URLSearchParams({ query: '{job="awb"}', limit: "1", direction: "backward", start: String(start) });
    const res = await getJson(`${loki}/loki/api/v1/query_range?${q}`);
    const newest = Math.max(0, ...res.data.result.flatMap((s: any) => s.values.map((v: [string, string]) => Number(v[0]) / 1e6)));
    const lag = Date.parse(local.ts) - newest;
    const ok = lag <= maxLagMs;
    const detail = !newest
      ? "has no awb line from the last day"
      : ok
        ? `current (newest line ${new Date(newest).toISOString()})`
        : `${Math.round(lag / 60_000)} min behind the local log`;
    return [...checks, { name: "loki", ok: !!newest && ok, detail, fix: "docker compose -f infra/logging/docker-compose.yml logs alloy" }];
  } catch (err) {
    return [...checks, { name: "loki", ok: false, detail: (err as Error).message, fix: "docker compose -f infra/logging/docker-compose.yml up -d" }];
  }
}

function chromiumInstalled(): boolean {
  const dir = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), "Library", "Caches", "ms-playwright");
  const linux = join(homedir(), ".cache", "ms-playwright");
  return [dir, linux].some((d) => existsSync(d) && readdirSync(d).some((n) => n.startsWith("chromium")));
}

export const MCP_SERVERS = ["slack", "sentry", "linear-server"];

export function mcpChecks(listing: string | null, servers = MCP_SERVERS): Check[] {
  if (listing === null) {
    return [{ name: "mcp", ok: false, detail: "claude mcp list failed", fix: "claude mcp list" }];
  }
  const state = new Map<string, string>();
  for (const line of listing.split("\n")) {
    const m = line.match(/^([\w-]+): .* - (✔|!|✘)/);
    if (m) state.set(m[1], m[2]);
  }
  return servers.map((name) => {
    const s = state.get(name);
    if (s === "✔") return { name, ok: true, detail: "MCP server connected" };
    if (s === "!") return { name, ok: false, detail: "MCP server needs authentication", fix: "run /mcp in claude and authenticate" };
    if (s === "✘") return { name, ok: false, detail: "MCP server failed to connect", fix: "run /mcp in claude" };
    return { name, ok: false, detail: "MCP server not configured", fix: `claude mcp add ${name}` };
  });
}

function mcpListing(): string | null {
  try {
    return execFileSync("claude", ["mcp", "list"], { encoding: "utf8", timeout: 60_000 });
  } catch {
    return null;
  }
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

  checks.push(...mcpChecks(mcpListing()));

  checks.push(
    ...(await logChecks(join(home, "logs"), process.env.AWB_ALLOY_URL || "http://127.0.0.1:12345", process.env.AWB_LOKI_URL || "http://127.0.0.1:3100", undefined, process.env.AWB_LOGS || join(homedir(), ".awb", "logs"))),
  );

  for (const c of checks) {
    console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name.padEnd(9)} ${c.detail}${c.ok || !c.fix ? "" : `\n     fix: ${c.fix}`}`);
  }
  return checks.every((c) => c.ok);
}
