import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { logChecks, mcpChecks } from "../src/doctor.ts";
import { createLog } from "../../daemon/src/log.ts";

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function serve(handler: (path: string) => [number, unknown]): Promise<string> {
  const s = createServer((req, res) => {
    const [status, body] = handler(req.url ?? "");
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

const lokiWith = (msAgo: number | null) =>
  serve(() => [200, { data: { result: msAgo === null ? [] : [{ values: [[String((Date.now() - msAgo) * 1e6), "{}"]] }] } }]);

const dir = mkdtempSync(join(tmpdir(), "awb-doctor-"));
createLog(dir, { keepDays: null })("info", "daemon", "start");

for (const [name, lokiMsAgo, ok, detail] of [
  ["Loki is current", 1_000, true, /^current/],
  ["Loki is behind", 600_000, false, /10 min behind/],
  ["Loki has no line", null, false, /no awb line/],
] as const) {
  test(`logChecks: ${name}`, async () => {
    const alloy = await serve(() => [200, "ready"]);
    const [a, l] = await logChecks(dir, alloy, await lokiWith(lokiMsAgo));
    assert.deepEqual([a.name, a.ok], ["alloy", true]);
    assert.equal(l.name, "loki");
    assert.equal(l.ok, ok);
    assert.match(l.detail, detail);
  });
}

test("logChecks: no Alloy is off, not a failure", async () => {
  const checks = await logChecks(dir, "http://127.0.0.1:9", "http://127.0.0.1:9");
  assert.equal(checks.length, 1);
  assert.equal(checks[0].ok, true);
  assert.match(checks[0].detail, /^off/);
});

const listing = [
  "Checking MCP server health…",
  "",
  "sentry: https://mcp.sentry.dev/mcp (HTTP) - ✔ Connected",
  "slack: https://mcp.slack.com/mcp (HTTP) - ! Needs authentication",
  "linear-server: https://mcp.linear.app/mcp (HTTP) - ✘ Failed to connect — HTTP 405",
].join("\n");

test("mcpChecks: connected, needs auth, failed and missing", () => {
  const rows = mcpChecks(listing, ["sentry", "slack", "linear-server", "nothing"]);
  assert.deepEqual(rows.map((r) => [r.name, r.ok]), [["sentry", true], ["slack", false], ["linear-server", false], ["nothing", false]]);
  assert.match(rows[1].detail, /needs authentication/);
  assert.match(rows[2].detail, /failed to connect/);
  assert.match(rows[3].detail, /not configured/);
});

test("mcpChecks: a failed claude mcp list gives one FAIL row", () => {
  const rows = mcpChecks(null);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ok, false);
});
