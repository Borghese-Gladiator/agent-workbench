import { spawn } from "node:child_process";
import { basenameOf, hide } from "./platform.ts";
import type { RunState, Stacks } from "./stacks.ts";
import type { Log } from "./log.ts";

export function runMessage(stacks: Stacks, r: RunState): { title: string; body: string } {
  const stack = stacks.get(r.stackId);
  const repo = (stack && basenameOf(stack.repo)) || "awb";
  const task = r.current ? stacks.task(r.current) : undefined;
  if (r.state === "done") return { title: `awb: ${repo} stack done`, body: `${stack?.tasks.length ?? 0} task(s) shipped` };
  return { title: `awb: ${repo} stack stopped`, body: `${task ? task.title + ": " : ""}${r.reason ?? "no reason"}`.slice(0, 240) };
}

const BALLOON = [
  "Add-Type -AssemblyName System.Windows.Forms, System.Drawing",
  "$n = New-Object System.Windows.Forms.NotifyIcon",
  "$n.Icon = [System.Drawing.SystemIcons]::Information",
  "$n.Visible = $true",
  "$n.ShowBalloonTip(10000, $env:AWB_NOTIFY_TITLE, $env:AWB_NOTIFY_BODY, 'Info')",
  "Start-Sleep -Seconds 10",
  "$n.Dispose()",
].join("; ");

export type NotifyCommand = { cmd: string; args: string[]; env?: Record<string, string> };

export function notifyCommand(title: string, body: string, custom?: string, platform = process.platform): NotifyCommand {
  if (custom) return { cmd: custom, args: [title, body] };
  if (platform === "darwin") {
    return { cmd: "osascript", args: ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, body] };
  }
  if (platform === "win32") {
    return { cmd: "powershell", args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", BALLOON], env: { AWB_NOTIFY_TITLE: title, AWB_NOTIFY_BODY: body } };
  }
  return { cmd: "notify-send", args: [title, body] };
}

export function notify(title: string, body: string, env = process.env, log: Log = () => {}) {
  if (env.AWB_NOTIFY === "0") return;
  const { cmd, args, env: extra } = notifyCommand(title, body, env.AWB_NOTIFY_CMD);
  const failed = (err: unknown) => log("warn", "notify", "error", { cmd, error: err });
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true, env: { ...process.env, ...extra }, ...hide }).on("error", failed).unref();
    log("info", "notify", "sent", { title });
  } catch (err) {
    failed(err);
  }
}
