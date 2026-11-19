import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MAIN = fileURLToPath(new URL("../packages/cli/src/main.ts", import.meta.url));

export type Result = { code: number; stdout: string; stderr: string };

// node --test sets NODE_TEST_CONTEXT. A nested node --test then skips its files, so no child may inherit it.
const clean = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const { NODE_TEST_CONTEXT: _skip, ...rest } = env;
  return rest;
};

export function exec(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: clean(opts.env), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => resolve({ code: 127, stdout, stderr: String(e) }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(opts.input ?? "");
  });
}

export function start(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): { child: ChildProcess; out: () => string } {
  const child = spawn(cmd, args, { cwd: opts.cwd, env: clean(opts.env), stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  let out = "";
  child.stdout?.on("data", (d) => (out += d));
  return { child, out: () => out };
}

export function makeWork(): { dir: string; remove: () => void } {
  const keep = process.env.WORK;
  if (keep) mkdirSync(keep, { recursive: true });
  const dir = realpathSync(keep ?? mkdtempSync(join(tmpdir(), "awb-e2e-")));
  return { dir, remove: () => (keep ? console.error(`work dir kept: ${dir}`) : rmSync(dir, { recursive: true, force: true })) };
}

export const gitEnv = (env: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
  ...env,
});

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await exec("git", ["-c", `core.hooksPath=${devNull}`, ...args], { cwd, env: gitEnv() });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

export const startAwb = (args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) =>
  start(process.execPath, ["--disable-warning=ExperimentalWarning", MAIN, ...args], opts);

export const awb = (args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}) =>
  exec(process.execPath, ["--disable-warning=ExperimentalWarning", MAIN, ...args], opts);

// A command that runs a Node script. POSIX gets a shebang file, Windows gets a .cmd file.
export function stubCommand(dir: string, name: string, source: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.mjs`), source);
  if (process.platform === "win32") {
    const cmd = join(dir, `${name}.cmd`);
    writeFileSync(cmd, `@"${process.execPath}" "%~dp0${name}.mjs" %*\r\n`);
    return cmd;
  }
  const file = join(dir, name);
  writeFileSync(file, `#!/usr/bin/env node\nawait import(${JSON.stringify(join(dir, `${name}.mjs`))});\n`);
  chmodSync(file, 0o755);
  return file;
}

// An awb command for a stub that calls awb, such as a stub claude that runs awb prove.
export const awbShim = (dir: string) =>
  stubCommand(
    dir,
    "awb",
    `import { spawnSync } from "node:child_process";
const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", ${JSON.stringify(MAIN)}, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
`,
  );
