import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claimTable, type GateResult } from "./gate.ts";
import { gateFromDisk, run } from "./prove.ts";
import { parseRecipe } from "./recipe.ts";
import type { Task, TaskStatus } from "./stacks.ts";

const SECRETS: [string, RegExp][] = [
  ["GitHub token", /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
];

export function findSecrets(files: { name: string; text: string }[]): string[] {
  return files.flatMap((f) => SECRETS.filter(([, re]) => re.test(f.text)).map(([kind]) => `${kind} in ${f.name}`));
}

export type BodyInput = {
  title: string;
  commits: string[];
  claims: { id: string; text: string }[];
  gate: GateResult;
  videoUrls: Record<string, string[]>;
  start: string;
  folder: string;
  specs: { name: string; text: string }[];
};

const cell = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ");

export function prBody(b: BodyInput): string {
  const rows = b.claims.map((c) => {
    const row = b.gate.rows.find((r) => r.id === c.id);
    const links = (b.videoUrls[c.id] ?? []).map((u, i) => `[video${i ? ` ${i + 1}` : ""}](${u})`).join(" ");
    return `| ${c.id} | ${cell(c.text)} | ${row?.status ?? "FAIL"} | ${links || "none"} |`;
  });
  const notProven = b.claims.filter((c) => !b.videoUrls[c.id]?.length).map((c) => `- ${c.id}: no video uploaded.`);
  const specs = b.specs.map((s) => `#### ${s.name}\n\n\`\`\`ts\n${s.text.trimEnd()}\n\`\`\``).join("\n\n");
  return `## Summary

${b.title}

${b.commits.map((c) => `- ${c}`).join("\n")}

## Features

| Claim | Sentence | Result | Video |
| --- | --- | --- | --- |
${rows.join("\n")}

## How it was run

- Start: \`${b.start}\`
- Commit: \`${b.gate.head}\`
- Tests: \`playwright test\` in the task folder \`${b.folder}\`
- Traces stay in \`${b.folder}/proof/results\`. They are not uploaded, because a trace can hold cookies.

## Not proven

${notProven.join("\n") || "None."}

## Test code

<details><summary>${b.specs.length} proof spec files (not in the diff)</summary>

${specs}

</details>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
`;
}

export function syncStatus(prState: string): TaskStatus | null {
  if (prState === "MERGED") return "merged";
  if (prState === "CLOSED") return "closed";
  return null;
}

export class ShipRefused extends Error {
  table: string;
  constructor(message: string, table = "") {
    super(message);
    this.table = table;
  }
}

async function gh(cwd: string, ...args: string[]): Promise<string> {
  const r = await run("gh", args, cwd);
  if (r.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${r.out.trim()}`);
  return r.out.trim();
}

async function uploadVideos(worktree: string, folder: string, pr: number, gate: GateResult, log: (l: string) => void) {
  const tag = `awb-proof-${pr}`;
  const staging = join(folder, "proof", "upload");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const names: Record<string, string[]> = {};
  for (const r of gate.rows) {
    names[r.id] = r.videos.map((v, i) => {
      const name = `pr${pr}-${r.id.toLowerCase()}-${i + 1}.webm`;
      copyFileSync(v, join(staging, name));
      return name;
    });
  }
  const files = Object.values(names).flat();
  if (!files.length) return {};
  const exists = (await run("gh", ["release", "view", tag], worktree)).code === 0;
  if (!exists) {
    await gh(worktree, "release", "create", tag, "--prerelease", "--title", `awb proof for PR #${pr}`, "--notes", `Proof videos for PR #${pr}, uploaded by awb ship.`);
  }
  log(`upload: ${files.length} videos to release ${tag}`);
  await gh(worktree, "release", "upload", tag, "--clobber", ...files.map((f) => join(staging, f)));
  const assets: { name: string; url: string }[] = JSON.parse(await gh(worktree, "release", "view", tag, "--json", "assets")).assets;
  const urlOf = (n: string) => {
    const a = assets.find((x) => x.name === n);
    if (!a) throw new Error(`release ${tag} has no asset ${n} after the upload`);
    return a.url;
  };
  return Object.fromEntries(Object.entries(names).map(([id, ns]) => [id, ns.map(urlOf)]));
}

export type ShipResult = { url: string; number: number; gate: GateResult; table: string };

export async function ship(task: Task, worktree: string, log: (l: string) => void): Promise<ShipResult> {
  if (!task.branch || !task.base) throw new ShipRefused(`task ${task.id} has no branch or base`);
  if (!existsSync(task.folder)) throw new ShipRefused("no proof yet: run awb prove first");
  const folder = realpathSync(task.folder);

  const gate = gateFromDisk(task.claims, folder, worktree);
  const table = claimTable(gate);
  if (!gate.pass) throw new ShipRefused("the gate fails; fix the code, commit, and run awb prove", table);
  log(`gate: PASS at ${gate.head.slice(0, 10)}`);

  const tests = join(folder, "proof-tests");
  const specs = readdirSync(tests)
    .filter((f) => /\.spec\.(ts|js)$/.test(f) && f !== "seed.spec.ts")
    .sort()
    .map((name) => ({ name, text: readFileSync(join(tests, name), "utf8") }));
  const recipe = parseRecipe(readFileSync(join(worktree, ".awb", "run.md"), "utf8"));
  await run("git", ["fetch", "-q", "origin", `+refs/heads/${task.base}:refs/remotes/origin/${task.base}`], worktree);
  const commits = execFileSync("git", ["log", "--format=%h %s", `origin/${task.base}..HEAD`], { cwd: worktree, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
  const body = (videoUrls: Record<string, string[]>) =>
    prBody({ title: task.title, commits, claims: task.claims, gate, videoUrls, start: recipe.start ?? recipe.url, folder, specs });

  const secrets = findSecrets([...specs, { name: "the PR body", text: body({}) }]);
  if (secrets.length) throw new ShipRefused(`secret scan: ${secrets.join("; ")}`, table);

  log(`push: ${task.branch}`);
  const push = await run("git", ["push", "-u", "origin", task.branch], worktree);
  if (push.code !== 0) throw new Error(`git push failed: ${push.out.trim()}`);

  const open = await run("gh", ["pr", "view", task.branch, "--json", "number,url,state"], worktree);
  let pr: { number: number; url: string } | null = null;
  if (open.code === 0) {
    const v = JSON.parse(open.out);
    if (v.state === "OPEN") pr = v;
  }
  if (!pr) {
    const bodyFile = join(folder, "proof", "pr-body.md");
    writeFileSync(bodyFile, body({}));
    const url = await gh(worktree, "pr", "create", "--draft", "--base", task.base, "--head", task.branch, "--title", task.title, "--body-file", bodyFile);
    pr = JSON.parse(await gh(worktree, "pr", "view", url.split("\n").at(-1)!, "--json", "number,url"));
    log(`draft PR: ${pr!.url}`);
  } else log(`draft PR exists: ${pr.url}`);

  const videoUrls = await uploadVideos(worktree, folder, pr!.number, gate, log);
  const bodyFile = join(folder, "proof", "pr-body.md");
  writeFileSync(bodyFile, body(videoUrls));
  await gh(worktree, "pr", "edit", String(pr!.number), "--body-file", bodyFile);
  return { url: pr!.url, number: pr!.number, gate, table };
}
