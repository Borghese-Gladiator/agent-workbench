import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { needsShell, openCommand } from "../../daemon/src/platform.ts";
import { runFilePath } from "../../daemon/src/run-md.ts";
import { awbHome, ensureDaemon, findDaemon, api, reportCliError } from "./home.ts";
import { gitInfo, playbookPath, claudeArgs, awbSettings, repoRulesPath, splitResume, resumeArgs } from "./launch.ts";
import { doctor } from "./doctor.ts";
import { wtCmd } from "./wt.ts";
import { loggingCmd } from "./logging.ts";
import { helpFor, helpIndex } from "./help.ts";
import { logText, type LogLine } from "../../daemon/src/log.ts";

const home = awbHome();
const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const positional = () => rest.find((a, i) => !a.startsWith("-") && rest[i - 1] !== "--retries");

const wantsHelp = rest.includes("--help") || rest.includes("-h");
if (cmd === "--help" || cmd === "-h" || cmd === "help" || (wantsHelp && helpFor(cmd))) {
  console.log((cmd === "help" ? helpFor(rest[0]) : wantsHelp ? helpFor(cmd) : undefined) ?? helpIndex());
  process.exit(0);
}

console.error(`awb: AWB_HOME=${home}`);

const COMMANDS = ["ui", "doctor", "daemon", "stack", "prove", "ship", "run", "retry", "stop", "show", "tasks", "cost", "logs", "task", "sessions", "wt", "schedule", "logging", "limit", "stacks", "cleanup"];
let lastError = "";
const printError = console.error;
console.error = (...args: unknown[]) => {
  const text = args.map(String).join(" ");
  if (text.startsWith("awb: ") && !text.startsWith("awb: AWB_HOME=")) lastError = text.slice(5);
  printError(...args);
};
process.on("beforeExit", async () => {
  const code = Number(process.exitCode ?? 0);
  if (!COMMANDS.includes(cmd) || code === 0 || !lastError || process.env.AWB_REPORTED) return;
  process.env.AWB_REPORTED = "1";
  await reportCliError(home, [cmd, ...rest].join(" "), code, lastError).catch(() => {});
});

switch (cmd) {
  case "ui": {
    const d = await ensureDaemon(home);
    const url = `http://127.0.0.1:${d.port}/`;
    console.log(url);
    if (!rest.includes("--no-open")) {
      const [cmd, args] = openCommand(url);
      spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true }).unref();
    }
    break;
  }
  case "doctor":
    process.exitCode = (await doctor(home)) ? 0 : 1;
    break;
  case "wt":
    process.exitCode = await wtCmd(rest);
    break;
  case "logging":
    process.exitCode = loggingCmd(home, rest[0] === "down" ? ["down"] : ["up", "-d"]);
    break;
  case "daemon":
    await daemonCmd(rest[0], rest.includes("--when-idle"));
    break;
  case "stack":
    if (rest[0] === "show") process.exitCode = await stacksCmd(rest.slice(1).find((a) => !a.startsWith("-")), rest.includes("--json"));
    else if (rest[0] === "set") process.exitCode = await stackSet(rest.includes("--json"));
    else {
      console.error("usage: awb stack set < stack.json | awb stack show <stack id>");
      process.exitCode = 2;
    }
    break;
  case "stacks":
    process.exitCode = await stacksCmd(undefined, rest.includes("--json"));
    break;
  case "limit":
    process.exitCode = await limitCmd(positional(), rest.includes("--json"));
    break;
  case "cleanup": {
    const { killLeftovers } = await import("../../daemon/src/process.ts");
    console.log(`stopped ${killLeftovers(join(home, "apps.json"))} leftover app servers`);
    break;
  }
  case "prove":
    process.exitCode = await proveCmd(rest.includes("--json"), flag("--rewrite")?.split(",").filter(Boolean) ?? []);
    break;
  case "ship":
    process.exitCode = await shipCmd(rest.includes("--json"));
    break;
  case "run":
    process.exitCode = rest.includes("--all-stopped")
      ? await resumeAllCmd(rest.includes("--json"), flag("--retries"))
      : await runCmd(positional(), rest.includes("--json"), rest.includes("--wait"), flag("--retries"));
    break;
  case "retry":
    process.exitCode = await retryCmd(positional(), rest.includes("--json"), rest.includes("--wait"), flag("--retries"));
    break;
  case "stop":
    process.exitCode = await stopCmd(rest.find((a) => !a.startsWith("-")), rest.includes("--json"), rest.includes("--after-task"));
    break;
  case "show":
    process.exitCode = await showCmd(rest.find((a) => !a.startsWith("-")), rest.includes("--json"));
    break;
  case "tasks":
    process.exitCode = await tasksCmd(rest);
    break;
  case "cost":
    process.exitCode = await costCmd(rest.includes("--json"));
    break;
  case "logs":
    process.exitCode = await logsCmd(rest.includes("--json"), rest.includes("--follow") || rest.includes("-f"));
    break;
  case "schedule":
    process.exitCode = await scheduleCmd(rest);
    break;
  case "task":
    if (rest[0] !== "rm" || rest.length < 2) {
      console.error("usage: awb task rm <id...>");
      process.exitCode = 2;
      break;
    }
    process.exitCode = await taskRm(rest.slice(1).filter((a) => !a.startsWith("-")), rest.includes("--json"));
    break;
  case "sessions": {
    const d = await ensureDaemon(home);
    const list = await api(d, "/api/sessions");
    if (rest.includes("--json")) console.log(JSON.stringify(list, null, 2));
    else for (const s of list) console.log(`${s.ended_at ? "ended" : "open "}  ${s.branch.padEnd(30)} ${s.worktree}`);
    break;
  }
  default:
    process.exitCode = await launch(process.argv.slice(2));
}

