import { createDatabase, type WorkbenchDatabase } from '@awb/database';
import { initDataDir } from '@awb/config';

let cached: WorkbenchDatabase | undefined;

/** Opens (and caches for the lifetime of this CLI process) the workbench database, ensuring the data dir exists first. */
export function openWorkbenchDatabase(): WorkbenchDatabase {
  if (cached) return cached;
  const { layout } = initDataDir();
  cached = createDatabase(layout.workbenchSqlite);
  return cached;
}
