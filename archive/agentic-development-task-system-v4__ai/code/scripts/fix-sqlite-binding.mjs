#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
/**
 * Keeps better-sqlite3's native binding compiled for the *current* Node.
 *
 * better-sqlite3 ships a compiled binary tied to one Node ABI. Switching Node
 * versions (fnm/nvm) leaves a stale binary and `pnpm daemon` dies with
 * ERR_DLOPEN_FAILED / NODE_MODULE_VERSION mismatch.
 *
 * This script tries to load the module; if it fails to load its native binding,
 * it transparently rebuilds it for the running Node. Idempotent and fast on the
 * happy path (a successful require is cheap). Safe to run on every install and
 * before every daemon start.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// better-sqlite3 is a dependency of @workbench/store, not of this script's dir.
// Resolve relative to that package so the hoisted install is found.
const repoRoot = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, '');
const require = createRequire(join(repoRoot, 'packages/store/package.json'));

function rebuild() {
  console.log('[fix-sqlite-binding] better-sqlite3 ABI mismatch — rebuilding for', process.version);
  // IMPORTANT: better-sqlite3's install script is `prebuild-install || node-gyp
  // rebuild`. prebuild-install succeeds by downloading a prebuilt binary of a
  // FIXED ABI, so `pnpm rebuild` / reinstall never recompiles for the current
  // Node. We invoke its `build-release` script (pure node-gyp) in the package
  // dir to force a real from-source compile against the running Node.
  const pkgDir = dirname(require.resolve('better-sqlite3/package.json'));
  execFileSync('pnpm', ['exec', 'npm', 'run', 'build-release'], {
    cwd: pkgDir,
    stdio: 'inherit',
  });
}

try {
  // Loading is what actually exercises the native binding.
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.close();
  // Loaded cleanly — nothing to do.
} catch (err) {
  const code = err && err.code;
  const msg = (err && err.message) || '';
  const isAbiMismatch =
    code === 'ERR_DLOPEN_FAILED' ||
    /NODE_MODULE_VERSION|was compiled against a different Node\.js version|did not self-register/.test(
      msg,
    );
  if (!isAbiMismatch) {
    // Some other error (missing module, etc.) — surface it.
    throw err;
  }
  rebuild();
  // Verify the rebuild took, in a fresh process (the current process already
  // cached the failed module). Resolve from the store package, like above.
  execFileSync(
    process.execPath,
    [
      '-e',
      `const r=require('node:module').createRequire(${JSON.stringify(
        join(repoRoot, 'packages/store/package.json'),
      )});new (r('better-sqlite3'))(':memory:').close()`,
    ],
    { stdio: 'inherit' },
  );
  console.log('[fix-sqlite-binding] better-sqlite3 rebuilt OK for', process.version);
}