async function scheduleCmd(args: string[]): Promise<number> {
  const [sub, arg] = args.filter((a) => !a.startsWith("-"));
  const json = args.includes("--json");
  const d = await ensureDaemon(home);
  const show = (v: unknown, text: () => void) => (json ? console.log(JSON.stringify(v, null, 2)) : text());
  try {
    if (!sub || sub === "status") {
      const s = await api(d, "/api/schedule");
      show(s, () => {
        if (s.error) console.error(`awb: ${s.file} is not valid: ${s.error}`);
        if (!s.jobs.length && !s.error) console.log(`no jobs; add them to ${s.file}`);
        for (const j of s.jobs) {
          const last = j.last ? `${j.last.state} ${j.last.started_at.slice(0, 16).replace("T", " ")} ${j.last.end ?? ""}` : "never ran";
          console.log(`${j.name.padEnd(20)} ${j.at} ${j.running ? "RUNNING" : "idle   "} next ${j.next?.slice(0, 16).replace("T", " ") ?? "none"}  last: ${last}`);
        }
      });
      return s.error ? 1 : 0;
    }
    if (sub === "runs") {
      const runs = await api(d, `/api/schedule/runs?limit=${flag("--limit") ?? 20}`);
      show(runs, () => runs.forEach((r: any) => console.log(`${r.id.slice(0, 8)}  ${r.job.padEnd(20)} ${r.state.padEnd(8)} ${r.started_at.slice(0, 16).replace("T", " ")}  ${r.end ?? ""}`)));
      return 0;
    }
    if (sub === "run" && arg) {
      await api(d, "/api/schedule/run", { name: arg });
      console.log(`started ${arg}; follow it with: awb logs --source schedule -f`);
      return 0;
    }
    if (sub === "output" && arg) {
      const runs = await api(d, "/api/schedule/runs?limit=500");
      const r = runs.find((x: any) => x.id.startsWith(arg));
      if (!r) throw new Error(`no run ${arg}`);
      console.log(await (await fetch(`http://127.0.0.1:${d.port}/api/schedule/runs/${r.id}/output`)).text());
      return 0;
    }
  } catch (err) {
    console.error(`awb: ${(err as Error).message}`);
    return 1;
  }
  console.error("usage: awb schedule [status|runs [--limit n]|run <job>|output <run id>] [--json]");
  return 2;
}

