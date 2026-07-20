import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Remove the temp data dir + git repo created in playwright.config.ts. */
export default function globalTeardown() {
  try {
    const { dataDir, repoDir } = JSON.parse(readFileSync(join(here, '.env-paths.json'), 'utf8'));
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
