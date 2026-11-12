import { html, render, useEffect, useState } from "./vendor/htm-preact.js";
import { get, usd, type Data, type Json, type Session } from "./components.ts";
import { Live } from "./live.ts";
import { SessionView } from "./session.ts";
import { Stacks } from "./stacks.ts";
import { Prs } from "./prs.ts";
import { TaskView } from "./task.ts";

const NAV = [
  ["live", "#/", "Live"],
  ["stacks", "#/stacks", "Stacks"],
  ["prs", "#/prs", "PRs"],
];

function App() {
  const [hash, setHash] = useState(location.hash);
  const [status, setStatus] = useState("connecting…");
  const [home, setHome] = useState("");
  const [today, setToday] = useState<number | null>(null);
  const [sessions, setSessions] = useState(new Map<string, Session>());
  const [d, setD] = useState({ tasks: [] as Json[], bySession: {} as Record<string, string>, runs: [] as Json[], taskUsd: {} as Record<string, number> });

  const reload = async () => {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    try {
      const [all, day, runs, tasks, bySession] = await Promise.all([
        get("/api/cost?since=3650d"),
        get("/api/cost?since=" + encodeURIComponent(midnight.toISOString())),
        get("/api/runs"),
        get("/api/tasks"),
        get("/api/session-tasks"),
      ]);
      setD({ tasks, bySession, runs, taskUsd: Object.fromEntries(all.by_task.map((x: Json) => [x.task_id, x.usd])) });
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
    const onHash = () => setHash(location.hash);
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
  return html`<header>
      <b>awb</b>
      ${NAV.map(([k, href, label]) => html`<a href=${href} class=${view === k ? "on" : ""}>${label}</a>`)}
      <span class="muted mono">${home}</span>
      <span class="muted">${today === null ? "" : "today " + usd(today) + " USD"}</span>
      <span id="status">${status}</span>
    </header>
    <main>${body}</main>`;
}

render(html`<${App} />`, document.getElementById("root")!);
