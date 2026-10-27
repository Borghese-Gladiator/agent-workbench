#!/usr/bin/env python3
"""LIVE integration: real `claude` CLI driven through the daemon, hitting the
mid-run MCP question/permission gate, answered by a human (this script),
resuming to completion.

This is the end-to-end proof of the real-CLI Path A transport:
  daemon  --spawn-->  claude CLI  --permission-prompt-tool-->  workbench-ask MCP
  server  --HTTP /internal/ask-->  daemon QuestionGate  --SSE-->  (this script
  acts as the human and POSTs the answer)  -->  run resumes.

It uses a REAL claude run (real tokens, real login — no API key) confined to a
throwaway git worktree. Everything observed is written to an artifact file so
the run can be reviewed after the fact.

Run:  python3 scripts/manual/manual_test_live_cli_gate.py
Requires: `claude` on PATH + logged in, node, git, `pnpm install` done.
"""
import json
import os
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import urllib.request
import urllib.error

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = 4413
BASE = f"http://localhost:{PORT}/api"
ARTIFACT = os.path.join(ROOT, "live_cli_gate_run.md")

LOG_LINES = []


def log(line=""):
    print(line, flush=True)
    LOG_LINES.append(line)


def _loads(raw):
    try:
        return json.loads(raw or b"{}")
    except json.JSONDecodeError:
        return {}


def api(method, path, body=None, timeout=120):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, _loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, _loads(e.read())


def sh(cwd, *args):
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True).stdout


def wait_for_health():
    for _ in range(50):
        try:
            if api("GET", "/health")[0] == 200:
                return
        except Exception:
            pass
        time.sleep(0.2)
    raise RuntimeError("daemon did not become healthy")


def make_git_repo(work):
    repo = os.path.join(work, "example-repo")
    os.makedirs(repo)
    sh(repo, "git", "init", "-b", "main")
    sh(repo, "git", "config", "user.email", "t@example.com")
    sh(repo, "git", "config", "user.name", "Test")
    with open(os.path.join(repo, "README.md"), "w") as f:
        f.write("# example app\n\nA tiny repo for the live gate test.\n")
    sh(repo, "git", "add", ".")
    sh(repo, "git", "commit", "-m", "initial")
    return repo


def stream_events(tid, run_id, sink, stop):
    """Read the run's SSE stream in a thread, appending parsed events to `sink`."""
    url = f"{BASE}/tasks/{tid}/agent/runs/{run_id}/events"
    try:
        with urllib.request.urlopen(url, timeout=600) as r:
            event_type = None
            for raw in r:
                if stop.is_set():
                    break
                line = raw.decode().rstrip("\n")
                if line.startswith("event:"):
                    event_type = line.split(":", 1)[1].strip()
                elif line.startswith("data:"):
                    payload = line.split(":", 1)[1].strip()
                    sink.append((event_type, payload))
    except Exception as e:
        sink.append(("__stream_error__", str(e)))


