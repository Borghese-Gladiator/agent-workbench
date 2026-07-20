import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { existsSync } from "node:fs";
import * as pty from "node-pty";
import { getSessionById, updateSession } from "../db/repositories/sessions.js";
import { sessionExists } from "./tmux.js";

// Resolve tmux absolute path. We check known Homebrew/system paths directly
// because `which` may not work reliably under nvm lazy-load shells.
const TMUX_CANDIDATES = [
  "/opt/homebrew/bin/tmux",
  "/usr/local/bin/tmux",
  "/usr/bin/tmux",
];
const TMUX_PATH = TMUX_CANDIDATES.find((p) => existsSync(p)) ?? "tmux";

const CLAUDE_RESUME_RE = /claude --resume ([a-f0-9-]+)/;

interface ClientDataMessage {
  type: "data";
  data: string;
}

interface ClientResizeMessage {
  type: "resize";
  cols: number;
  rows: number;
}

type ClientMessage = ClientDataMessage | ClientResizeMessage;

export function setupTerminalWebSocket(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? "", `http://${req.headers.host}`);
    const match = url.pathname.match(/^\/ws\/terminal\/(.+)$/);

    if (!match) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const sessionId = match[1];
      handleConnection(ws, sessionId);
    });
  });
}

function handleConnection(ws: WebSocket, sessionId: string): void {
  // Look up the session
  const session = getSessionById(sessionId);
  if (!session) {
    ws.send(
      JSON.stringify({ type: "error", message: "Session not found" }),
    );
    ws.close();
    return;
  }

  const tmuxName = session.tmux_session_name;
  if (!tmuxName || !sessionExists(tmuxName)) {
    ws.send(
      JSON.stringify({ type: "error", message: "tmux session not found" }),
    );
    ws.close();
    return;
  }

  const cwd = session.cwd ?? process.cwd();

  // Spawn node-pty attached to the tmux session
  let ptyProcess: pty.IPty;
  try {
    ptyProcess = pty.spawn(TMUX_PATH, ["attach", "-t", tmuxName], {
      name: "xterm-256color",
      cols: 200,
      rows: 50,
      cwd,
      env: process.env as Record<string, string>,
    });
  } catch (err) {
    console.error("[ws-relay] Failed to spawn pty:", err);
    sendJson(ws, { type: "error", message: "Failed to attach to tmux session" });
    ws.close();
    return;
  }

  // PTY stdout → WebSocket
  ptyProcess.onData((data: string) => {
    // Scan for Claude session ID
    const match = data.match(CLAUDE_RESUME_RE);
    if (match) {
      const claudeSessionId = match[1];
      updateSession(sessionId, { claude_session_id: claudeSessionId });
      sendJson(ws, {
        type: "session_update",
        state: "exited",
        claudeSessionId,
      });
    }

    sendJson(ws, { type: "data", data });
  });

  // PTY exit
  ptyProcess.onExit(({ exitCode }) => {
    updateSession(sessionId, {
      state: "exited",
      exited_at: new Date().toISOString(),
      exit_code: exitCode,
    });
    sendJson(ws, { type: "session_update", state: "exited" });
  });

  // WebSocket → PTY
  ws.on("message", (raw) => {
    try {
      const msg: ClientMessage = JSON.parse(String(raw));
      if (msg.type === "data") {
        ptyProcess.write(msg.data);
      } else if (msg.type === "resize") {
        ptyProcess.resize(msg.cols, msg.rows);
      }
    } catch {
      // Ignore malformed messages
    }
  });

  // On WebSocket close, dispose the pty (tmux stays alive)
  ws.on("close", () => {
    ptyProcess.kill();
  });

  // Update last_seen
  updateSession(sessionId, {
    last_seen_at: new Date().toISOString(),
  });
}

function sendJson(ws: WebSocket, data: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}