async function daemonCmd(sub: string | undefined, whenIdle = false) {
  if (sub === "start") {
    const d = await ensureDaemon(home);
    console.log(`daemon pid ${d.pid} on port ${d.port}`);
  } else if (sub === "stop") {
    const d = await findDaemon(home);
    if (!d) return console.log("daemon is not running");
    if (whenIdle) {
      for (;;) {
        const idle = await api(d, "/api/idle").catch(() => null);
        if (!idle || idle.running + idle.proofs + idle.busy === 0) break;
        console.error(`awb: waiting for ${idle.running} runs, ${idle.proofs} proofs and ${idle.busy} prove or ship calls to end`);
        await new Promise((ok) => setTimeout(ok, 5000));
      }
    }
    process.kill(d.pid, "SIGTERM");
    console.log(`stopped daemon pid ${d.pid}`);
  } else if (sub === "status") {
    const d = await findDaemon(home);
    console.log(d ? `daemon pid ${d.pid} on port ${d.port}` : "daemon is not running");
    process.exitCode = d ? 0 : 1;
  } else {
    console.error("usage: awb daemon start|stop [--when-idle]|status");
    process.exitCode = 2;
  }
}

function here() {
  try {
    return gitInfo(process.cwd());
  } catch {
    console.error("awb: not inside a git repo");
    return null;
  }
}

async function stackSet(json: boolean): Promise<number> {
  const git = here();
  if (!git) return 1;
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    console.error('awb: stack set reads JSON on stdin: {"tasks":[{"title":"...","claims":[{"id":"C1","text":"..."}]}]}');
    return 2;
  }
  const d = await ensureDaemon(home);
  try {
    const many = Array.isArray(input.tasks) && input.tasks.length > 1;
    const base = input.base ?? (many ? git.branch : defaultBranch(git.worktree));
    const r = await api(d, "/api/stacks", { ...input, repo: git.repo, branch: git.branch, base });
    if (json) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(`stack ${r.stack.id} version ${r.stack.version}`);
      for (const t of r.stack.tasks) console.log(`  task ${t.id}  ${t.status}  ${t.branch}  ${t.title} (${t.claims.length} claims)`);
      for (const k of ["added", "removed", "changed", "moved"]) if (r.changes[k].length) console.log(`  ${k}: ${r.changes[k].join(", ")}`);
    }
    return 0;
  } catch (err) {
    console.error(`awb: ${(err as Error).message}`);
    return 1;
  }
}

function defaultBranch(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "origin/HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true })
      .trim()
      .replace(/^origin\//, "");
  } catch {
    return "main";
  }
}

async function proveCmd(json: boolean, rewrite: string[]): Promise<number> {
  const git = here();
  if (!git) return 1;
  return streamNdjson("/api/prove", { ...git, sessionId: process.env.AWB_SESSION_ID, rewrite, deadline: Number(process.env.AWB_SESSION_DEADLINE) || undefined }, (r) => {
    if (json) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(r.table);
      if (r.writer) console.log(writerLine(r.writer));
      for (const row of r.rows) if (row.status === "FAIL" && row.videos.length) console.log(`  ${row.id} video: ${row.videos[0]}\n  ${row.id} trace: ${row.traces[0]}`);
      console.log(`evidence: ${r.folder}`);
    }
    return r.pass ? 0 : 1;
  });
}

function writerLine(w: { end: string; usd: number | null; timeoutMin?: number }): string {
  if (w.timeoutMin !== undefined && w.timeoutMin < 1) return `test writer: ${w.end}`;
  const cost = w.usd === null ? "cost unknown" : `${w.usd.toFixed(2)} USD`;
  return `test writer: ${w.end}, ${cost}, limit ${w.timeoutMin ?? "?"} min`;
}

