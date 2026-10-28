import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_PLAYBOOK = fileURLToPath(new URL("../playbook.md", import.meta.url));

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
