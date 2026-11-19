type Task = Record<string, any>;

export type Attention = { task: Task; reason: string };

export const needsAttention = (tasks: Task[]): Attention[] =>
  tasks.flatMap((task) =>
    task.status === "failed"
      ? [{ task, reason: task.fail_reason || "The task failed." }]
      : task.status === "done" && task.failed_claims?.length
        ? [{ task, reason: "Gate failed for " + task.failed_claims.join(", ") + "." }]
        : [],
  );

export type PrGroup = "blocked" | "waiting" | "review";

export const prGroup = (t: Task, tasks: Task[]): PrGroup => {
  if (!t.last_gate_at || t.failed_claims?.length) return "blocked";
  const earlier = tasks.filter((x) => x.stack_id === t.stack_id && x.position < t.position);
  return earlier.every((x) => x.status === "merged") ? "review" : "waiting";
};

export const stackProgress = (tasks: Task[]) => {
  const finished = tasks.filter((t) => t.status === "done" || t.status === "merged").length;
  return { finished, total: tasks.length, current: tasks.find((t) => t.status === "doing") ?? null };
};

export const stackCost = (tasks: Task[], usd: Record<string, number>) => tasks.reduce((n, t) => n + (usd[t.id] ?? 0), 0);

export const costlyFailures = (tasks: Task[], usd: Record<string, number>): Set<string> => {
  const priced = tasks.filter((t) => usd[t.id] > 0);
  const avg = priced.reduce((n, t) => n + usd[t.id], 0) / (priced.length || 1);
  return new Set(tasks.filter((t) => t.status === "failed" && usd[t.id] > 2 * avg).map((t) => t.id));
};

export type Tone = "ok" | "bad" | "warn" | "dim";

export const TONE: Record<string, Tone> = {
  done: "ok", merged: "ok", idle: "ok", PASS: "ok", passed: "ok",
  failed: "bad", FAIL: "bad", stopped: "bad", lost: "bad",
  doing: "warn", running: "warn", busy: "warn",
};

export const toneOf = (s: string): Tone => TONE[s] ?? "dim";

export const lastGate = (t: Task) => t.attempts?.flatMap((a: Task) => a.gates).at(-1) ?? null;

export type Step3 = "done" | "running" | "failed" | "blocked" | "waiting";

export const stepStates = (tasks: Task[]): Step3[] => {
  let stopped = false;
  return tasks.map((t) => {
    if (t.status === "done" || t.status === "merged") return "done";
    if (t.status === "doing") return "running";
    if (t.status === "failed") return (stopped = true), "failed";
    return stopped ? "blocked" : "waiting";
  });
};

export const filterTasks = (tasks: Task[], q: string, status: string) => {
  const needle = q.trim().toLowerCase();
  return tasks.filter(
    (t) =>
      (status === "all" || t.status === status) &&
      (!needle || [t.title, t.branch, t.repo, t.id].some((v) => String(v ?? "").toLowerCase().includes(needle))),
  );
};

export const matchLines = (lines: Task[], q: string) => {
  const needle = q.trim().toLowerCase();
  return needle ? lines.filter((l) => (l.source + "." + l.event + " " + JSON.stringify(l)).toLowerCase().includes(needle)) : lines;
};

export const barRows = (m: Record<string, number>, limit = 8) => {
  const rows = Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, limit);
  const max = rows[0]?.[1] || 1;
  return rows.map(([name, usd]) => ({ name, usd, pct: Math.round((usd / max) * 100) }));
};

export type Step = { ts: string; title: string; detail: string; level: string };

const TITLE: Record<string, string> = {
  "session.ended": "Session ended",
  "run.started": "Run started",
  "run.ended": "Run ended",
  "gate.result": "Gate result",
  "task.failed": "Task failed",
  "task.shipped": "Task shipped",
};

export const timeline = (lines: Task[], minLevel = "warn"): Step[] => {
  const rank: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  return lines
    .filter((l) => (rank[l.level] ?? 1) >= (rank[minLevel] ?? 1))
    .map(({ ts, level, source, event, ...rest }) => ({
      ts,
      level,
      title: TITLE[event] ?? source + "." + event,
      detail: Object.entries(rest)
        .map(([k, v]) => k + "=" + (typeof v === "string" ? v : JSON.stringify(v)))
        .join(" "),
    }));
};