async function streamNdjson(path: string, body: object, onResult: (r: any) => number): Promise<number> {
  const d = await ensureDaemon(home);
  const res = await fetch(`http://127.0.0.1:${d.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`awb: ${(await res.json()).error}`);
    return 1;
  }
  let buf = "";
  let code = 1;
  const decoder = new TextDecoder();
  for await (const chunk of res.body!) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.log) printError(`awb: ${msg.log}`);
      if (msg.error && msg.table) {
        printError(`awb: ${msg.error}`);
        console.log(msg.table);
      } else if (msg.error) console.error(`awb: ${msg.error}`);
      if (msg.result) code = onResult(msg.result);
    }
  }
  return code;
}

async function shipCmd(json: boolean): Promise<number> {
  const git = here();
  if (!git) return 1;
  return streamNdjson("/api/ship", git, (r) => {
    if (json) console.log(JSON.stringify(r, null, 2));
    else console.log(`${r.table}\nDraft PR: ${r.url}`);
    return 0;
  });
}

function printRun(r: any, json: boolean) {
  if (json) console.log(JSON.stringify(r, null, 2));
  else console.log(`run ${r.id} on stack ${r.stackId}: ${r.state}${r.current ? `, task ${r.current}` : ""}${r.reason ? ` (${r.reason})` : ""}`);
}

async function waitRun(d: Awaited<ReturnType<typeof ensureDaemon>>, r: any): Promise<any> {
  while (r.state === "running") {
    await new Promise((ok) => setTimeout(ok, 5000));
    r = await api(d, `/api/runs/${r.id}`);
  }
  return r;
}

async function runCmd(id: string | undefined, json: boolean, wait: boolean, retries?: string): Promise<number> {
  const git = here();
  if (!git) return 1;
  const d = await ensureDaemon(home);
  try {
    let r = await api(d, "/api/run", { repo: git.repo, id, retries });
    if (wait) r = await waitRun(d, r);
    printRun(r, json);
    return wait && r.state !== "done" ? 1 : 0;
  } catch (err) {
    console.error(`awb: ${(err as Error).message}`);
    return 1;
  }
}

async function retryCmd(id: string | undefined, json: boolean, wait: boolean, retries?: string): Promise<number> {
  if (!id) {
    console.error("usage: awb retry <stack id | task id> [--retries N]");
    return 2;
  }
  const d = await ensureDaemon(home);
  try {
    let r = await api(d, "/api/retry", { id, retries });
    if (wait) r = await waitRun(d, r);
    printRun(r, json);
    return wait && r.state !== "done" ? 1 : 0;
  } catch (err) {
    console.error(`awb: ${(err as Error).message}`);
    return 1;
  }
}

async function stopCmd(id: string | undefined, json: boolean, afterTask = false): Promise<number> {
  if (!id) {
    console.error("usage: awb stop <stack id | task id> [--after-task]");
    return 2;
  }
  const d = await ensureDaemon(home);
  try {
    const r = await api(d, "/api/stop", { id, afterTask });
    if (json) console.log(JSON.stringify(r, null, 2));
    else {
      if (r.run) printRun(r.run, false);
      if (r.afterTask) console.log("the run ends after the current task");
      for (const t of r.proofs) console.log(`stopped the proof of task ${t}`);
      for (const pid of r.sessions ?? []) console.log(`sent SIGTERM to session pid ${pid}`);
    }
    return 0;
  } catch (err) {
    console.error(`awb: ${(err as Error).message}`);
    return 1;
  }
}

async function limitCmd(n: string | undefined, json: boolean): Promise<number> {
  const d = await ensureDaemon(home);
  try {
    const r = n === undefined ? await api(d, "/api/limit") : await api(d, "/api/limit", { limit: n });
    console.log(json ? JSON.stringify(r, null, 2) : `stack limit ${r.limit}, ${r.running} running`);
    return 0;
  } catch (err) {
    console.error(`awb: ${(err as Error).message}`);
    return 1;
  }
}

async function resumeAllCmd(json: boolean, retries?: string): Promise<number> {
  const d = await ensureDaemon(home);
  try {
    const r = await api(d, "/api/resume-runs", { retries });
    if (json) console.log(JSON.stringify(r, null, 2));
    else {
      for (const x of r.started) printRun(x, false);
      for (const x of r.skipped) console.log(`skipped stack ${x.stack}: ${x.reason}`);
      if (!r.started.length && !r.skipped.length) console.log("no run was stopped by a daemon restart");
    }
    return 0;
  } catch (err) {
    console.error(`awb: ${(err as Error).message}`);
    return 1;
  }
}

async function stacksCmd(id: string | undefined, json: boolean): Promise<number> {
  const d = await ensureDaemon(home);
  try {
    const all = (await api(d, "/api/stacks")) as any[];
    const runs = (await api(d, "/api/runs?limit=200")) as any[];
    const lastRun = (stackId: string) => runs.find((r) => r.stackId === stackId);
    if (id) {
      const matches = all.filter((s) => s.id.startsWith(id));
      if (matches.length !== 1) throw new Error(matches.length ? `stack id prefix ${id} matches more than one stack` : `no stack ${id}`);
      const s = matches[0];
      const out = { ...s, runs: runs.filter((r) => r.stackId === s.id) };
      if (json) console.log(JSON.stringify(out, null, 2));
      else {
        console.log(`stack ${s.id}  ${s.repo}  base ${s.base}  version ${s.version}`);
        for (const t of s.tasks) console.log(`  task ${t.id}  ${t.status.padEnd(7)} ${t.branch}  ${t.title}${t.fail_reason ? `  (${t.fail_reason})` : ""}`);
        for (const r of out.runs) console.log(`  run ${r.id}  ${r.state}  ${r.started_at.slice(0, 16)}${r.reason ? `  (${r.reason})` : ""}`);
      }
      return 0;
    }
    if (json) console.log(JSON.stringify(all.map((s) => ({ ...s, run: lastRun(s.id) ?? null })), null, 2));
    else {
      if (!all.length) console.log("no stacks");
      for (const s of all) {
        const r = lastRun(s.id);
        const states = s.tasks.map((t: any) => t.status).join(",");
        console.log(`${s.id.slice(0, 8)}  ${basename(s.repo).padEnd(16)} ${r ? `run ${r.id.slice(0, 8)} ${r.state}`.padEnd(24) : "no run".padEnd(24)} ${states}`);
      }
    }
    return 0;
  } catch (err) {
    console.error(`awb: ${(err as Error).message}`);
    return 1;
  }
}

async function showCmd(taskId: string | undefined, json: boolean): Promise<number> {
  const d = await ensureDaemon(home);
  try {
    let t;
    if (taskId) t = await api(d, `/api/tasks/${encodeURIComponent(taskId)}`);
    else {
      const git = here();
      if (!git) return 1;
      t = await api(d, `/api/task?repo=${encodeURIComponent(git.repo)}&branch=${encodeURIComponent(git.branch)}`);
    }
    if (json) return console.log(JSON.stringify(t, null, 2)), 0;
    console.log(`task ${t.id}  ${t.status}  ${t.branch}\n  ${t.title}\n  folder: ${t.folder}`);
    if (t.pr_url) console.log(`  PR: ${t.pr_url}`);
    if (t.fail_reason) console.log(`  failed: ${t.fail_reason}`);
    console.log(`  cost: ${t.cost_usd.toFixed(2)} USD`);
    for (const c of t.claims) console.log(`  ${c.id}: ${c.text}`);
    for (const a of t.attempts) {
      console.log(`attempt ${a.id}  ${a.started_at}${a.ended_at ? "" : "  (running)"}`);
      for (const g of a.gates) {
        console.log(`  gate ${g.pass ? "PASS" : "FAIL"} at ${g.commit_sha.slice(0, 10)}`);
        for (const r of g.result.rows) console.log(`    ${r.id} ${r.status}${r.reasons.length ? "  " + r.reasons.join(", ") : ""}`);
      }
    }
    for (const f of t.transcripts) console.log(`transcript: ${f}`);
    return 0;
  } catch (err) {
    console.error(`awb: ${(err as Error).message}`);
    return 1;
  }
}

async function tasksCmd(args: string[]): Promise<number> {
  const q = new URLSearchParams();
  for (const k of ["repo", "status", "since"]) {
    const v = flag(`--${k}`);
    if (v) q.set(k, v);
  }
  const d = await ensureDaemon(home);
  try {
    const rows = await api(d, `/api/tasks?${q}`);
    if (args.includes("--json")) return console.log(JSON.stringify(rows, null, 2)), 0;
    if (!rows.length) console.log("no tasks");
    for (const t of rows) {
      const extra = t.pr_url ?? (t.failed_claims.length ? `failed: ${t.failed_claims.join(",")}` : "");
      console.log(`${t.id.slice(0, 8)}  ${t.status.padEnd(7)} ${t.created_at.slice(0, 16)}  ${t.title}  (${t.repo.split("/").at(-1)} ${t.branch})  ${extra}`);
    }
    return 0;
  } catch (err) {
    console.error(`awb: ${(err as Error).message}`);
    return 1;
  }
}

async function logsCmd(json: boolean, follow: boolean): Promise<number> {
  const q = new URLSearchParams({ since: flag("--since") ?? "1d", limit: flag("--limit") ?? "200" });
  for (const k of ["task", "run", "session", "level", "source"]) {
    const v = flag(`--${k}`);
    if (v) q.set(k, v);
  }
  const d = await ensureDaemon(home);
  const get = async (since?: string) => {
    if (since) q.set("since", since);
    const res = await fetch(`http://127.0.0.1:${d.port}/api/logs?${q}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? String(res.status));
    return body as LogLine[];
  };
  const print = (l: LogLine) => console.log(json ? JSON.stringify(l) : logText(l));
  try {
    let lines = await get();
    if (!lines.length && !follow) console.error("awb: no log lines match");
    lines.forEach(print);
    let last = lines.at(-1)?.ts;
    let seen = new Set(lines.filter((l) => l.ts === last).map((l) => JSON.stringify(l)));
    while (follow) {
      await new Promise((ok) => setTimeout(ok, 1000));
      lines = (await get(last)).filter((l) => !seen.has(JSON.stringify(l)));
      lines.forEach(print);
      if (lines.length) {
        last = lines.at(-1)!.ts;
        seen = new Set(lines.filter((l) => l.ts === last).map((l) => JSON.stringify(l)));
      }
    }
    return 0;
  } catch (err) {
    console.error(`awb: ${(err as Error).message}`);
    return 1;
  }
}

