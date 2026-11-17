import { html, useEffect, useState } from "./vendor/htm-preact.js";
import { get, LogLine, type Json } from "./components.ts";

const SOURCES = ["", "daemon", "runner", "prove", "ship", "sync", "http", "cli", "notify", "usage"];

export function Logs({ task }: { task: string }) {
  const [f, setF] = useState({ level: "info", source: "", task, since: task ? "3650d" : "1d" });
  const [follow, setFollow] = useState(false);
  const [lines, setLines] = useState<Json[] | null>(null);
  const [error, setError] = useState("");

  const load = async () => {
    const q = new URLSearchParams({ limit: "500" });
    for (const [k, v] of Object.entries(f)) if (v) q.set(k, v.trim());
    try {
      setLines(await get("/api/logs?" + q));
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
  return html`<h2>Logs</h2>
    <form class="actions filters" onSubmit=${(e: Event) => e.preventDefault()}>
      <label>Level <select value=${f.level} onChange=${set("level")}>
        ${["debug", "info", "warn", "error"].map((l) => html`<option value=${l}>${l}</option>`)}
      </select></label>
      <label>Source <select value=${f.source} onChange=${set("source")}>
        ${SOURCES.map((s) => html`<option value=${s}>${s || "all"}</option>`)}
      </select></label>
      <label>Task <input value=${f.task} onChange=${set("task")} placeholder="task id" /></label>
      <label>Since <input value=${f.since} onChange=${set("since")} placeholder="1h, 1d, 7d" /></label>
      <label class="box"><input type="checkbox" checked=${follow} onChange=${(e: Event) => setFollow((e.target as HTMLInputElement).checked)} />Follow</label>
    </form>
    ${error ? html`<p class="FAIL" role="alert">${error}</p>` : null}
    ${lines === null
      ? html`<p class="muted">Loading…</p>`
      : html`<p class="muted">${lines.length} ${lines.length === 1 ? "line" : "lines"}${lines.length === 500 ? " (the newest 500)" : ""}</p>
          <pre aria-label="Log lines">${lines.length ? [...lines].reverse().map((l) => html`<${LogLine} l=${l} />`) : html`<span class="muted">no log lines</span>`}</pre>`}`;
}
