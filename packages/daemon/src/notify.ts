import { spawn } from "node:child_process";
import type { RunState, Stacks } from "./stacks.ts";
import type { Log } from "./log.ts";

export function runMessage(stacks: Stacks, r: RunState): { title: string; body: string } {
  const stack = stacks.get(r.stackId);
  const repo = stack?.repo.split("/").at(-1) ?? "awb";
  const task = r.current ? stacks.task(r.current) : undefined;
  if (r.state === "done") return { title: `awb: ${repo} stack done`, body: `${stack?.tasks.length ?? 0} task(s) shipped` };
  return { title: `awb: ${repo} stack stopped`, body: `${task ? task.title + ": " : ""}${r.reason ?? "no reason"}`.slice(0, 240) };
}

export function notify(title: string, body: string, env = process.env, log: Log = () => {}) {
  if (env.AWB_NOTIFY === "0") return;
  const custom = env.AWB_NOTIFY_CMD;
  const [cmd, args] = custom
    ? [custom, [title, body]]
    : process.platform === "darwin"
      ? ["osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, body]]
      : ["notify-send", [title, body]];
  const failed = (err: unknown) => log("warn", "notify", "error", { cmd, error: err });
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", failed).unref();
    log("info", "notify", "sent", { title });
  } catch (err) {
    failed(err);
  }
}
