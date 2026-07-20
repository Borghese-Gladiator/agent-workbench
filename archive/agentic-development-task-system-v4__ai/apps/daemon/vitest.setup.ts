/**
 * Test process contract — mirrors the daemon's boot-time safety net (main.ts).
 *
 * The daemon installs a process-level `unhandledRejection` handler so a stray
 * rejection from a detached agent run can't abort the process. Tests construct
 * the app directly (not via main.ts), so without this they ran under a DIFFERENT
 * contract than production: Node ≥15 aborts the worker on an unhandled rejection,
 * which surfaced as intermittent cross-test failures (timeouts / "Expected
 * HTTP/"). Installing the same handler here makes tests faithful to production
 * and removes that flake. See docs/TODO.md "Root-caused 2026-06-16".
 */
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('[test] unhandledRejection (kept alive):', reason);
});
