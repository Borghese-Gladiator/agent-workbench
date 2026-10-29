import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { awbHome, ensureDaemon, findDaemon, api } from "./home.ts";
import { gitInfo, playbookPath, claudeArgs, awbSettings } from "./launch.ts";
import { doctor } from "./doctor.ts";

const home = awbHome();
const [cmd, ...rest] = process.argv.slice(2);

console.error(`awb: AWB_HOME=${home}`);

switch (cmd) {
  case "ui": {
    const d = await ensureDaemon(home);
    const url = `http://127.0.0.1:${d.port}/`;
    console.log(url);
    if (!rest.includes("--no-open")) spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    break;
  }
  case "doctor":
    process.exitCode = (await doctor(home)) ? 0 : 1;
    break;
  case "daemon":
    await daemonCmd(rest[0]);
    break;
  case "stack":
    if (rest[0] !== "set") {
      console.error("usage: awb stack set < stack.json");
      process.exitCode = 2;
      break;
    }
    process.exitCode = await stackSet(rest.includes("--json"));
    break;
  case "prove":
    process.exitCode = await proveCmd(rest.includes("--json"));
    break;
  case "show":
    process.exitCode = await showCmd(rest.includes("--json"));
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

async function daemonCmd(sub: string | undefined) {
  if (sub === "start") {
    const d = await ensureDaemon(home);
    console.log(`daemon pid ${d.pid} on port ${d.port}`);
  } else if (sub === "stop") {
    const d = await findDaemon(home);
    if (!d) return console.log("daemon is not running");
    process.kill(d.pid, "SIGTERM");
    console.log(`stopped daemon pid ${d.pid}`);
  } else if (sub === "status") {
    const d = await findDaemon(home);
    console.log(d ? `daemon pid ${d.pid} on port ${d.port}` : "daemon is not running");
    process.exitCode = d ? 0 : 1;
  } else {
    console.error("usage: awb daemon start|stop|status");
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
    const base = input.base ?? defaultBranch(git.worktree);
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
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "origin/HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim()
      .replace(/^origin\//, "");
  } catch {
    return "main";
  }
}

async function proveCmd(json: boolean): Promise<number> {
  const git = here();
  if (!git) return 1;
  const d = await ensureDaemon(home);
  const res = await fetch(`http://127.0.0.1:${d.port}/api/prove`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...git, sessionId: process.env.AWB_SESSION_ID }),
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
      if (msg.log) console.error(`awb: ${msg.log}`);
      if (msg.error) console.error(`awb: prove failed: ${msg.error}`);
      if (msg.result) {
        if (json) console.log(JSON.stringify(msg.result, null, 2));
        else {
          console.log(msg.result.table);
          for (const r of msg.result.rows) if (r.status === "FAIL" && r.videos.length) console.log(`  ${r.id} video: ${r.videos[0]}\n  ${r.id} trace: ${r.traces[0]}`);
          console.log(`evidence: ${msg.result.folder}`);
        }
        code = msg.result.pass ? 0 : 1;
      }
    }
  }
  return code;
}

async function showCmd(json: boolean): Promise<number> {
  const git = here();
  if (!git) return 1;
  const d = await ensureDaemon(home);
  try {
    const t = await api(d, `/api/task?repo=${encodeURIComponent(git.repo)}&branch=${encodeURIComponent(git.branch)}`);
    if (json) return console.log(JSON.stringify(t, null, 2)), 0;
    console.log(`task ${t.id}  ${t.status}  ${t.branch}\n  ${t.title}\n  folder: ${t.folder}`);
    for (const c of t.claims) console.log(`  ${c.id}: ${c.text}`);
    for (const a of t.attempts) {
      console.log(`attempt ${a.id}  ${a.started_at}${a.ended_at ? "" : "  (running)"}`);
      for (const g of a.gates) console.log(`  gate ${g.pass ? "PASS" : "FAIL"} at ${g.commit_sha.slice(0, 10)}: ${g.result.rows.map((r: any) => `${r.id}=${r.status}`).join(" ")}`);
    }
    return 0;
  } catch (err) {
    console.error(`awb: ${(err as Error).message}`);
    return 1;
  }
}

async function launch(passThrough: string[]): Promise<number> {
  let git;
  try {
    git = gitInfo(process.cwd());
  } catch {
    console.error("awb: not inside a git repo");
    return 1;
  }
  const daemon = await ensureDaemon(home);
  const session = await api(daemon, "/api/sessions", { ...git, pid: process.pid });
  console.error(`awb: session ${session.id} on ${git.branch}, daemon port ${daemon.port}`);

  const claude = process.env.AWB_CLAUDE || "claude";
  const args = claudeArgs(passThrough, playbookPath(git.worktree), awbSettings(home));
  const child = spawn(claude, args, { stdio: "inherit", env: { ...process.env, AWB_HOME: home, AWB_SESSION_ID: session.id } });

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
