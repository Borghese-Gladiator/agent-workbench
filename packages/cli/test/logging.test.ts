import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { composeCommand } from "../src/logging.ts";

test("composeCommand sets AWB_LOGS to the logs folder of AWB_HOME, built by path.join", () => {
  const home = join("some", "awb-home");
  const c = composeCommand(home, ["up", "-d"], "compose.yml");
  assert.deepEqual(c, { cmd: "docker", args: ["compose", "-f", "compose.yml", "up", "-d"], env: { AWB_LOGS: join(home, "logs") } });
});
