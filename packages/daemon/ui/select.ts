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
