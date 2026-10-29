import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Store } from "./store.ts";
import { tokenTotals } from "./usage.ts";

type Info = { home: string; startedAt: string };
type Extra = (req: IncomingMessage, res: ServerResponse, url: URL, body: () => Promise<Record<string, any>>) => Promise<boolean>;

export function createApp(store: Store, info: Info, extra?: Extra) {
  const clients = new Set<ServerResponse>();
  const broadcast = (sessionId: string) => {
    const row = store.feedRow(sessionId);
    if (!row) return;
    const msg = `event: session\ndata: ${JSON.stringify(row)}\n\n`;
    for (const c of clients) c.write(msg);
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (extra && (await extra(req, res, url, () => readJson(req)))) return;
      await route(req, res, store, info, clients, broadcast);
    } catch (err) {
      if (res.headersSent) res.end();
      else send(res, 400, { error: (err as Error).message });
    }
  });
  server.on("close", () => {
    for (const c of clients) c.end();
  });
  return server;
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  info: Info,
  clients: Set<ServerResponse>,
  broadcast: (id: string) => void,
) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true, pid: process.pid, home: info.home, startedAt: info.startedAt, sessions: store.list().length });
  }
  if (req.method === "GET" && url.pathname === "/api/sessions") {
    return send(res, 200, store.feed());
  }
  if (req.method === "POST" && url.pathname === "/api/sessions") {
    const body = await readJson(req);
    for (const k of ["repo", "worktree", "branch"]) {
      if (typeof body[k] !== "string" || !body[k]) throw new Error(`missing ${k}`);
    }
    const s = store.register({ id: randomUUID(), repo: body.repo, worktree: body.worktree, branch: body.branch, pid: body.pid });
    broadcast(s.id);
    return send(res, 201, s);
  }
  if (parts[0] === "api" && parts[1] === "sessions" && parts[2]) {
    const id = parts[2];
    if (req.method === "POST" && parts[3] === "end") {
      const body = await readJson(req);
      const ok = store.end(id, typeof body.exitCode === "number" ? body.exitCode : null);
      if (ok) broadcast(id);
      return send(res, ok ? 200 : 404, ok ? { ok } : { error: "no open session with that id" });
    }
    if (req.method === "GET" && parts[3] === "events") {
      return send(res, 200, store.events(id));
    }
  }
  if (req.method === "POST" && url.pathname === "/api/events") {
    const body = await readJson(req);
    if (typeof body.awb_session_id !== "string" || !store.session(body.awb_session_id)) {
      return send(res, 404, { error: "unknown awb session" });
    }
    const { awb_session_id, payload } = body;
    const ev = store.addEvent(awb_session_id, payload ?? {});
    if ((ev.hook === "Stop" || ev.hook === "SessionEnd") && typeof payload?.transcript_path === "string") {
      try {
        store.setUsage(awb_session_id, tokenTotals(payload.transcript_path));
      } catch {}
    }
    broadcast(awb_session_id);
    return send(res, 201, { id: ev.id });
  }
  if (req.method === "GET" && url.pathname === "/api/feed") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`event: snapshot\ndata: ${JSON.stringify(store.feed())}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(page(info.home));
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

function page(home: string) {
  return `<!doctype html><meta charset="utf-8"><title>awb sessions</title>
<style>
body{font:14px system-ui;margin:24px}table{border-collapse:collapse}
td,th{padding:4px 10px;border-bottom:1px solid #ddd;text-align:left}
.busy{color:#b45309;font-weight:600}.idle{color:#15803d}.ended{color:#888}
#status{color:#888}
</style>
<h1>awb sessions</h1><p>AWB_HOME: ${esc(home)} <span id="status">connecting…</span></p>
<table><thead><tr><th>state</th><th>repo</th><th>branch</th><th>last tool</th><th>last event</th><th>tokens in / out</th><th>started</th></tr></thead>
<tbody id="rows"></tbody></table>
<script>
const rows = new Map();
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const tok = (u) => u ? (u.input + u.cache_read + u.cache_creation) + " / " + u.output : "";
function render() {
  const list = [...rows.values()].sort((a, b) => b.started_at.localeCompare(a.started_at));
  document.getElementById("rows").innerHTML = list.map((s) =>
    "<tr data-id='" + esc(s.id) + "'><td class='" + s.state + "'>" + s.state + "</td><td>" + esc(s.repo) + "</td><td>" + esc(s.branch) +
    "</td><td>" + esc(s.last_tool) + "</td><td>" + esc(s.last_hook) + " " + esc(s.last_event_at) + "</td><td>" + tok(s.usage) +
    "</td><td>" + esc(s.started_at) + "</td></tr>").join("");
}
const es = new EventSource("/api/feed");
es.addEventListener("snapshot", (e) => { rows.clear(); for (const s of JSON.parse(e.data)) rows.set(s.id, s); render(); });
es.addEventListener("session", (e) => { const s = JSON.parse(e.data); rows.set(s.id, s); render(); });
es.onopen = () => document.getElementById("status").textContent = "live";
es.onerror = () => document.getElementById("status").textContent = "disconnected, retrying…";
</script>`;
}
