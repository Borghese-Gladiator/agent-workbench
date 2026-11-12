import { spawn } from "node:child_process";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { run } from "./prove.ts";
import { parseSetup, readRunFile } from "./run-md.ts";
import { StackError, type RepoConfig } from "./stacks.ts";
import type { RunState, Stacks, Task } from "./stacks.ts";
import type { Log } from "./log.ts";

export type { RunState };
export type Session = (task: Task, below: Task[]) => Promise<string | void>;
export type RunOpts = { onEnd?: (r: RunState) => void; log?: Log; sessionUsd?: (task: Task) => number | null; maxStacks?: number };

export function sessionEnd(out: string, timedOut: boolean, code: number | null, timeoutMin: number): string {
  if (timedOut) return `timeout after ${timeoutMin} min`;
  let last: any = null;
  for (const line of out.split("\n")) {
    if (!line.includes('"type":"result"')) continue;
    try {
      last = JSON.parse(line);
    } catch {}
  }
  if (last && last.subtype !== "success") return String(last.subtype);
  if (code !== 0) return `exit ${code}`;
  return "";
}

export function taskPrompt(task: Task, below: Task[]): string {
  return [
    `You work on one task of a stack: "${task.title}".`,
    below.length
      ? `The tasks below this one are done, and their code is on your branch: ${below.map((t) => `"${t.title}"`).join(", ")}.`
      : "This is the first task of the stack.",
    `You are on the branch ${task.branch}, and the task already exists in awb, so do not run awb stack set and do not make a branch.`,
    "The claims of this task:",
    ...task.claims.map((c) => `- ${c.id}${c.proof === "test" ? " (proven by a repo test)" : ""}: ${c.text}`),
    "Follow the playbook from step 4: check the run file with awb repo show, write the code, commit, run awb prove until every claim passes, then run awb ship.",
  ].join("\n");
}

export function lastSessionUsd(folder: string): number | null {
  if (!existsSync(folder)) return null;
  const n = (f: string) => Number(f.match(/^session-(\d+)\.jsonl$/)![1]);
  const newest = readdirSync(folder).filter((f) => /^session-\d+\.jsonl$/.test(f)).sort((a, b) => n(a) - n(b)).at(-1);
  if (!newest) return null;
  let usd: number | null = null;
  for (const line of readFileSync(join(folder, newest), "utf8").split("\n")) {
    if (!line.includes('"type":"result"')) continue;
    try {
      const r = JSON.parse(line);
      if (typeof r.total_cost_usd === "number") usd = r.total_cost_usd;
    } catch {}
  }
  return usd;
}

export function failReason(stacks: Stacks, taskId: string): string {
  const gate = stacks.history(taskId).flatMap((a) => a.gates).at(-1);
  if (!gate) return "the session ended without a PR and never ran awb prove";
  if (!gate.pass) {
    const failed = gate.result.rows.filter((r: any) => r.status === "FAIL").map((r: any) => `${r.id} ${r.reasons.join(", ")}`);
    return `the gate failed at ${gate.commit_sha.slice(0, 10)}: ${failed.join("; ")}`;
  }
  return "the gate passed, but the session ended without awb ship";
}

export async function runStack(stacks: Stacks, stackId: string, session: Session, state: RunState, opts: RunOpts = {}): Promise<RunState> {
  const end = (patch: Partial<RunState>) => {
    Object.assign(state, patch);
    stacks.saveRun(state);
    return state;
  };
  for (;;) {
    const stack = stacks.get(stackId);
    if (!stack) return end({ state: "stopped", reason: `no stack ${stackId}` });
    const i = stack.tasks.findIndex((t) => !["done", "merged", "closed"].includes(t.status));
    if (i < 0) return end({ state: "done", current: null });
    const task = stack.tasks[i];
    if (task.status !== "waiting") return end({ state: "stopped", current: task.id, reason: `task ${task.id} is ${task.status}` });

    end({ current: task.id });
    stacks.setStatus(task.id, "doing");
    const ids = { task: task.id, run: state.id, stack: stackId, repo: stack.repo };
    opts.log?.("info", "runner", "session.start", { ...ids, branch: task.branch });
    let how = "";
    try {
      how = (await session(task, stack.tasks.slice(0, i))) || "";
    } catch (err) {
      state.reason = (err as Error).message;
    }
    opts.log?.(how || state.reason ? "warn" : "info", "runner", "session.ended", { ...ids, how: how || undefined, error: state.reason ?? undefined, usd: opts.sessionUsd?.(task) ?? undefined });
    const after = stacks.task(task.id)!;
    if (after.status !== "done") {
      const base = state.reason ?? failReason(stacks, task.id);
      const reason = how ? `${base} (session: ${how})` : base;
      stacks.fail(task.id, reason);
      opts.log?.("error", "runner", "task.failed", { ...ids, reason });
      return end({ state: "stopped", reason });
    }
  }
}

const AWB = fileURLToPath(new URL("../../cli/bin/awb", import.meta.url));

