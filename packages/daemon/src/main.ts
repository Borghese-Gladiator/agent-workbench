import { mkdirSync, writeFileSync, renameSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { openStore } from "./store.ts";
import { createApp } from "./server.ts";

export async function startDaemon(home: string) {
  mkdirSync(home, { recursive: true });
  const store = openStore(join(home, "awb.db"));
  const startedAt = new Date().toISOString();
  const server = createApp(store, { home, startedAt });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const file = join(home, "daemon.json");
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, port, startedAt }));
  renameSync(tmp, file);

  const stop = () => {
    try {
      if (JSON.parse(readFileSync(file, "utf8")).pid === process.pid) rmSync(file);
    } catch {}
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
