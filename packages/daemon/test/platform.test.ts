import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basenameOf, needsShell, openCommand } from "../src/platform.ts";

for (const [path, name] of [["/a/b", "b"], ["C:\\a\\b", "b"], ["C:/a/b", "b"], ["C:\\a\\b\\", "b"]]) {
  test(`basenameOf ${path}`, () => assert.equal(basenameOf(path), name));
}

for (const [platform, cmd] of [["darwin", "open"], ["win32", "cmd"], ["linux", "xdg-open"]] as const) {
  test(`openCommand on ${platform} uses ${cmd}`, () => assert.equal(openCommand("http://x", platform)[0], cmd));
}

for (const [platform, cmd, want] of [["win32", "claude.cmd", true], ["win32", "claude.exe", false], ["darwin", "claude.cmd", false]] as const) {
  test(`needsShell ${platform} ${cmd}`, () => assert.equal(needsShell(cmd, platform), want));
}

test("every spawn and execFileSync call in src passes windowsHide, unless it shares the terminal", () => {
  const files = execFileSync("git", ["ls-files", "packages/*/src/*.ts"], { encoding: "utf8" }).split("\n").filter(Boolean);
  const bad = files.flatMap((f) => {
    const lines = readFileSync(f, "utf8").split("\n");
    return lines.flatMap((l, i) => {
      if (!/\b(spawn|execFileSync)\(/.test(l) || l.startsWith("import ")) return [];
      const call = lines.slice(i, i + 5).join(" ");
      return /windowsHide|\.\.\.hide|stdio: "inherit"/.test(call) ? [] : [`${f}:${i + 1}`];
    });
  });
  assert.deepEqual(bad, []);
});
