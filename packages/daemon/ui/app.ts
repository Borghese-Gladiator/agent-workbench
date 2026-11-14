import { html, render, useEffect, useState } from "./vendor/htm-preact.js";
import { get, usd, type Data, type Json, type Session } from "./components.ts";
import { Live } from "./live.ts";
import { SessionView } from "./session.ts";
import { Stacks } from "./stacks.ts";
import { Prs } from "./prs.ts";
import { TaskView } from "./task.ts";

const NAV = [
  ["live", "#/", "Live", "M22 12h-4l-3 9L9 3l-3 9H2"],
  ["stacks", "#/stacks", "Stacks", "M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"],
  ["prs", "#/prs", "PRs", "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9"],
];

function App() {
  const [hash, setHash] = useState(location.hash);
  const [status, setStatus] = useState("connecting…");
  const [home, setHome] = useState("");
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
    } catch {}
  };

  useEffect(() => {
    get("/health").then((h) => setHome(h.home), () => {});
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
    const timer = setInterval(() => location.hash.split("/")[1] || reload(), 30000);
    return () => (es.close(), window.removeEventListener("hashchange", onHash), clearInterval(timer));
  }, []);
  useEffect(() => void reload(), [hash]);

  const [, v, id] = hash.split("/");
  const view = v || "live";
  const data: Data = { ...d, sessions, reload };
  const body =
    view === "session" ? html`<${SessionView} key=${id} d=${data} id=${id} />`
    : view === "stacks" ? html`<${Stacks} d=${data} />`
    : view === "prs" ? html`<${Prs} d=${data} />`
    : view === "task" ? html`<${TaskView} key=${id} d=${data} id=${id} />`
    : html`<${Live} d=${data} />`;
  const current = view === "session" ? "live" : view === "task" ? "stacks" : view;
  const count: Record<string, number | null> = { stacks: stackCount, prs: d.tasks.filter((t) => t.pr_number && t.status === "done").length };
  return html`<button class="plain menu" aria-expanded=${menu} aria-controls="sidebar" onClick=${() => setMenu(!menu)}>Menu</button>
    <aside id="sidebar" class=${[menu && "open", collapsed && "collapsed"].filter(Boolean).join(" ")}>
      <div class="head">
        <b>awb</b>
        <button class="plain collapse" aria-label=${collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded=${!collapsed} aria-controls="sidebar" title=${collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick=${toggleSidebar}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg>
        </button>
      </div>
      <nav>
        ${NAV.map(
          ([k, href, label, icon]) => html`<a href=${href} aria-current=${current === k ? "page" : undefined} title=${label}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${icon} /></svg>
            <span class="label">${label}</span>${count[k] == null ? null : html`<span class="count">${count[k]}</span>`}
          </a>`,
        )}
      </nav>
      <div class="foot">
        <div class="muted mono home">${home}</div>
        <div><span class="muted">Daemon</span> <span id="status" class=${status === "live" ? "live" : ""}>${status}</span></div>
        <div><span class="muted">Today</span> <span class="mono">${today === null ? "" : usd(today) + " USD"}</span></div>
      </div>
    </aside>
    <main>${body}</main>`;
}

render(html`<${App} />`, document.getElementById("root")!);
