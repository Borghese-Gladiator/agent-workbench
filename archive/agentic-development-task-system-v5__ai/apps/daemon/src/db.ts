import { createDatabase, type WorkbenchDatabase } from '@awb/database';
import { initDataDir } from '@awb/config';

/**
 * Opens a fresh workbench database handle bound to the current AWB_DATA_DIR. Intentionally NOT
 * cached at module scope — a real daemon process only ever calls this once (from buildServer()),
 * and module-level caching would silently reuse a stale connection across multiple buildServer()
 * calls in the same process (e.g. across tests that each set a different AWB_DATA_DIR).
 * `DaemonServer.close()` is what actually closes this handle.
 */
export function openWorkbenchDatabase(): WorkbenchDatabase {
  const { layout } = initDataDir();
  return createDatabase(layout.workbenchSqlite);
}
