import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HELP, helpFor, helpIndex } from "../src/help.ts";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const awb = (...args: string[]) => execFileSync(process.execPath, [main, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

for (const name of Object.keys(HELP)) {
  test(`${name} --help prints usage and starts no work`, () => {
    assert.equal(awb(name, "--help").trim(), HELP[name]);
    assert.ok(HELP[name].startsWith(`usage: awb ${name}`));
  });
}

test("helpFor returns undefined for an unknown command", () => {
  assert.equal(helpFor("nope"), undefined);
  assert.equal(helpFor(undefined), undefined);
});

test("index lists every command", () => {
  const index = helpIndex();
  for (const name of Object.keys(HELP)) assert.match(index, new RegExp(`^  ${name}\\s`, "m"));
});

test("help and --help print the index or one command", () => {
  assert.equal(awb("--help").trim(), helpIndex());
  assert.equal(awb("help", "run").trim(), HELP.run);
});
