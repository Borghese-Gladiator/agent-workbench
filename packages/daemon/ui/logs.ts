import { html, useEffect, useState } from "./vendor/htm-preact.js";
import { Empty, Failure, get, Loading, LogEntry, LogLine, Page, Seg, type Json } from "./components.ts";
import { matchLines, timeline } from "./select.ts";

const SOURCES = ["", "daemon", "runner", "prove", "ship", "sync", "http", "cli", "notify", "usage"];
const VIEWS: [string, string][] = [["events", "Events"], ["timeline", "Timeline"], ["raw", "Raw"]];

export function Logs({ task }: { task: string }) {
  const [f, setF] = useState({ level: "info", source: "", task, since: task ? "3650d" : "1d" });
  const [follow, setFollow] = useState(false);
  const [view, setView] = useState("events");
  const [q, setQ] = useState("");
  const [lines, setLines] = useState<Json[] | null>(null);
  const [error, setError] = useState("");

  const load = async () => {
    const p = new URLSearchParams({ limit: "500" });
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, v.trim());
    try {
      setLines(await get("/api/logs?" + p));
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  };
  useEffect(() => {
    void load();
    if (!follow) return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [f.level, f.source, f.task, f.since, follow]);

  const set = (k: keyof typeof f) => (e: Event) => setF({ ...f, [k]: (e.target as HTMLInputElement).value });
  const found = lines ? matchLines(lines, q) : [];
  const shown = [...found].reverse();
  return html`<${Page} title="Logs" crumbs=${task ? [["Tasks", "#/tasks"], ["Task", "#/task/" + task], ["Logs"]] : undefined}>
    <form class="toolbar" onSubmit=${(e: Event) => e.preventDefault()}>
      <label>Level <select value=${f.level} onChange=${set("level")}>${["debug", "info", "warn", "error"].map((l) => html`<option value=${l}>${l}</option>`)}</select></label>
      <label>Source <select value=${f.source} onChange=${set("source")}>${SOURCES.map((s) => html`<option value=${s}>${s || "all"}</option>`)}</select></label>
      <label>Task <input value=${f.task} onChange=${set("task")} placeholder="task id" /></label>
      <label>Since <input value=${f.since} onChange=${set("since")} placeholder="1h, 1d, 7d" size="6" /></label>
      <label class="box"><input type="checkbox" checked=${follow} onChange=${(e: Event) => setFollow((e.target as HTMLInputElement).checked)} />Follow</label>
    </form>
    <div class="toolbar">
      <${Seg} label="Log view" value=${view} options=${VIEWS} onPick=${setView} />
      <input class="search" type="search" aria-label="Search logs" placeholder="Search the loaded lines" value=${q} onInput=${(e: Event) => setQ((e.target as HTMLInputElement).value)} />
    </div>
    ${error ? html`<${Failure} text=${error} />` : null}
    ${lines === null
      ? html`<${Loading} />`
      : html`<p class="muted">${shown.length} ${shown.length === 1 ? "line" : "lines"}${lines.length === 500 ? " (the newest 500 are loaded)" : ""}</p>
        ${!shown.length
          ? html`<${Empty} text="No log lines." />`
          : view === "raw"
            ? html`<pre class="wrap" aria-label="Log lines">${shown.map((l) => html`<${LogLine} l=${l} />`)}</pre>`
            : view === "timeline"
              ? html`<ol aria-label="Timeline">${timeline(found, f.level === "info" ? "warn" : f.level).map(
                  (x) => html`<li><b class=${x.level === "error" ? "FAIL" : ""}>${x.ts.slice(11, 19)} ${x.title}</b><span class="note">${x.detail}</span></li>`,
                )}</ol>`
              : html`<div class="events" aria-label="Log events">${shown.map((l) => html`<${LogEntry} l=${l} />`)}</div>`}`}
  <//>`;
}
