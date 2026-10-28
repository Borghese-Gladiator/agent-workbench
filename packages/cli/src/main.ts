import { spawn } from "node:child_process";
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