export const MAX_STACKS = 5;

export function stackLimit(v: string | undefined): number {
  const n = Number(v || 2);
  if (!Number.isInteger(n) || n < 1) return 2;
  return Math.min(n, MAX_STACKS);
}

export function claudeSession(opts: { home: string; repo: string; timeoutMin: number; config?: () => RepoConfig }): Session {
  return async (task, below) => {
    const worktree = join(opts.home, "worktrees", task.id);
    if (!existsSync(worktree)) {
      mkdirSync(join(opts.home, "worktrees"), { recursive: true });
      await run("git", ["fetch", "-q", "origin"], opts.repo);
      const base = (await run("git", ["rev-parse", "--verify", "-q", task.base!], opts.repo)).code === 0 ? task.base! : `origin/${task.base}`;
      const add = await run("git", ["worktree", "add", "-b", task.branch!, worktree, base], opts.repo);
      if (add.code !== 0) throw new Error(`git worktree add failed: ${add.out.trim()}`);
      const config = opts.config?.() ?? { run_md: null, env_file: null };
      if (config.env_file) {
        if (!existsSync(config.env_file)) throw new Error(`the env file ${config.env_file} of this repo does not exist; fix it with awb repo set --env-file`);
        copyFileSync(config.env_file, join(worktree, basename(config.env_file)));
      }
      const file = readRunFile(worktree, config.run_md);
      const setup = file ? parseSetup(file.text) : null;
      if (setup) {
        const r = await run("sh", ["-c", setup], worktree);
        mkdirSync(task.folder, { recursive: true });
        writeFileSync(join(task.folder, "setup.log"), r.out);
        if (r.code !== 0) throw new Error(`the setup in the run file (${file!.source}) failed; see ${join(task.folder, "setup.log")}`);
      }
    }
    mkdirSync(task.folder, { recursive: true });
    const n = readdirSync(task.folder).filter((f) => /^session-\d+\.jsonl$/.test(f)).length + 1;
    const out = createWriteStream(join(task.folder, `session-${n}.jsonl`));
    const args = [
      "-p",
      "--permission-mode", "acceptEdits",
      "--allowedTools", "Read", "Edit", "Write", "Glob", "Grep", "Bash",
      "--output-format", "stream-json", "--verbose",
    ];
    return new Promise<string>((resolve) => {
      const child = spawn(AWB, args, { cwd: worktree, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, AWB_HOME: opts.home }, detached: true });
      let timedOut = false;
      let tail = "";
      const group = (sig: NodeJS.Signals) => {
        try {
          process.kill(-child.pid!, sig);
        } catch {}
      };
      let hard: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        group("SIGTERM");
        hard = setTimeout(() => group("SIGKILL"), 10_000);
      }, opts.timeoutMin * 60_000);
      child.stdout.on("data", (d) => (tail = (tail + d).slice(-20_000)));
      child.stdout.pipe(out);
      child.stderr.pipe(out);
      child.on("error", (err) => resolve(`could not start: ${err.message}`));
      child.on("close", (code) => {
        clearTimeout(timer);
        clearTimeout(hard);
        resolve(sessionEnd(tail, timedOut, code, opts.timeoutMin));
      });
      child.stdin.end(taskPrompt(task, below));
    });
  };
}

export function createRunner(stacks: Stacks, session: (repo: string) => Session, opts: RunOpts = {}) {
  const runs = new Map<string, RunState>();
  const active = new Map<string, string>();
  return {
    start(stackId: string): RunState {
      const busy = active.get(stackId);
      if (busy) return runs.get(busy)!;
      const max = opts.maxStacks ?? 2;
      if (active.size >= max) {
        throw new StackError(`${active.size} stacks are running and the limit is ${max} (AWB_MAX_STACKS, at most ${MAX_STACKS}); wait for one to end`);
      }
      const stack = stacks.get(stackId)!;
      const state: RunState = { id: randomUUID(), stackId, state: "running", current: null, reason: null };
      runs.set(state.id, state);
      active.set(stackId, state.id);
      stacks.saveRun(state);
      opts.log?.("info", "runner", "run.start", { run: state.id, stack: stackId, repo: stack.repo });
      runStack(stacks, stackId, session(stack.repo), state, opts)
        .catch((err) => {
          Object.assign(state, { state: "stopped", reason: (err as Error).message });
          stacks.saveRun(state);
        })
        .finally(() => {
          active.delete(stackId);
          const level = state.state === "done" ? "info" : "warn";
          opts.log?.(level, "runner", "run.end", { run: state.id, stack: stackId, task: state.current, state: state.state, reason: state.reason });
          try {
            opts.onEnd?.(state);
          } catch (err) {
            opts.log?.("warn", "runner", "notify.error", { run: state.id, error: err });
          }
        });
      return state;
    },
    get(id: string) {
      return runs.get(id) ?? stacks.run(id);
    },
    owns(taskId: string) {
      return [...active.values()].some((runId) => runs.get(runId)?.current === taskId);
    },
  };
}