def main():
    work = tempfile.mkdtemp(prefix="wb-live-gate-")
    repo = make_git_repo(work)
    env = dict(os.environ)
    env["WORKBENCH_PORT"] = str(PORT)
    env["WORKBENCH_DATA_DIR"] = os.path.join(work, "data")

    log("# Live CLI gate integration")
    log()
    log(f"- claude: {subprocess.run(['claude','--version'],capture_output=True,text=True).stdout.strip()}")
    log(f"- temp repo: {repo}")
    log()

    proc = subprocess.Popen(
        ["pnpm", "--filter", "@workbench/daemon", "start"],
        cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        preexec_fn=os.setsid,
    )
    try:
        wait_for_health()
        log("daemon healthy\n")

        # A claude-runtime project: stage agents run the real CLI.
        _, project = api("POST", "/projects", {
            "name": "Live Gate Demo", "repoPath": repo, "defaultBranch": "main",
            "agentRuntime": "claude",
        })
        _, task = api("POST", "/tasks", {
            "projectId": project["id"], "title": "Add a greeting file",
            "rawRequest": "Create a file GREETING.txt containing the word hello.",
        })
        tid = task["id"]
        log(f"created claude-runtime task `{tid}`")

        # Reach a stage with a worktree. Approving the brief creates the real
        # worktree and (with auto-advance) parks at the plan gate.
        api("POST", f"/tasks/{tid}/generate-brief")
        api("POST", f"/tasks/{tid}/approve-brief")
        _, d = api("GET", f"/tasks/{tid}")
        wt = d["worktree"]
        log(f"worktree created: {wt['branch']} at {wt['worktreePath']}")
        log(f"task parked at: {d['task']['stage']}\n")

        # Start a STREAMING real-CLI run on the implementation stage. With the
        # MCP gate + --setting-sources "", the agent's Write needs approval and
        # routes to workbench_ask -> daemon -> us.
        code, b = api("POST", f"/tasks/{tid}/agent/implementation/stream")
        assert code == 202, f"start stream -> {code}: {b}"
        run_id = b["runId"]
        log(f"started LIVE implementation run `{run_id}` (202)\n")

        # Tail the SSE stream in the background.
        events = []
        stop = threading.Event()
        t = threading.Thread(target=stream_events, args=(tid, run_id, events, stop), daemon=True)
        t.start()

        # Wait for the run to park awaiting_input (the gate fired), up to ~3 min
        # (a real model turn + tool attempt takes time).
        log("waiting for the agent to hit the gate (real model run)…")
        gate_q = None
        for _ in range(180):
            _, rec = api("GET", f"/tasks/{tid}/agent/runs/{run_id}")
            status = rec["run"]["status"]
            if status == "awaiting_input":
                _, qs = api("GET", f"/tasks/{tid}/questions/unanswered")
                if qs:
                    gate_q = qs[0]
                    break
            if status in ("succeeded", "failed", "canceled"):
                log(f"run reached {status} WITHOUT hitting the gate")
                break
            time.sleep(1)

        if gate_q:
            log("\nGATE FIRED — agent paused for a human decision:")
            log(f"  header:   {gate_q['header']}")
            log(f"  question: {gate_q['question']}")
            log(f"  options:  {[o['label'] for o in (gate_q['options'] or [])]}")
            if gate_q.get("permission"):
                log(f"  permission for tool: {gate_q['permission']['toolName']}")
                log(f"  tool input: {json.dumps(gate_q['permission']['toolInput'])[:200]}")

            # Human (us) approves.
            ans = {"selected": ["allow"]} if gate_q.get("permission") else \
                  {"selected": [(gate_q["options"] or [{"label": ""}])[0]["label"]]}
            code, _ = api("POST", f"/tasks/{tid}/agent/questions/{gate_q['id']}/answer",
                          {"answer": ans})
            log(f"\n  -> answered {ans} (HTTP {code}); run should resume\n")

        # Wait for terminal.
        final = None
        for _ in range(180):
            _, rec = api("GET", f"/tasks/{tid}/agent/runs/{run_id}")
            if rec["run"]["status"] in ("succeeded", "failed", "canceled"):
                final = rec["run"]
                break
            time.sleep(1)
        stop.set()

        log(f"final run status: {final['status'] if final else '(timed out)'}")
        if final:
            log(f"  cost: {final.get('totalCostUsd')}  turns: {final.get('numTurns')}")
            if final.get("error"):
                log(f"  error: {final['error']}")

        # Did the agent actually create the file in the worktree?
        greeting = os.path.join(wt["worktreePath"], "GREETING.txt")
        if os.path.exists(greeting):
            with open(greeting) as f:
                content = f.read()
            log(f"\nworktree file GREETING.txt created, contents: {content!r}")
        else:
            log("\nGREETING.txt was NOT created in the worktree")

        # Dump the captured SSE event stream.
        log("\n## Captured SSE event stream")
        log("```")
        for et, payload in events[:120]:
            short = payload if len(payload) <= 160 else payload[:160] + "…"
            log(f"{et}: {short}")
        log("```")

        # Persisted run record + events.
        _, rec = api("GET", f"/tasks/{tid}/agent/runs/{run_id}")
        log(f"\npersisted event count: {len(rec['events'])}")

        verdict = "PASS" if (gate_q and final and final["status"] == "succeeded") else "REVIEW"
        log(f"\n## VERDICT: {verdict}")
        if verdict == "PASS":
            log("The live claude CLI paused mid-run at the MCP gate, waited for a "
                "human answer over HTTP, and resumed to success.")
    finally:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        with open(ARTIFACT, "w") as f:
            f.write("\n".join(LOG_LINES) + "\n")
        print(f"\n[artifact written: {ARTIFACT}]", flush=True)
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
