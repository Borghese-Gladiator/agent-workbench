import { html, render, useEffect, useState } from "./vendor/htm-preact.js";
import { get, usd, type Data, type Json, type Session } from "./components.ts";
import { Overview } from "./live.ts";
import { Tasks } from "./tasks.ts";
import { Runs } from "./runs.ts";
import { SessionView } from "./session.ts";
import { Stacks } from "./stacks.ts";
import { Prs } from "./prs.ts";
import { TaskView } from "./task.ts";
import { Verification } from "./verification.ts";
import { Logs } from "./logs.ts";
import { Usage } from "./usage.ts";
import { Settings, applyPrefs } from "./settings.ts";

applyPrefs();

const NAV: [string, string, string, string, string][] = [
  ["overview", "#/", "Overview", "M22 12h-4l-3 9L9 3l-3 9H2", "Workspace"],
  ["tasks", "#/tasks", "Tasks", "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11", ""],
  ["stacks", "#/stacks", "Stacks", "M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5", ""],
  ["runs", "#/runs", "Runs", "M5 3l14 9-14 9V3z", ""],
  ["reviews", "#/reviews", "Reviews", "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9", ""],
  ["verification", "#/verification", "Verification", "M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4 12 14.01l-3-3", "Observability"],
  ["logs", "#/logs", "Logs", "M4 6h16M4 12h16M4 18h10", ""],
  ["usage", "#/usage", "Usage", "M18 20V10M12 20V4M6 20v-6", ""],
  ["settings", "#/settings", "Settings", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z", ""],
];

const ALIAS: Record<string, string> = { live: "overview", prs: "reviews", "": "overview" };
const PARENT: Record<string, string> = { session: "runs", task: "tasks" };

function App() {
  const [hash, setHash] = useState(location.hash);
  const [status, setStatus] = useState("connecting…");
  const [today, setToday] = useState<number | null>(null);
  const [stackCount, setStackCount] = useState<number | null>(null);
  const [menu, setMenu] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem("awb.sidebar") === "collapsed"; } catch { return false; }
  });
  const toggleSidebar = () => {
    setCollapsed(!collapsed);
    try { localStorage.setItem("awb.sidebar", collapsed ? "open" : "collapsed"); } catch {}
  };
  const [sessions, setSessions] = useState(new Map<string, Session>());
  const [d, setD] = useState({ tasks: [] as Json[], bySession: {} as Record<string, string>, runs: [] as Json[], taskUsd: {} as Record<string, number> });

  const reload = async () => {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    try {
      const [all, day, runs, tasks, bySession, stacks] = await Promise.all([
        get("/api/cost?since=3650d"),
        get("/api/cost?since=" + encodeURIComponent(midnight.toISOString())),
        get("/api/runs"),
        get("/api/tasks"),
        get("/api/session-tasks"),
        get("/api/stacks"),
      ]);
      setD({ tasks, bySession, runs, taskUsd: Object.fromEntries(all.by_task.map((x: Json) => [x.task_id, x.usd])) });
      setStackCount(stacks.length);
      setToday(day.total_usd);
      setStatus((s) => (s.startsWith("reload failed") ? "live" : s));
    } catch (err) {
      setStatus("reload failed: " + (err as Error).message);
    }
  };

  useEffect(() => {
    const es = new EventSource("/api/feed");
    es.addEventListener("snapshot", (e) => setSessions(new Map(JSON.parse(e.data).map((s: Session) => [s.id, s]))));
    es.addEventListener("session", (e) => {
      const s: Session = JSON.parse(e.data);
      setSessions((m) => new Map(m).set(s.id, s));
    });
    es.onopen = () => setStatus("live");
    es.onerror = () => setStatus("disconnected, retrying…");
    const onHash = () => (setHash(location.hash), setMenu(false));
    window.addEventListener("hashchange", onHash);
    const timer = setInterval(() => ["task", "session", "logs"].includes(location.hash.split("/")[1]) || reload(), 30000);
    return () => (es.close(), window.removeEventListener("hashchange", onHash), clearInterval(timer));
  }, []);
  useEffect(() => void reload(), [hash]);

  const [, v, id, tab] = hash.split("/");
  const view = ALIAS[v ?? ""] ?? v;
  const data: Data = { ...d, sessions, reload };
  const body =
    view === "session" ? html`<${SessionView} key=${id} d=${data} id=${id} />`
    : view === "tasks" ? html`<${Tasks} d=${data} />`
    : view === "task" ? html`<${TaskView} key=${id} d=${data} id=${id} tab=${tab ?? "overview"} />`
    : view === "stacks" ? html`<${Stacks} d=${data} />`
    : view === "runs" ? html`<${Runs} d=${data} />`
    : view === "reviews" ? html`<${Prs} d=${data} />`
    : view === "verification" ? html`<${Verification} d=${data} />`
    : view === "logs" ? html`<${Logs} key=${id} task=${id ?? ""} />`
    : view === "usage" ? html`<${Usage} d=${data} />`
    : view === "settings" ? html`<${Settings} />`
    : html`<${Overview} d=${data} />`;
  const current = PARENT[view] ?? view;
  const count: Record<string, number | null> = {
    tasks: d.tasks.length || null,
    stacks: stackCount,
    reviews: d.tasks.filter((t) => t.pr_number && t.status === "done").length,
  };
  return html`<button class="menu" aria-expanded=${menu} aria-controls="sidebar" onClick=${() => setMenu(!menu)}>Menu</button>
    <aside id="sidebar" class=${[menu && "open", collapsed && "collapsed"].filter(Boolean).join(" ")}>
      <div class="head">
        <span class="brand">awb</span>
        <button class="collapse" aria-label=${collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded=${!collapsed} aria-controls="sidebar" title=${collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick=${toggleSidebar}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg>
        </button>
      </div>
      <nav aria-label="Main">
        ${NAV.map(
          ([k, href, label, icon, group]) => html`${group ? html`<div class="group">${group}</div>` : null}<a href=${href} aria-current=${current === k ? "page" : undefined} title=${label}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${icon} /></svg>
            <span class="label">${label}</span>${count[k] ? html`<span class="count">${count[k]}</span>` : null}
          </a>`,
        )}
      </nav>
      <div class="foot">
        <div><span class="muted">Daemon</span> <span id="status" class=${status === "live" ? "live" : ""}>${status}</span></div>
        <div><span class="muted">Today</span> <span class="mono">${today === null ? "" : usd(today) + " USD"}</span></div>
      </div>
    </aside>
    <main>${body}</main>`;
}

render(html`<${App} />`, document.getElementById("root")!);
