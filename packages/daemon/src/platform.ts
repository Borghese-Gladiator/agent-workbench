import { execFileSync } from "node:child_process";

export const WIN = process.platform === "win32";

export const hide = { windowsHide: true } as const;

export const needsShell = (cmd: string, platform = process.platform) => platform === "win32" && /\.(cmd|bat)$/i.test(cmd);

export const basenameOf = (p: string) => p.split(/[\\/]/).filter(Boolean).at(-1) ?? "";

export function killTree(pid: number, signal: NodeJS.Signals = "SIGTERM", platform = process.platform) {
  if (platform === "win32") {
    execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", ...hide });
  } else {
    process.kill(-pid, signal);
  }
}

export function openCommand(url: string, platform = process.platform): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["cmd", ["/c", "start", '""', url]];
  return ["xdg-open", [url]];
}

export function commandOf(pid: number, platform = process.platform): string {
  if (platform === "win32") {
    return execFileSync("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: "utf8", ...hide });
  }
  return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", ...hide });
}
