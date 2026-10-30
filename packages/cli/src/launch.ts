import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOOK_EVENTS } from "./hook-send.ts";

export const DEFAULT_PLAYBOOK = fileURLToPath(new URL("../playbook.md", import.meta.url));
export const HOOK_BIN = fileURLToPath(new URL("../bin/awb-hook", import.meta.url));

export function awbSettings(home: string, hookBin = HOOK_BIN) {
  const quoted = `'${hookBin.replaceAll("'", `'\\''`)}'`;
  const entry = (matcher?: string) => [{ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: quoted, timeout: 5 }] }];
  return {
    env: { AWB_HOME: home },
    permissions: {
      deny: [
        "Bash(gh pr create:*)",
        ...["awb.db*", "daemon.json", "tasks/**"].map((p) => `Edit(/${home}/${p})`),
      ],
    },
    hooks: Object.fromEntries(
      HOOK_EVENTS.map((e) => [e, entry(e === "PreToolUse" || e === "PostToolUse" ? "*" : undefined)]),
    ),
  };
}

export function gitInfo(cwd: string) {
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const worktree = git("rev-parse", "--show-toplevel");
  const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
  const repo = common.endsWith("/.git") ? common.slice(0, -5) : worktree;
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  return { repo, worktree, branch };
}

export function playbookPath(worktree: string): string {
  const own = join(worktree, ".awb", "playbook.md");
  return existsSync(own) ? own : DEFAULT_PLAYBOOK;
}

export function claudeArgs(passThrough: string[], playbook: string, settings: object): string[] {
  return [
    "--append-system-prompt",
    readFileSync(playbook, "utf8"),
    "--settings",
    JSON.stringify(settings),
    ...passThrough,
  ];
}
