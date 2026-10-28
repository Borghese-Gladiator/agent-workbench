import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Session, Store } from "./store.ts";

export function createApp(store: Store, info: { home: string; startedAt: string }) {
  return createServer(async (req, res) => {
    try {
      await route(req, res, store, info);
    } catch (err) {
      send(res, 400, { error: (err as Error).message });
    }
  });
}

async function route(req: IncomingMessage, res: ServerResponse, store: Store, info: { home: string; startedAt: string }) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true, pid: process.pid, home: info.home, startedAt: info.startedAt, sessions: store.list().length });
  }
  if (req.method === "GET" && url.pathname === "/api/sessions") {
    return send(res, 200, store.list());
  }
  if (req.method === "POST" && url.pathname === "/api/sessions") {
    const body = await readJson(req);
    for (const k of ["repo", "worktree", "branch"]) {
      if (typeof body[k] !== "string" || !body[k]) throw new Error(`missing ${k}`);
    }
    const s = store.register({ id: randomUUID(), repo: body.repo, worktree: body.worktree, branch: body.branch, pid: body.pid });
    return send(res, 201, s);
  }
  if (req.method === "POST" && parts[0] === "api" && parts[1] === "sessions" && parts[3] === "end") {
    const body = await readJson(req);
    const ok = store.end(parts[2], typeof body.exitCode === "number" ? body.exitCode : null);
    return send(res, ok ? 200 : 404, ok ? { ok } : { error: "no open session with that id" });
  }
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(page(store.list(), info.home));
  }
  send(res, 404, { error: "not found" });
}

async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function page(sessions: Session[], home: string) {
  const rows = sessions
    .map(
      (s) => `<tr><td>${s.ended_at ? "ended" : "open"}</td><td>${esc(s.repo)}</td><td>${esc(s.branch)}</td><td>${esc(s.worktree)}</td><td>${esc(s.started_at)}</td><td>${esc(s.ended_at)}</td><td>${esc(s.exit_code)}</td></tr>`,
    )
    .join("");
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>awb sessions</title>
<style>body{font:14px system-ui;margin:24px}table{border-collapse:collapse}td,th{padding:4px 10px;border-bottom:1px solid #ddd;text-align:left}</style>
<h1>awb sessions</h1><p>AWB_HOME: ${esc(home)}</p>
<table><tr><th>state</th><th>repo</th><th>branch</th><th>worktree</th><th>started</th><th>ended</th><th>exit</th></tr>${rows}</table>`;
}
