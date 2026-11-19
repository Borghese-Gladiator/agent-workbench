import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hide, killTree, needsShell, WIN } from "./platform.ts";
import { fill, type RunMd } from "./run-md.ts";

const PKG = fileURLToPath(new URL("..", import.meta.url));
export const PLAYWRIGHT = join(PKG, "..", "..", "node_modules", ".bin", WIN ? "playwright.cmd" : "playwright");

export const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", ...hide }).trim();

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function waitReady(url: string, ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: "manual" });
      if (r.status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`the app did not answer at ${url} in ${ms / 1000} s`);
}

export async function startApp(runMd: RunMd, cwd: string, log: (l: string) => void, seed?: string) {
  const port = await freePort();
  const url = fill(runMd.url, port).replace(/\/$/, "");
  let child: ChildProcess | null = null;
  if (runMd.start) {
    const cmd = fill(runMd.start, port, seed);
    log(`app: ${cmd}`);
    child = spawn("sh", ["-c", cmd], { cwd, stdio: "ignore", detached: true, ...hide });
    if (child.pid) groups.add(child.pid);
  }
  const stop = () => {
    if (child?.pid) {
      groups.delete(child.pid);
      try {
        killTree(child.pid);
      } catch {}
    }
    if (seed) rmSync(seed, { recursive: true, force: true });
  };
  try {
    await waitReady(url + runMd.ready, 60_000);
  } catch (err) {
    stop();
    throw err;
  }
  return { url, stop };
}

const groups = new Set<number>();

export function killChildren(): number {
  const n = groups.size;
  for (const pid of groups) {
    try {
      killTree(pid);
    } catch {}
  }
  groups.clear();
  return n;
}

export type RunResult = { code: number; out: string; stdout?: string; timedOut: boolean };

export function run(cmd: string, args: string[], cwd: string, input?: string, timeoutMs = 0, signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env, detached: true, shell: needsShell(cmd), ...hide });
    if (child.pid) groups.add(child.pid);
    let timedOut = false;
    const kill = () => {
      try {
        killTree(child.pid!);
      } catch {}
    };
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, timeoutMs)
      : null;
    if (signal?.aborted) kill();
    signal?.addEventListener("abort", kill, { once: true });
    let out = "";
    let stdout = "";
    child.stdout.on("data", (d) => ((out += d), (stdout += d)));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => resolve({ code: 127, out: String(e), stdout: "", timedOut }));
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (child.pid) groups.delete(child.pid);
      signal?.removeEventListener("abort", kill);
      resolve({ code: code ?? 1, out, stdout, timedOut });
    });
    child.stdin.end(input ?? "");
  });
}
