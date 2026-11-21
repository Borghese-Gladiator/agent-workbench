import { mkdirSync, writeFileSync, renameSync, rmSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { alive, openStore } from "./store.ts";
import { currentLimit } from "./config.ts";
import { isAwbSession, stopSessions } from "./task-helpers.ts";
import { createApp } from "./server.ts";
import { RESTART_REASON, createStacks, migrateStacks } from "./stacks.ts";
import { taskRoutes } from "./task-routes.ts";
import { claudeSession, createRunner, lastSessionUsd, resumeStopped } from "./runner.ts";
import { notify, runMessage } from "./notify.ts";
import { createLog } from "./log.ts";
import { killChildren } from "./prove.ts";
import { killLeftovers, setLeftoverFile } from "./process.ts";
import { createScheduler, migrateJobs, scheduleRoutes } from "./schedule.ts";

export async function startDaemon(home: string) {
  mkdirSync(home, { recursive: true });
  const logDir = join(home, "logs");
  const log = createLog(logDir);
  const store = openStore(join(home, "awb.db"), { quietMs: Number(process.env.AWB_QUIET_MIN || 15) * 60_000 });
  migrateStacks(store.db);
  const stacks = createStacks(store.db, (id) => join(realpathSync(home), "tasks", id));
  setLeftoverFile(join(home, "apps.json"));
  const leftovers = killLeftovers();
  if (leftovers) log("warn", "daemon", "recover.apps", { stopped: leftovers, reason: "app servers of an earlier daemon were still running" });
  const recovered = stacks.recover((pid) => alive(pid) && isAwbSession(pid));
  const restarted = new Set(stacks.restartedStacks());
  for (const task of recovered.alive) {
    if (!restarted.has(stacks.task(task)!.stack_id)) {
      log("info", "daemon", "recover.alive", { task, reason: "its session is not owned by a run, so the task stays doing" });
      continue;
    }
    const pids = stopSessions(stacks.openSessionPids(task));
    stacks.fail(task, RESTART_REASON);
    recovered.tasks.push(task);
    log("warn", "daemon", "recover.killed", { task, pids, reason: "its session outlived the daemon and lost its result pipe" });
  }
  if (recovered.runs || recovered.tasks.length) {
    for (const task of recovered.tasks) log("warn", "daemon", "recover.task", { task, reason: "the daemon restarted while the task ran" });
    log("warn", "daemon", "recover", { runs: recovered.runs, tasks: recovered.tasks.length });
  }
  const startedAt = new Date().toISOString();
  const runner = createRunner(
    stacks,
    (repo) =>
      claudeSession({
        home: realpathSync(home),
        repo,
        timeoutMin: Number(process.env.AWB_TASK_TIMEOUT_MIN || 45),
      }),
    {
      log,
      maxStacks: () => currentLimit(home),
      sessionUsd: (task) => lastSessionUsd(task.folder),
      onEnd: (r) => {
        const m = runMessage(stacks, r);
        notify(m.title, m.body, process.env, log);
      },
    },
  );
  const routes = taskRoutes(
    stacks,
    {
      claude: process.env.AWB_WRITER_CLAUDE || "claude",
      writerTimeoutMin: Number(process.env.AWB_WRITER_TIMEOUT_MIN || 30),
    },
    runner,
    (id) => store.feedRow(id)?.usage ?? null,
    home,
    store.db,
    log,
    logDir,
  );
  migrateJobs(store.db);
  const scheduler = createScheduler(home, store.db, log);
  const stale = scheduler.recover();
  if (stale) log("warn", "schedule", "recover", { runs: stale, reason: "the daemon restarted while a job ran" });
  const jobRoutes = scheduleRoutes(scheduler);
  const server = createApp(store, { home, startedAt, log }, async (req, res, url, body) => (await routes(req, res, url, body)) || jobRoutes(req, res, url, body));
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(Number(process.env.AWB_PORT || 0), "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const sync = setInterval(
    () => routes.syncPrs().catch((err) => log("warn", "sync", "error", { error: err })),
    Number(process.env.AWB_SYNC_MS || 60_000),
  );
  sync.unref();
  const schedule = setInterval(() => scheduler.tick().catch((err) => log("warn", "schedule", "error", { error: err })), 30_000);
  schedule.unref();
  log("info", "daemon", "start", { pid: process.pid, port, home });
  if (process.env.AWB_AUTORESUME === "1") {
    const r = resumeStopped(stacks, runner);
    log("info", "daemon", "autoresume", { started: r.started.map((x) => x.id), skipped: r.skipped });
  }

  const file = join(home, "daemon.json");
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, port, startedAt }));
  renameSync(tmp, file);

  process.on("exit", killChildren);
  const stop = () => {
    const killed = killChildren();
    killLeftovers();
    if (killed) log("warn", "daemon", "stop.children", { groups: killed });
    try {
      if (JSON.parse(readFileSync(file, "utf8")).pid === process.pid) rmSync(file);
    } catch {}
    clearInterval(sync);
    clearInterval(schedule);
    server.close();
    log("info", "daemon", "stop", { pid: process.pid });
    store.close();
  };
  return { port, stop };
}

if (import.meta.main) {
  const home = process.env.AWB_HOME;
  if (!home) {
    console.error("AWB_HOME is not set");
    process.exit(1);
  }
  const { port, stop } = await startDaemon(home);
  console.log(`awb daemon pid ${process.pid} on 127.0.0.1:${port}, AWB_HOME ${home}`);
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (stop(), process.exit(0)));
}
