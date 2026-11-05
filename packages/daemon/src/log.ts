import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
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

const LOG_NAME = /^awb\.(\d{4}-\d\d-\d\d)(?:\.(\d+))?\.jsonl$/;

export const logName = (day: string, part = 0) => (part ? `awb.${day}.${part}.jsonl` : `awb.${day}.jsonl`);

export function logFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const key = (f: string) => {
    const m = f.match(LOG_NAME)!;
    return [m[1], Number(m[2] ?? 0)] as const;
  };
  return readdirSync(dir)
    .filter((f) => LOG_NAME.test(f))
    .sort((a, b) => {
      const [da, pa] = key(a);
      const [db, pb] = key(b);
      return da === db ? pa - pb : da < db ? -1 : 1;
    });
}

export function keepDays(env = process.env): number | null {
  const v = env.AWB_LOG_KEEP_DAYS;
  if (!v || v === "none") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function expire(dir: string, days: number | null, now = Date.now(), current?: string): string[] {
  if (days === null) return [];
  const cutoff = now - days * 86_400_000;
  const gone = logFiles(dir).filter((f) => f !== current && statSync(join(dir, f)).mtimeMs < cutoff);
  for (const f of gone) rmSync(join(dir, f), { force: true });
  return gone;
}

export function currentFile(dir: string, maxBytes: number, now = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  let part = 0;
  for (const f of logFiles(dir)) {
    const m = f.match(LOG_NAME)!;
    if (m[1] === day) part = Math.max(part, Number(m[2] ?? 0));
  }
  const name = logName(day, part);
  return existsSync(join(dir, name)) && statSync(join(dir, name)).size >= maxBytes ? logName(day, part + 1) : name;
}

export function createLog(dir: string, opts: { maxBytes?: number; keepDays?: number | null; echo?: (line: string) => void } = {}): Log {
  const maxBytes = opts.maxBytes ?? 50 * 1024 * 1024;
  const days = opts.keepDays === undefined ? keepDays() : opts.keepDays;
  let last = "";
  return (level, source, event, fields = {}) => {
    const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null));
    if (clean.error instanceof Error) clean.error = clean.error.message;
    const line = redact(JSON.stringify({ ts: new Date().toISOString(), level, source, event, ...clean }));
    try {
      mkdirSync(dir, { recursive: true });
      const name = currentFile(dir, maxBytes);
      if (name !== last) {
        last = name;
        expire(dir, days, Date.now(), name);
      }
      appendFileSync(join(dir, name), line + "\n");
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
  const files = logFiles(dir).map((f) => join(dir, f));
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

const ID_FIELDS = ["task", "run", "session", "stack", "attempt"];

export function logText(l: LogLine): string {
  const { ts, level, source, event, ...rest } = l;
  const ids = ID_FIELDS.filter((k) => typeof rest[k] === "string").map((k) => `${k}=${String(rest[k]).slice(0, 8)}`);
  const other = Object.entries(rest)
    .filter(([k]) => !ID_FIELDS.includes(k))
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  return `${ts.slice(0, 19).replace("T", " ")} ${level.toUpperCase().padEnd(5)} ${source}.${event} ${[...ids, ...other].join(" ")}`.trimEnd();
}
