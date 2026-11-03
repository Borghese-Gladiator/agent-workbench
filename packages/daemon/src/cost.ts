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

export function costRows(db: DatabaseSync, since: string): { rows: CostRow[]; unpriced: number } {
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
    if (s.cost_usd === null) {
      unpriced++;
      continue;
    }
    rows.push({ day: s.at.slice(0, 10), repo: s.repo, task_id: s.task_id, title: s.task_id ? titles.get(s.task_id) ?? null : null, kind: "session", usd: s.cost_usd });
  }
  for (const w of writers) rows.push({ day: w.at.slice(0, 10), repo: w.repo, task_id: w.task_id, title: titles.get(w.task_id) ?? null, kind: "writer", usd: w.usd });
  return { rows, unpriced };
}

export function costReport(db: DatabaseSync, since: string, repo?: string): CostReport {
  const { rows: all, unpriced } = costRows(db, since);
  const rows = repo ? all.filter((r) => r.repo === repo) : all;
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
