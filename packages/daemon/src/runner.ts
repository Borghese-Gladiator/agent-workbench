import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { run } from "./prove.ts";
import { parseSetup } from "./recipe.ts";
import type { Stacks, Task } from "./stacks.ts";

export type RunState = { id: string; stackId: string; state: "running" | "done" | "stopped"; current: string | null; reason: string | null };
export type Session = (task: Task, below: Task[]) => Promise<void>;

export function taskPrompt(task: Task, below: Task[]): string {
  return [
    `You work on one task of a stack: "${task.title}".`,
    below.length
      ? `The tasks below this one are done, and their code is on your branch: ${below.map((t) => `"${t.title}"`).join(", ")}.`
      : "This is the first task of the stack.",
    `You are on the branch ${task.branch}, and the task already exists in awb, so do not run awb stack set and do not make a branch.`,
    "The claims of this task:",
    ...task.claims.map((c) => `- ${c.id}: ${c.text}`),
    "Follow the playbook from step 4: check .awb/run.md, write the code, commit, run awb prove until every claim passes, then run awb ship.",
  ].join("\n");
}

export async function runStack(stacks: Stacks, stackId: string, session: Session, state: RunState): Promise<RunState> {
  for (;;) {
    const stack = stacks.get(stackId);
    if (!stack) return Object.assign(state, { state: "stopped", reason: `no stack ${stackId}` });
    const i = stack.tasks.findIndex((t) => !["done", "merged", "closed"].includes(t.status));
    if (i < 0) return Object.assign(state, { state: "done", current: null });
    const task = stack.tasks[i];
    if (task.status !== "waiting") return Object.assign(state, { state: "stopped", current: task.id, reason: `task ${task.id} is ${task.status}` });

    state.current = task.id;
    stacks.setStatus(task.id, "doing");
    try {
      await session(task, stack.tasks.slice(0, i));
    } catch (err) {
      state.reason = (err as Error).message;
    }
    const after = stacks.task(task.id)!;
    if (after.status !== "done") {
      stacks.setStatus(task.id, "failed");
      return Object.assign(state, { state: "stopped", reason: state.reason ?? `task ${task.id} ended without a PR` });
    }
  }
}

const AWB = fileURLToPath(new URL("../../cli/bin/awb", import.meta.url));

export function claudeSession(opts: { home: string; repo: string; budgetUsd: number; timeoutMin: number }): Session {
  return async (task, below) => {
    const worktree = join(opts.home, "worktrees", task.id);
    if (!existsSync(worktree)) {
      mkdirSync(join(opts.home, "worktrees"), { recursive: true });
      await run("git", ["fetch", "-q", "origin"], opts.repo);
      const base = (await run("git", ["rev-parse", "--verify", "-q", task.base!], opts.repo)).code === 0 ? task.base! : `origin/${task.base}`;
      const add = await run("git", ["worktree", "add", "-b", task.branch!, worktree, base], opts.repo);
      if (add.code !== 0) throw new Error(`git worktree add failed: ${add.out.trim()}`);
      const recipe = join(worktree, ".awb", "run.md");
      const setup = existsSync(recipe) ? parseSetup(readFileSync(recipe, "utf8")) : null;
      if (setup) {
        const r = await run("sh", ["-c", setup], worktree);
        mkdirSync(task.folder, { recursive: true });
        writeFileSync(join(task.folder, "setup.log"), r.out);
        if (r.code !== 0) throw new Error(`the setup in .awb/run.md failed; see ${join(task.folder, "setup.log")}`);
      }
    }
    mkdirSync(task.folder, { recursive: true });
    const n = readdirSync(task.folder).filter((f) => /^session-\d+\.jsonl$/.test(f)).length + 1;
    const out = createWriteStream(join(task.folder, `session-${n}.jsonl`));
    const args = [
      "-p",
      "--permission-mode", "acceptEdits",
      "--allowedTools", "Read", "Edit", "Write", "Glob", "Grep", "Bash",
      "--max-budget-usd", String(opts.budgetUsd),
      "--output-format", "stream-json", "--verbose",
    ];
    await new Promise<void>((resolve) => {
      const child = spawn(AWB, args, { cwd: worktree, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, AWB_HOME: opts.home } });
      const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMin * 60_000);
      child.stdout.pipe(out);
      child.stderr.pipe(out);
      child.on("error", () => resolve());
      child.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin.end(taskPrompt(task, below));
    });
  };
}

export function createRunner(stacks: Stacks, session: (repo: string) => Session) {
  const runs = new Map<string, RunState>();
  const active = new Map<string, string>();
  return {
    start(stackId: string): RunState {
      const busy = active.get(stackId);
      if (busy) return runs.get(busy)!;
      const stack = stacks.get(stackId)!;
      const state: RunState = { id: randomUUID(), stackId, state: "running", current: null, reason: null };
      runs.set(state.id, state);
      active.set(stackId, state.id);
      runStack(stacks, stackId, session(stack.repo), state)
        .catch((err) => Object.assign(state, { state: "stopped", reason: (err as Error).message }))
        .finally(() => active.delete(stackId));
      return state;
    },
    get(id: string) {
      return runs.get(id);
    },
  };
}
