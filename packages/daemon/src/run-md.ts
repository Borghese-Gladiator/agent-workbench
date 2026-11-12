import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export type RunMd = { start: string | null; url: string; ready: string };

function sectionCommand(text: string, name: string): string | null {
  const section = text.match(new RegExp(`^##\\s+${name}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "im"))?.[1];
  return section?.match(/```(?:sh|bash|shell)?\n([\s\S]*?)```/)?.[1].trim() || null;
}

export function parseSetup(text: string): string | null {
  return sectionCommand(text, "setup");
}

export function parseTest(text: string): string {
  const cmd = sectionCommand(text, "test");
  if (!cmd) throw new Error("run.md has no '## test' section with a ```sh block");
  if (!cmd.includes("{tests}") || !cmd.includes("{report}")) throw new Error("run.md '## test' must use {tests} and {report}");
  return cmd;
}

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export function fillTest(cmd: string, tests: string[], report: string): string {
  return cmd.replaceAll("{tests}", tests.map(quote).join(" ")).replaceAll("{report}", quote(report));
}

export function parseRunMd(text: string): RunMd {
  const section = text.match(/^##\s+start\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im)?.[1];
  if (!section) throw new Error("run.md has no '## start' section");
  const start = section.match(/```(?:sh|bash|shell)?\n([\s\S]*?)```/)?.[1].trim() || null;
  const url = section.match(/^url:\s*(\S+)\s*$/m)?.[1];
  if (!url) throw new Error("run.md '## start' has no 'url:' line");
  const ready = section.match(/^ready:\s*(\S+)\s*$/m)?.[1] ?? "/";
  return { start, url, ready };
}

export function fill(s: string, port: number): string {
  return s.replaceAll("{port}", String(port));
}

export function runFilePath(home: string, repo: string): string {
  return join(home, "repos", `${basename(repo)}.run.md`);
}

export function envFilePath(home: string, repo: string): string {
  return join(home, "repos", `${basename(repo)}.env`);
}

export function findRunFile(home: string, repo: string, worktree: string): string | null {
  const own = join(worktree, ".awb", "run.md");
  if (existsSync(own)) return own;
  const shared = runFilePath(home, repo);
  return existsSync(shared) ? shared : null;
}

export function readRunFile(home: string, repo: string, worktree: string): string {
  const file = findRunFile(home, repo, worktree);
  if (!file) throw new Error(`no run file: write ${runFilePath(home, repo)} with a '## start' or '## test' section`);
  return readFileSync(file, "utf8");
}
