import { mkdirSync, writeFileSync, renameSync, rmSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { alive, openStore } from "./store.ts";
import { createApp } from "./server.ts";
import { createStacks, migrateStacks } from "./stacks.ts";
import { taskRoutes } from "./task-routes.ts";
import { claudeSession, createRunner, lastSessionUsd, stackLimit } from "./runner.ts";
import { notify, runMessage } from "./notify.ts";
import { createLog } from "./log.ts";

export async function startDaemon(home: string) {
  mkdirSync(home, { recursive: true });
  const logDir = join(home, "logs");
  const log = createLog(logDir);
  const store = openStore(join(home, "awb.db"), { quietMs: Number(process.env.AWB_QUIET_MIN || 15) * 60_000 });
  migrateStacks(store.db);
  const stacks = createStacks(store.db, (id) => join(realpathSync(home), "tasks", id));
  const recovered = stacks.recover((pid) => alive(pid));
  for (const task of recovered.alive) log("info", "daemon", "recover.alive", { task, reason: "its session is still running, so the task stays doing" });
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
        config: () => stacks.repoConfig(repo),
      }),
    {
      log,
      maxStacks: stackLimit(process.env.AWB_MAX_STACKS),
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
  const server = createApp(store, { home, startedAt, log }, routes);
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(Number(process.env.AWB_PORT || 0), "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const sync = setInterval(
    () => routes.syncPrs().catch((err) => log("warn", "sync", "error", { error: err })),
    Number(process.env.AWB_SYNC_MS || 60_000),
  );
  sync.unref();
  log("info", "daemon", "start", { pid: process.pid, port, home });

  const file = join(home, "daemon.json");
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, port, startedAt }));
  renameSync(tmp, file);

  const stop = () => {
    try {
      if (JSON.parse(readFileSync(file, "utf8")).pid === process.pid) rmSync(file);
    } catch {}
    clearInterval(sync);
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
