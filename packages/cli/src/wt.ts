import { execFile } from "node:child_process";
import { on } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { parseArgs, promisify } from "node:util";

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await run("git", args, { cwd })).stdout.trim();

export type Wt = { repo: string; name: string; path: string; branch: string; dirty: number; age: string };

export function wtRoot(flag?: string, env = process.env): string {
  return flag ?? env.AWB_WORKTREES ?? join(homedir(), "LOCAL_worktrees");
}

const dirs = (p: string) =>
  readdirSync(p, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();

// ponytail: fixed pool of 8, so a root of 90 worktrees does not start 180 git processes at once
async function pool<T, R>(items: T[], fn: (t: T) => Promise<R>, size = 8): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: size }, worker));
  return out;
}

export async function scan(root: string, repo?: string): Promise<Wt[]> {
  if (!existsSync(root)) return [];
  const found = dirs(root)
    .filter((r) => !repo || r === repo)
    .flatMap((r) => dirs(join(root, r)).map((name) => ({ repo: r, name, path: join(root, r, name) })));
  return pool(found, inspect);
}

async function inspect(w: { repo: string; name: string; path: string }): Promise<Wt> {
  const base = { ...w, branch: "", dirty: 0, age: "" };
  if (!existsSync(join(w.path, ".git"))) return base;
  try {
    const [status, age] = await Promise.all([git(w.path, "status", "--porcelain=v2", "--branch"), git(w.path, "log", "-1", "--format=%cr")]);
    const lines = status.split("\n");
    const head = lines.find((l) => l.startsWith("# branch.head "))?.slice(14) ?? "";
    return { ...base, branch: head, dirty: lines.filter((l) => l && !l.startsWith("#")).length, age };
  } catch {
    return base;
  }
}

const line = (w: Wt) =>
  w.branch
    ? `${w.branch.padEnd(60)} ${(w.dirty ? `${w.dirty} changed` : "clean").padEnd(11)} ${w.age}`
    : `${w.name.padEnd(60)} not a worktree`;

export function render(list: Wt[]): string {
  if (!list.length) return "no worktrees";
  const out: string[] = [];
  for (const repo of new Set(list.map((w) => w.repo))) {
    const ws = list.filter((w) => w.repo === repo);
    out.push(`${repo} (${ws.length})`, ...ws.map((w) => `  ${line(w)}`), "");
  }
  return out.join("\n").trimEnd();
}

export async function remove(w: Wt): Promise<string | null> {
  try {
    const main = dirname(await git(w.path, "rev-parse", "--path-format=absolute", "--git-common-dir"));
    await git(main, "worktree", "remove", w.path);
    return null;
  } catch (err) {
    return (err as { stderr?: string }).stderr?.trim() || (err as Error).message;
  }
}

// The picker draws on stderr, so stdout holds only the chosen path: cd "$(awb wt pick)"
export async function pick(list: Wt[]): Promise<string | null> {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) throw new Error("awb wt pick needs a terminal");
  let items = list;
  let cur = 0;
  let msg = "";
  let confirm = false;
  const marked = new Set<string>();

  const draw = () => {
    const rows = (stderr.rows || 30) - 4;
    const top = Math.max(0, Math.min(cur - Math.floor(rows / 2), items.length - rows));
    const view = items.slice(top, top + rows).map((w, i) => {
      const at = top + i === cur;
      return `${at ? "\x1b[7m>" : " "} [${marked.has(w.path) ? "x" : " "}] ${w.repo.padEnd(14)} ${line(w)}\x1b[0m`;
    });
    const help = confirm ? `remove ${marked.size} worktree(s)? y/n` : "↑↓ move  space mark  d remove marked  enter print path  q quit";
    stderr.write(`\x1b[2J\x1b[H${view.join("\n")}\n\n${help}\n${msg}`);
  };

  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  draw();
  try {
    for await (const [, key = {}] of on(stdin, "keypress") as AsyncIterable<[string, { name?: string; ctrl?: boolean }]>) {
      msg = "";
      const w = items[cur];
      if (confirm) {
        confirm = false;
        if (key.name === "y") {
          for (const m of items.filter((x) => marked.has(x.path))) {
            const err = await remove(m);
            if (err) msg += `${m.name}: ${err}\n`;
            else items = items.filter((x) => x !== m);
          }
          marked.clear();
          cur = Math.min(cur, Math.max(0, items.length - 1));
        }
      } else if (key.name === "up" || key.name === "k") cur = Math.max(0, cur - 1);
      else if (key.name === "down" || key.name === "j") cur = Math.min(items.length - 1, cur + 1);
      else if (key.name === "space" && w) {
        if (marked.has(w.path)) marked.delete(w.path);
        else marked.add(w.path);
      } else if (key.name === "d" && marked.size) confirm = true;
      else if (key.name === "return" || key.name === "enter") return w?.path ?? null;
      else if (key.name === "q" || key.name === "escape" || (key.ctrl && key.name === "c")) return null;
      draw();
    }
    return null;
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    stderr.write("\x1b[2J\x1b[H");
  }
}

export async function wtCmd(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { root: { type: "string" }, json: { type: "boolean" } } });
  const root = wtRoot(values.root);
  if (!existsSync(root)) return console.error(`awb: ${root} does not exist. Set AWB_WORKTREES or pass --root <dir>.`), 1;
  const interactive = positionals[0] === "pick";
  const list = await scan(root, interactive ? positionals[1] : positionals[0]);
  if (values.json) return console.log(JSON.stringify(list, null, 2)), 0;
  if (!interactive) return console.log(`${root}\n\n${render(list)}`), 0;
  if (!list.length) return console.error(`awb: no worktrees in ${root}`), 1;
  const path = await pick(list);
  if (!path) return 1;
  console.log(path);
  return 0;
}
