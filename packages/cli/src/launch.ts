import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { quote } from "../../daemon/src/run-md.ts";
import { HOOK_EVENTS } from "./hook-send.ts";

export const DEFAULT_PLAYBOOK = fileURLToPath(new URL("../playbook.md", import.meta.url));
export const SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url));
export const HOOK_SCRIPT = fileURLToPath(new URL("./hook-send.ts", import.meta.url));
export const PLUGIN_DIR = fileURLToPath(new URL("../plugin", import.meta.url));

// Claude Code permission rules match POSIX-style paths. On Windows "C:\Users\me" is written "/c/Users/me".
export const toRulePath = (p: string, platform: string = process.platform) =>
  platform === "win32" ? p.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`) : p;

export const hookCommand = (node = process.execPath, script = HOOK_SCRIPT) => [node, "--disable-warning=ExperimentalWarning", script].map(quote).join(" ");

export function userStatusLine(settingsFile = join(homedir(), ".claude", "settings.json")): string | undefined {
  try {
    return JSON.parse(readFileSync(settingsFile, "utf8")).statusLine?.command;
  } catch {
    return undefined;
  }
}

export const statusLineCommand = (userCommand?: string) => {
  const tag = "printf '\\033[1m[AWB]\\033[0m\\n'";
  return userCommand ? `${tag}; ${userCommand}` : tag;
};

export function awbSettings(home: string, command = hookCommand(), userStatus = userStatusLine()) {
  const entry = (matcher?: string) => [{ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command, timeout: 5 }] }];
  return {
    env: { AWB: "1", AWB_HOME: home },
    statusLine: { type: "command", command: statusLineCommand(userStatus) },
    permissions: {
      additionalDirectories: [join(home, "repos")],
      deny: [
        ...["awb.db*", "daemon.json", "tasks/**"].map((p) => `Edit(/${toRulePath(home)}/${p})`),
      ],
    },
    hooks: Object.fromEntries(
      HOOK_EVENTS.map((e) => [e, entry(e === "PreToolUse" || e === "PostToolUse" ? "*" : undefined)]),
    ),
  };
}

export function gitInfo(cwd: string) {
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
  const worktree = git("rev-parse", "--show-toplevel");
  const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
  const repo = /[\\/]\.git$/.test(common) ? resolve(common, "..") : resolve(worktree);
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  return { repo, worktree, branch };
}

export function playbookPath(worktree: string): string {
  const own = join(worktree, ".awb", "playbook.md");
  return existsSync(own) ? own : DEFAULT_PLAYBOOK;
}

export function repoRulesPath(home: string, repo: string): string {
  return join(home, "repos", `${basename(repo)}.md`);
}

export function systemPrompt(playbook: string, rules?: string, runFile = ""): string {
  const text = readFileSync(playbook, "utf8").replaceAll("{skills}", SKILLS_DIR).replaceAll("{run_file}", runFile);
  if (!rules || !existsSync(rules)) return text;
  return `${text}\n\n## Rules for this repo\n\nFrom ${rules}. These rules win over the playbook.\n\n${readFileSync(rules, "utf8").trim()}\n`;
}

export function claudeArgs(passThrough: string[], playbook: string, settings: object, rules?: string, runFile = ""): string[] {
  return [
    "--append-system-prompt",
    systemPrompt(playbook, rules, runFile),
    "--settings",
    JSON.stringify(settings),
    "--plugin-dir",
    PLUGIN_DIR,
    ...passThrough,
  ];
}

export function resumeArgs(claudeSessionId: string, rest: string[]): string[] {
  return ["--resume", claudeSessionId, ...rest];
}

export function splitResume(args: string[]): { id: string | null; rest: string[] } | null {
  const i = args.indexOf("--resume");
  if (i < 0) return null;
  const next = args[i + 1];
  const id = next !== undefined && !next.startsWith("-") ? next : null;
  return { id, rest: [...args.slice(0, i), ...args.slice(i + (id ? 2 : 1))] };
}
