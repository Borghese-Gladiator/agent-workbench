import { spawn } from "node:child_process";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { hide, killTree } from "./platform.ts";
import { run } from "./prove.ts";
import { envFilePath, findRunFile, parseSetup } from "./run-md.ts";
import { FINISHED, RESTART_REASON, StackError } from "./stacks.ts";
import type { RunState, Stacks, Task } from "./stacks.ts";
import type { Log } from "./log.ts";

export type { RunState };
export type Session = (task: Task, below: Task[], resume?: boolean, signal?: AbortSignal) => Promise<string | void>;
export type RunOpts = { onEnd?: (r: RunState) => void; log?: Log; sessionUsd?: (task: Task) => number | null; maxStacks?: number | (() => number); signal?: AbortSignal; targets?: string[]; softStop?: () => boolean };

export const STOPPED = "stopped by awb stop";

export const STOPPED_BY_YOU = "stopped by you";

export const RESUME_PROMPT = "Continue the task. The last session stopped on an API error.";

export function transientError(text: string): string | null {
  return text.match(/API Error: (429|5\d\d)\b|overloaded|Connection error|ECONNREFUSED|ECONNRESET|fetch failed/i)?.[0] ?? null;
}

export function initSessionId(out: string): string | null {
  for (const line of out.split("\n")) {
    if (!line.includes('"subtype":"init"')) continue;
    try {
      const j = JSON.parse(line);
      if (j.type === "system" && typeof j.session_id === "string") return j.session_id;
    } catch {}
  }
  return null;
}

export function sessionEnd(out: string, timedOut: boolean, code: number | null, timeoutMin: number): string {
  if (timedOut) return `timeout after ${timeoutMin} min`;
  let last: any = null;
  for (const line of out.split("\n")) {
    if (!line.includes('"type":"result"')) continue;
    try {
      last = JSON.parse(line);
    } catch {}
  }
  const fail = last && last.subtype !== "success" ? String(last.subtype) : code !== 0 ? `exit ${code}` : "";
  if (!fail && !last?.is_error) return "";
  const api = transientError(last ? String(last.result ?? "") : out.split("\n").slice(-20).join("\n"));
  return api ? `${fail || "error"}: ${api}` : fail;
}

export function taskPrompt(task: Task, below: Task[]): string {
  return [
    `You work on one task of a stack: "${task.title}".`,
    below.length
      ? `The tasks below this one are done, and their code is on your branch: ${below.map((t) => `"${t.title}"`).join(", ")}.`
      : "This is the first task of the stack.",
    `You are on the branch ${task.branch}, and the task already exists in awb, so do not run awb stack set and do not make a branch.`,
    `The context of this task: ${task.context}`,
    `The description of this task: ${task.description}`,
    "These two texts become the first two sections of the PR body. If the work changes what they say, ask the user to run awb stack set again.",
    "The claims of this task:",
    ...task.claims.map((c) => `- ${c.id}${c.proof === "test" ? " (proven by a repo test)" : ""}: ${c.text}`),
    "Follow the playbook from step 4: check the run file, write the code, commit, run awb prove until every claim passes, then run awb ship.",
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
    const i = stack.tasks.findIndex((t) => !FINISHED.includes(t.status));
    if (i < 0) return end({ state: "done", current: null });
    if (opts.softStop?.()) return end({ state: "stopped", current: stack.tasks[i].id, reason: STOPPED_BY_YOU });
    const task = stack.tasks[i];
    if (opts.targets) {
      const left = opts.targets.filter((id) => !FINISHED.includes(stack.tasks.find((t) => t.id === id)?.status ?? "done"));
      if (!left.length) return end({ state: "done", current: null });
      if (!left.includes(task.id)) return end({ state: "stopped", current: task.id, reason: `task ${task.id} is ${task.status} and is not a target of this run` });
    }
    if (task.status !== "waiting") return end({ state: "stopped", current: task.id, reason: `task ${task.id} is ${task.status}` });
    if (opts.signal?.aborted) return end({ state: "stopped", reason: STOPPED });

    end({ current: task.id });
    stacks.setStatus(task.id, "doing");
    const ids = { task: task.id, run: state.id, stack: stackId, repo: stack.repo };
    opts.log?.("info", "runner", "session.start", { ...ids, branch: task.branch });
    let how = "";
    for (let n = 0; ; n++) {
      try {
        how = (await session(task, stack.tasks.slice(0, i), n > 0, opts.signal)) || "";
      } catch (err) {
        state.reason = (err as Error).message;
      }
      opts.log?.(how || state.reason ? "warn" : "info", "runner", "session.ended", { ...ids, how: how || undefined, error: state.reason ?? undefined, usd: opts.sessionUsd?.(task) ?? undefined });
      if (n >= (state.retries ?? 1) || state.reason || opts.signal?.aborted || stacks.task(task.id)!.status === "done" || !transientError(how)) break;
      opts.log?.("warn", "runner", "session.retry", { ...ids, attempt: n + 1, how });
    }
    const after = stacks.task(task.id)!;
    if (after.status !== "done") {
      const base = state.reason ?? failReason(stacks, task.id);
      const reason = opts.signal?.aborted ? STOPPED : how ? `${base} (session: ${how})` : base;
      stacks.fail(task.id, reason);
      opts.log?.("error", "runner", "task.failed", { ...ids, reason });
      return end({ state: "stopped", reason });
    }
  }
}

