import { readFileSync, openSync, closeSync, mkdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export type DaemonInfo = { pid: number; port: number; startedAt: string };

const DAEMON_MAIN = fileURLToPath(new URL("../../daemon/src/main.ts", import.meta.url));

export function awbHome(env = process.env): string {
  return resolve(env.AWB_HOME || join(homedir(), ".awb"));
}

export function readDaemonInfo(home: string): DaemonInfo | null {
  try {
    const info = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8"));
    return typeof info.pid === "number" && typeof info.port === "number" ? info : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function healthy(info: DaemonInfo, home: string): Promise<boolean> {
  if (!pidAlive(info.pid)) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/health`, { signal: AbortSignal.timeout(1000) });
    const body = await res.json();
    return res.ok && body.pid === info.pid && resolve(body.home) === home;
  } catch {
    return false;
  }
}

export async function findDaemon(home: string): Promise<DaemonInfo | null> {
  const info = readDaemonInfo(home);
  return info && (await healthy(info, home)) ? info : null;
}

function takeLock(lock: string, staleMs: number): boolean {
  try {
    closeSync(openSync(lock, "wx"));
    return true;
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs > staleMs) rmSync(lock, { force: true });
    } catch {}
    return false;
  }
}

export async function ensureDaemon(home: string, timeoutMs = 10_000): Promise<DaemonInfo> {
  const running = await findDaemon(home);
  if (running) return running;

  mkdirSync(home, { recursive: true });
  const lock = join(home, "daemon.lock");
  const deadline = Date.now() + timeoutMs;
  let owner = false;
  try {
    while (Date.now() < deadline) {
      const found = await findDaemon(home);
      if (found) return found;
      if (!owner && takeLock(lock, timeoutMs)) {
        owner = true;
        if ((await findDaemon(home)) === null) {
          const log = openSync(join(home, "daemon.log"), "a");
          spawn(process.execPath, ["--disable-warning=ExperimentalWarning", DAEMON_MAIN], {
            env: { ...process.env, AWB_HOME: home },
            detached: true,
            stdio: ["ignore", log, log],
          }).unref();
          closeSync(log);
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    if (owner) rmSync(lock, { force: true });
  }
  throw new Error(`daemon did not start in ${timeoutMs} ms; see ${join(home, "daemon.log")}`);
}

export async function api(info: DaemonInfo, path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${json.error ?? res.status}`);
  return json;
}
