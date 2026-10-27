/**
 * shot.mjs — capture one screenshot of a running page using the repo's OWN
 * Playwright (installed here under apps/web). This exists because the MCP
 * `browser_take_screenshot` tool does not reliably persist a readable file in
 * sandboxed/agent environments — but the repo already ships Chromium + Playwright
 * and a plain `page.screenshot({ path })` lands a real PNG on disk every time.
 *
 * Lives under apps/web/ on purpose: ESM resolves the bare `@playwright/test`
 * import relative to THIS file, so it must sit next to apps/web/node_modules.
 *
 * Usage (run from the repo root; cwd doesn't matter, paths resolve from cwd):
 *   node apps/web/scripts/shot.mjs <url> <out.png> [--full] [--width=N] [--height=N]
 *
 * Example (dev server already running via `pnpm web`):
 *   node apps/web/scripts/shot.mjs http://localhost:5317/usage shot-usage.png --full
 */
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const [url, out, ...rest] = process.argv.slice(2);
if (!url || !out) {
  console.error(
    'usage: node apps/web/scripts/shot.mjs <url> <out.png> [--full] [--width=N] [--height=N]',
  );
  process.exit(1);
}

const fullPage = rest.includes('--full');
const arg = (name, fallback) => {
  const hit = rest.find((r) => r.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};
const width = arg('width', 1440);
const height = arg('height', 900);
// Resolve the output relative to the invoking cwd, not this file's location.
const outPath = resolve(process.cwd(), out);

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.screenshot({ path: outPath, fullPage, type: 'png' });
  console.log(`SHOT: ${outPath}`);
} finally {
  await browser.close();
}