const AWB_MAIN = fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url));

export const MAX_STACKS = 5;

export function retryCount(v: unknown): number {
  if (v === undefined || v === null) return 1;
  const n = typeof v === "number" ? v : /^\d+$/.test(String(v)) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > 5) throw new StackError(`retries must be an integer from 0 to 5, not ${v}`, 400);
  return n;
}

export function stackLimit(v: string | undefined): number {
  const n = Number(v || 2);
  if (!Number.isInteger(n) || n < 1) return 2;
  return Math.min(n, MAX_STACKS);
}

export function claudeSession(opts: { home: string; repo: string; timeoutMin: number }): Session {
  const claudeIds = new Map<string, string>();
  return async (task, below, resume = false, signal) => {
    const worktree = join(opts.home, "worktrees", task.id);
    if (!existsSync(worktree)) {
      mkdirSync(join(opts.home, "worktrees"), { recursive: true });
      await run("git", ["fetch", "-q", "origin"], opts.repo, "", 0, signal);
      const base = (await run("git", ["rev-parse", "--verify", "-q", task.base!], opts.repo)).code === 0 ? task.base! : `origin/${task.base}`;
      const add = await run("git", ["worktree", "add", "-b", task.branch!, worktree, base], opts.repo);
      if (add.code !== 0) throw new Error(`git worktree add failed: ${add.out.trim()}`);
      const env = envFilePath(opts.home, opts.repo);
      if (existsSync(env)) copyFileSync(env, join(worktree, ".env"));
      const runMdFile = findRunFile(opts.home, opts.repo, worktree);
      const setup = runMdFile ? parseSetup(readFileSync(runMdFile, "utf8")) : null;
      if (setup) {
        const r = await run("sh", ["-c", setup], worktree, "", 0, signal);
        mkdirSync(task.folder, { recursive: true });
        writeFileSync(join(task.folder, "setup.log"), r.out);
        if (r.code !== 0) throw new Error(`the setup in ${runMdFile} failed; see ${join(task.folder, "setup.log")}`);
      }
    }
    if (signal?.aborted) return STOPPED;
    mkdirSync(task.folder, { recursive: true });
    const n = readdirSync(task.folder).filter((f) => /^session-\d+\.jsonl$/.test(f)).length + 1;
    const out = createWriteStream(join(task.folder, `session-${n}.jsonl`));
    const claudeId = resume ? claudeIds.get(task.id) : undefined;
    const args = [
      ...(claudeId ? ["--resume", claudeId] : []),
      "-p",
      "--permission-mode", "acceptEdits",
      "--allowedTools", "Read", "Edit", "Write", "Glob", "Grep", "Bash",
      "--output-format", "stream-json", "--verbose",
    ];
    return new Promise<string>((resolve) => {
      const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", AWB_MAIN, ...args], { cwd: worktree, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, AWB_HOME: opts.home, AWB_SESSION_DEADLINE: String(Date.now() + opts.timeoutMin * 60_000) }, detached: true, ...hide });
      let timedOut = false;
      let tail = "";
      let head = "";
      const group = (sig: NodeJS.Signals) => {
        try {
          killTree(child.pid!, sig);
        } catch {}
      };
      let hard: NodeJS.Timeout | undefined;
      const kill = () => {
        group("SIGTERM");
        hard = setTimeout(() => group("SIGKILL"), 10_000);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, opts.timeoutMin * 60_000);
      signal?.addEventListener("abort", kill, { once: true });
      child.stdout.on("data", (d) => {
        tail = (tail + d).slice(-20_000);
        if (head.length < 200_000) head += d;
      });
      child.stdout.pipe(out);
      child.stderr.pipe(out);
      child.on("error", (err) => resolve(`could not start: ${err.message}`));
      child.on("close", (code) => {
        clearTimeout(timer);
        clearTimeout(hard);
        signal?.removeEventListener("abort", kill);
        const id = initSessionId(head);
        if (id) claudeIds.set(task.id, id);
        resolve(sessionEnd(tail, timedOut, code, opts.timeoutMin));
      });
      child.stdin.end(claudeId ? RESUME_PROMPT : taskPrompt(task, below));
    });
  };
}

