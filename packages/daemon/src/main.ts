import { mkdirSync, writeFileSync, renameSync, rmSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { openStore } from "./store.ts";
import { createApp } from "./server.ts";
import { createStacks, migrateStacks } from "./stacks.ts";
import { taskRoutes } from "./task-routes.ts";
import { claudeSession, createRunner } from "./runner.ts";
import { notify, runMessage } from "./notify.ts";

export async function startDaemon(home: string) {
  mkdirSync(home, { recursive: true });
  const store = openStore(join(home, "awb.db"), { quietMs: Number(process.env.AWB_QUIET_MIN || 15) * 60_000 });
  migrateStacks(store.db);
  const stacks = createStacks(store.db, (id) => join(realpathSync(home), "tasks", id));
  const recovered = stacks.recover();
  if (recovered.runs || recovered.tasks.length) console.log(`awb daemon: stopped ${recovered.runs} run(s) and failed ${recovered.tasks.length} task(s) left from before the restart`);
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
      onEnd: (r) => {
        const m = runMessage(stacks, r);
        notify(m.title, m.body);
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
  );
  const server = createApp(store, { home, startedAt }, routes);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const sync = setInterval(() => routes.syncPrs().catch(() => {}), Number(process.env.AWB_SYNC_MS || 60_000));
  sync.unref();

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
