import type { DatabaseSync } from "node:sqlite";

export type CostRow = { day: string; repo: string; task_id: string | null; title: string | null; kind: "session" | "writer"; usd: number };
export type CostReport = {
  since: string;
  total_usd: number;
  session_usd: number;
  writer_usd: number;
  by_day: Record<string, number>;
  by_repo: Record<string, number>;
  by_task: { task_id: string; title: string; usd: number }[];
  unpriced_sessions: number;
};

export const repoMatch = (repo: string, filter?: string) => !filter || repo === filter || repo.split("/").at(-1) === filter;

export function costRows(db: DatabaseSync, since: string, repo?: string): { rows: CostRow[]; unpriced: number } {
  const sessions = db
    .prepare(
      `SELECT x.id, x.started_at AS at, x.repo, u.cost_usd,
         (SELECT a.task_id FROM attempts a WHERE a.session_id = x.id LIMIT 1) AS task_id
       FROM sessions x JOIN session_usage u ON u.session_id = x.id WHERE x.started_at >= ?`,
    )
    .all(since) as { at: string; repo: string; cost_usd: number | null; task_id: string | null }[];
  const writers = db
    .prepare(
      `SELECT a.started_at AS at, s.repo, t.id AS task_id, a.writer_usd AS usd
       FROM attempts a JOIN tasks t ON t.id = a.task_id JOIN stacks s ON s.id = t.stack_id
       WHERE a.started_at >= ? AND a.writer_usd IS NOT NULL`,
    )
    .all(since) as { at: string; repo: string; task_id: string; usd: number }[];
  const titles = new Map((db.prepare("SELECT id, title FROM tasks").all() as { id: string; title: string }[]).map((t) => [t.id, t.title]));
  const rows: CostRow[] = [];
  let unpriced = 0;
  for (const s of sessions) {
    if (!repoMatch(s.repo, repo)) continue;
    if (s.cost_usd === null) {
      unpriced++;
      continue;
    }
    rows.push({ day: s.at.slice(0, 10), repo: s.repo, task_id: s.task_id, title: s.task_id ? titles.get(s.task_id) ?? null : null, kind: "session", usd: s.cost_usd });
  }
  for (const w of writers) if (repoMatch(w.repo, repo)) rows.push({ day: w.at.slice(0, 10), repo: w.repo, task_id: w.task_id, title: titles.get(w.task_id) ?? null, kind: "writer", usd: w.usd });
  return { rows, unpriced };
}

export function costReport(db: DatabaseSync, since: string, repo?: string): CostReport {
  const { rows, unpriced } = costRows(db, since, repo);
  const add = (m: Record<string, number>, k: string, v: number) => (m[k] = (m[k] ?? 0) + v);
  const by_day: Record<string, number> = {};
  const by_repo: Record<string, number> = {};
  const tasks = new Map<string, { task_id: string; title: string; usd: number }>();
  for (const r of rows) {
    add(by_day, r.day, r.usd);
    add(by_repo, r.repo, r.usd);
    if (r.task_id) {
      const t = tasks.get(r.task_id) ?? { task_id: r.task_id, title: r.title ?? "", usd: 0 };
      t.usd += r.usd;
      tasks.set(r.task_id, t);
    }
  }
  const sum = (kind?: string) => rows.filter((r) => !kind || r.kind === kind).reduce((n, r) => n + r.usd, 0);
  return {
    since,
    total_usd: sum(),
    session_usd: sum("session"),
    writer_usd: sum("writer"),
    by_day,
    by_repo,
    by_task: [...tasks.values()].sort((a, b) => b.usd - a.usd),
    unpriced_sessions: unpriced,
  };
}

export function costText(r: CostReport, taskLimit = 10): string {
  const usd = (n: number) => `${n.toFixed(2)} USD`;
  const lines = [
    `cost since ${r.since.slice(0, 16).replace("T", " ")} (estimate from token counts)`,
    `total ${usd(r.total_usd)}: task and chat sessions ${usd(r.session_usd)}, test writer ${usd(r.writer_usd)}`,
  ];
  const days = Object.entries(r.by_day).sort(([a], [b]) => b.localeCompare(a));
  if (days.length) lines.push("", "by day:", ...days.map(([d, v]) => `  ${d}  ${usd(v).padStart(11)}`));
  const repos = Object.entries(r.by_repo).sort(([, a], [, b]) => b - a);
  if (repos.length) lines.push("", "by repo:", ...repos.map(([k, v]) => `  ${usd(v).padStart(11)}  ${k.split("/").at(-1)}`));
  if (r.by_task.length) {
    lines.push("", "top tasks:", ...r.by_task.slice(0, taskLimit).map((t) => `  ${usd(t.usd).padStart(11)}  ${t.task_id.slice(0, 8)}  ${t.title}`));
    if (r.by_task.length > taskLimit) lines.push(`  ...and ${r.by_task.length - taskLimit} more (use --json)`);
  }
  if (r.unpriced_sessions) lines.push("", `${r.unpriced_sessions} session(s) have no price: their model is not in prices.ts`);
  if (!days.length) lines.push("", "no cost in this period");
  return lines.join("\n");
}
