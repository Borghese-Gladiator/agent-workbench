import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { findDaemon } from "./home.ts";
import { hookCommand } from "./launch.ts";
import { createRequire } from "node:module";
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
  const linux = process.platform === "win32" ? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "ms-playwright") : join(homedir(), ".cache", "ms-playwright");
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
    return execFileSync("claude", ["mcp", "list"], { encoding: "utf8", timeout: 60_000, shell: process.platform === "win32", windowsHide: true });
  } catch {
    return null;
  }
}

const playwrightCli = () => {
  try {
    return createRequire(import.meta.url).resolve("@playwright/test/cli");
  } catch {
    return "@playwright/test/cli.js";
  }
};

export function toolCheck(name: string, cmd: string, args: string[], fix: string): Check {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 20_000, windowsHide: true });
  if (r.error || r.status !== 0) return { name, ok: false, detail: r.error ? r.error.message : `exit ${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 200)}`, fix };
  return { name, ok: true, detail: (r.stdout || r.stderr).trim().split("\n")[0] };
}

export async function hookCheck(home: string, daemon: { port: number } | null): Promise<Check> {
  const fix = "install Git for Windows and run awb from a shell where sh is on the PATH";
  if (!daemon) return { name: "hook", ok: false, detail: "the daemon is not running, so the hook cannot be tested", fix: "awb daemon start" };
  const session = await fetch(`http://127.0.0.1:${daemon.port}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo: "/doctor", worktree: "/doctor", branch: "doctor", pid: process.pid }),
  }).then((r) => r.json() as Promise<{ id: string }>);
  try {
    const r = spawnSync("sh", ["-c", `${hookCommand()}`], {
      input: JSON.stringify({ hook_event_name: "Notification" }),
      env: { ...process.env, AWB_HOME: home, AWB_SESSION_ID: session.id },
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });
    const events = (await (await fetch(`http://127.0.0.1:${daemon.port}/api/sessions/${session.id}/events`)).json()) as unknown[];
    const ok = r.status === 0 && events.length === 1;
    return { name: "hook", ok, detail: ok ? "the hook script ran under sh and the event reached the daemon" : `exit ${r.status}, ${events.length} events: ${(r.error?.message ?? r.stderr ?? "").trim().slice(0, 200)}`, fix };
  } finally {
    await fetch(`http://127.0.0.1:${daemon.port}/api/sessions/${session.id}/end`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => {});
  }
}

export async function doctor(home: string): Promise<boolean> {
  const checks: Check[] = [];

  try {
    const v = execFileSync("claude", ["--version"], { encoding: "utf8", shell: process.platform === "win32", windowsHide: true }).trim();
    checks.push({ name: "claude", ok: true, detail: v });
  } catch {
    checks.push({ name: "claude", ok: false, detail: "not found on PATH", fix: "npm i -g @anthropic-ai/claude-code" });
  }

  checks.push(toolCheck("sh", "sh", ["-c", "echo sh"], "install Git for Windows and put its usr/bin on the PATH"));
  checks.push(toolCheck("git", "git", ["--version"], "install git and put it on the PATH"));
  checks.push(toolCheck("playwright", process.execPath, [playwrightCli(), "--version"], "npm ci, then npx playwright install chromium"));

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

  checks.push(await hookCheck(home, daemon));

  checks.push(...mcpChecks(mcpListing()));

  checks.push(
    ...(await logChecks(join(home, "logs"), process.env.AWB_ALLOY_URL || "http://127.0.0.1:12345", process.env.AWB_LOKI_URL || "http://127.0.0.1:3100", undefined, process.env.AWB_LOGS || join(home, "logs"))),
  );

  for (const c of checks) {
    console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name.padEnd(9)} ${c.detail}${c.ok || !c.fix ? "" : `\n     fix: ${c.fix}`}`);
  }
  return checks.every((c) => c.ok);
}
