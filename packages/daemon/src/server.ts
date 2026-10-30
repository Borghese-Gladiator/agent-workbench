import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Store } from "./store.ts";
import { tokenTotals } from "./usage.ts";
import { page } from "./ui.ts";

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
