import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const SECRETS: [string, RegExp][] = [
  ["GitHub token", /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
];

export function redact(text: string): string {
  return SECRETS.reduce((t, [kind, re]) => t.replace(new RegExp(re.source, "g"), `[${kind} removed]`), text);
}

export const LEVELS = ["debug", "info", "warn", "error"] as const;
export type Level = (typeof LEVELS)[number];
export type LogLine = { ts: string; level: Level; source: string; event: string; [field: string]: unknown };
export type Log = (level: Level, source: string, event: string, fields?: Record<string, unknown>) => void;

export const LOG_FILE = "awb.jsonl";

export function createLog(dir: string, opts: { maxBytes?: number; keep?: number; echo?: (line: string) => void } = {}): Log {
  const maxBytes = opts.maxBytes ?? 50 * 1024 * 1024;
  const keep = opts.keep ?? 10;
  const file = join(dir, LOG_FILE);
  const rotate = () => {
    if (!existsSync(file) || statSync(file).size < maxBytes) return;
    rmSync(`${file}.${keep - 1}`, { force: true });
    for (let i = keep - 2; i >= 1; i--) if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    if (keep > 1) renameSync(file, `${file}.1`);
    else rmSync(file, { force: true });
  };
  return (level, source, event, fields = {}) => {
    const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null));
    if (clean.error instanceof Error) clean.error = clean.error.message;
    const line = redact(JSON.stringify({ ts: new Date().toISOString(), level, source, event, ...clean }));
    try {
      mkdirSync(dir, { recursive: true });
      rotate();
      appendFileSync(file, line + "\n");
    } catch (err) {
      process.stderr.write(`awb: could not write the log: ${(err as Error).message}\n${line}\n`);
    }
    opts.echo?.(line);
  };
}

export type LogFilter = { task?: string; run?: string; session?: string; level?: Level; source?: string; since?: string; limit?: number };

export function matches(l: LogLine, f: LogFilter): boolean {
  if (f.level && LEVELS.indexOf(l.level) < LEVELS.indexOf(f.level)) return false;
  if (f.source && l.source !== f.source) return false;
  if (f.since && l.ts < f.since) return false;
  const pre = (v: unknown, p?: string) => !p || (typeof v === "string" && v.startsWith(p));
  return pre(l.task, f.task) && pre(l.run, f.run) && pre(l.session, f.session);
}

export function readLog(dir: string, f: LogFilter = {}): LogLine[] {
  const files = [join(dir, LOG_FILE)];
  for (let i = 1; existsSync(join(dir, `${LOG_FILE}.${i}`)); i++) files.unshift(join(dir, `${LOG_FILE}.${i}`));
  const out: LogLine[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      if (!raw) continue;
      let l: LogLine;
      try {
        l = JSON.parse(raw);
      } catch {
        continue;
      }
      if (matches(l, f)) out.push(l);
    }
  }
  return f.limit ? out.slice(-f.limit) : out;
}

export function logText(l: LogLine): string {
  const { ts, level, source, event, ...rest } = l;
  const ids = ["task", "run", "session"].filter((k) => typeof rest[k] === "string").map((k) => `${k}=${String(rest[k]).slice(0, 8)}`);
  const other = Object.entries(rest)
    .filter(([k]) => !["task", "run", "session"].includes(k))
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  return `${ts.slice(0, 19).replace("T", " ")} ${level.toUpperCase().padEnd(5)} ${source}.${event} ${[...ids, ...other].join(" ")}`.trimEnd();
}
