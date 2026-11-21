import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basenameOf, needsShell, openCommand } from "../src/platform.ts";
import { notifyCommand } from "../src/notify.ts";

for (const [path, name] of [["/a/b", "b"], ["C:\\a\\b", "b"], ["C:/a/b", "b"], ["C:\\a\\b\\", "b"]]) {
  test(`basenameOf ${path}`, () => assert.equal(basenameOf(path), name));
}

for (const [platform, cmd] of [["darwin", "open"], ["win32", "cmd"], ["linux", "xdg-open"]] as const) {
  test(`openCommand on ${platform} uses ${cmd}`, () => assert.equal(openCommand("http://x", platform)[0], cmd));
}

for (const [platform, cmd, want] of [["win32", "claude.cmd", true], ["win32", "claude.exe", false], ["darwin", "claude.cmd", false]] as const) {
  test(`needsShell ${platform} ${cmd}`, () => assert.equal(needsShell(cmd, platform), want));
}

for (const [platform, cmd] of [["darwin", "osascript"], ["win32", "powershell"], ["linux", "notify-send"]] as const) {
  test(`notifyCommand on ${platform} uses ${cmd}`, () => assert.equal(notifyCommand("t", "b", undefined, platform).cmd, cmd));
}

test("notifyCommand on win32 sends the title and body in the environment, so a quote cannot break the script", () => {
  const c = notifyCommand(`it's "done"`, "$(x)", undefined, "win32");
  assert.deepEqual(c.env, { AWB_NOTIFY_TITLE: `it's "done"`, AWB_NOTIFY_BODY: "$(x)" });
  assert.ok(!c.args.join(" ").includes("done"));
});

test("AWB_NOTIFY_CMD wins on every platform", () => {
  assert.deepEqual(notifyCommand("t", "b", "/my/cmd", "win32"), { cmd: "/my/cmd", args: ["t", "b"] });
});

test("every spawn, spawnSync, execFile and execFileSync call in src passes windowsHide, unless it shares the terminal", () => {
  const files = execFileSync("git", ["ls-files", "packages/*/src/*.ts"], { encoding: "utf8" }).split("\n").filter(Boolean);
  const bad = files.flatMap((f) => {
    const lines = readFileSync(f, "utf8").split("\n");
    return lines.flatMap((l, i) => {
      if (!/\b(spawn|spawnSync|execFile|execFileSync)\(/.test(l) || l.startsWith("import ")) return [];
      const call = lines.slice(i, i + 8).join(" ");
      return /windowsHide|\.\.\.hide|stdio: "inherit"/.test(call) ? [] : [`${f}:${i + 1}`];
    });
  });
  assert.deepEqual(bad, []);
});