async function costCmd(json: boolean): Promise<number> {
  const q = new URLSearchParams({ since: flag("--since") ?? "7d" });
  const repo = flag("--repo");
  if (repo) q.set("repo", repo);
  if (!json) q.set("format", "text");
  const d = await ensureDaemon(home);
  const res = await fetch(`http://127.0.0.1:${d.port}/api/cost?${q}`);
  if (!res.ok) {
    console.error(`awb: ${(await res.json()).error ?? res.status}`);
    return 1;
  }
  console.log(json ? JSON.stringify(await res.json(), null, 2) : await res.text());
  return 0;
}

async function taskRm(ids: string[], json: boolean): Promise<number> {
  const d = await ensureDaemon(home);
  try {
    const r = await api(d, "/api/tasks/rm", { ids });
    console.log(json ? JSON.stringify(r, null, 2) : `removed: ${r.removed.join(", ")}`);
    return 0;
  } catch (err) {
    console.error(`awb: ${(err as Error).message}`);
    return 1;
  }
}

async function launch(passThrough: string[]): Promise<number> {
  const resume = splitResume(passThrough);
  let cwd = process.cwd();
  let daemon;
  if (resume) {
    daemon = await ensureDaemon(home);
    let q;
    if (resume.id) q = new URLSearchParams({ id: resume.id });
    else {
      const g = here();
      if (!g) return 1;
      q = new URLSearchParams({ repo: g.repo, branch: g.branch });
    }
    try {
      const r = await api(daemon, `/api/resume?${q}`);
      cwd = r.worktree;
      passThrough = resumeArgs(r.claude_session_id, resume.rest);
      console.error(`awb: resume claude session ${r.claude_session_id} in ${cwd}`);
    } catch (err) {
      console.error(`awb: ${(err as Error).message}`);
      return 1;
    }
  }
  let git;
  try {
    git = gitInfo(cwd);
  } catch {
    console.error(`awb: not inside a git repo: ${cwd}`);
    return 1;
  }
  daemon ??= await ensureDaemon(home);
  const session = await api(daemon, "/api/sessions", { ...git, pid: process.pid });
  console.error(`awb: session ${session.id} on ${git.branch}, daemon port ${daemon.port}`);

  const claude = process.env.AWB_CLAUDE || "claude";
  mkdirSync(join(home, "repos"), { recursive: true });
  const args = claudeArgs(passThrough, playbookPath(git.worktree), awbSettings(home), repoRulesPath(home, git.repo), runFilePath(home, git.repo));
  if (process.stdout.isTTY) process.stdout.write(`\x1b]0;[AWB] ${basename(git.repo)}\x07`);
  const child = spawn(claude, args, { cwd, stdio: "inherit", shell: needsShell(claude), env: { ...process.env, AWB: "1", AWB_HOME: home, AWB_SESSION_ID: session.id } });

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => child.kill(sig));
  const code: number = await new Promise((resolve) => {
    child.on("error", (err) => {
      console.error(`awb: could not start ${claude}: ${err.message}`);
      resolve(127);
    });
    child.on("exit", (c, signal) => resolve(c ?? (signal ? 128 : 1)));
  });

  try {
    const d = (await findDaemon(home)) ?? daemon;
    await api(d, `/api/sessions/${session.id}/end`, { exitCode: code });
    console.error(`awb: session ${session.id} ended with code ${code}`);
  } catch (err) {
    console.error(`awb: could not report the session end: ${(err as Error).message}`);
  }
  return code;
}