export function createRunner(stacks: Stacks, session: (repo: string) => Session, opts: RunOpts = {}) {
  const runs = new Map<string, RunState>();
  const active = new Map<string, string>();
  const stops = new Map<string, { ctrl: AbortController; done: Promise<RunState> }>();
  const soft = new Set<string>();
  return {
    start(stackId: string, retries = 1, targets?: string[]): RunState {
      const busy = active.get(stackId);
      if (busy) return runs.get(busy)!;
      const max = (typeof opts.maxStacks === "function" ? opts.maxStacks() : opts.maxStacks) ?? 2;
      if (active.size >= max) {
        throw new StackError(`${active.size} stacks are running and the limit is ${max} (awb limit <n>, at most ${MAX_STACKS}); wait for one to end`);
      }
      const stack = stacks.get(stackId)!;
      const state: RunState = { id: randomUUID(), stackId, state: "running", current: null, reason: null, retries };
      runs.set(state.id, state);
      active.set(stackId, state.id);
      stacks.saveRun(state);
      opts.log?.("info", "runner", "run.start", { run: state.id, stack: stackId, repo: stack.repo });
      const ctrl = new AbortController();
      const done = runStack(stacks, stackId, session(stack.repo), state, { ...opts, signal: ctrl.signal, targets, softStop: () => soft.has(stackId) })
        .catch((err) => {
          Object.assign(state, { state: "stopped", reason: (err as Error).message });
          stacks.saveRun(state);
        })
        .finally(() => {
          active.delete(stackId);
          stops.delete(stackId);
          soft.delete(stackId);
          const level = state.state === "done" ? "info" : "warn";
          opts.log?.(level, "runner", "run.end", { run: state.id, stack: stackId, task: state.current, state: state.state, reason: state.reason });
          try {
            opts.onEnd?.(state);
          } catch (err) {
            opts.log?.("warn", "runner", "notify.error", { run: state.id, error: err });
          }
        })
        .then(() => state);
      stops.set(stackId, { ctrl, done });
      return state;
    },
    stop(stackId: string): Promise<RunState> | null {
      const s = stops.get(stackId);
      if (!s) return null;
      s.ctrl.abort();
      return s.done;
    },
    stopAfterTask(stackId: string): RunState | null {
      const busy = active.get(stackId);
      if (!busy) return null;
      soft.add(stackId);
      return runs.get(busy)!;
    },
    count() {
      return active.size;
    },
    get(id: string) {
      return runs.get(id) ?? stacks.run(id);
    },
    owns(taskId: string) {
      return [...active.values()].some((runId) => runs.get(runId)?.current === taskId);
    },
  };
}

export function resumeStopped(stacks: Stacks, runner: ReturnType<typeof createRunner>, retries = 1) {
  const started: RunState[] = [];
  const skipped: { stack: string; reason: string }[] = [];
  for (const stackId of stacks.restartedStacks()) {
    const stack = stacks.get(stackId);
    if (!stack) continue;
    stack.tasks.filter((t) => t.status === "failed" && t.fail_reason?.startsWith(RESTART_REASON)).forEach((t) => stacks.retry(t.id));
    const next = stacks.get(stackId)!.tasks.find((t) => !FINISHED.includes(t.status));
    if (!next || next.status !== "waiting") {
      skipped.push({ stack: stackId, reason: next ? `task ${next.id} is ${next.status}` : "every task is finished" });
      continue;
    }
    try {
      started.push(runner.start(stackId, retries));
    } catch (err) {
      skipped.push({ stack: stackId, reason: (err as Error).message });
    }
  }
  stacks.markResumed();
  return { started, skipped };
}
