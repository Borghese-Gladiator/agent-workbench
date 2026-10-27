#!/usr/bin/env npx tsx
/**
 * Entry point for the ingest CLI.
 *
 * Usage:
 *   npx tsx src/cli/ingest.main.ts task --title "Fix login bug" --kind bug
 *   npx tsx src/cli/ingest.main.ts epic --title "Auth overhaul"
 *   npx tsx src/cli/ingest.main.ts comment --work-item-id <uuid> --body "Looks good"
 *   npx tsx src/cli/ingest.main.ts batch '<json-payload>'
 *   npx tsx src/cli/ingest.main.ts batch -              # read JSON from stdin
 *   npx tsx src/cli/ingest.main.ts set-awaiting --work-item-id <uuid> --awaiting true
 */

import { run } from "./ingest.js";

try {
  const result = run(process.argv.slice(2), process.cwd());
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
