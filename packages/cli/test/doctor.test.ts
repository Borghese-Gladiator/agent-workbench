import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { logChecks } from "../src/doctor.ts";
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
