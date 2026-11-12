import { html, useEffect, useState } from "./vendor/htm-preact.js";
import { get, State, TaskLink, taskOf, time, tok, type Data, type Json } from "./components.ts";

export function SessionView({ d, id }: { d: Data; id: string }) {
  const s = d.sessions.get(id);
  const [events, setEvents] = useState<Json[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    get("/api/sessions/" + id + "/events").then(setEvents, (e: Error) => setError(e.message));
  }, [id, s]);
  if (error) return html`<p class="FAIL">${error}</p>`;
  return html`<h2>Session <span class="mono muted">${id.slice(0, 8)}</span></h2>
    ${s
      ? html`<div class="card">
          <${State} s=${s.state} /> · ${s.repo} · <span class="mono">${s.branch}</span>
          ${taskOf(d, s) ? html` · task <${TaskLink} t=${taskOf(d, s)} />` : null}
          <br /><span class="muted">tokens in / out:</span> <span class="mono">${tok(s.usage) || "not yet"}</span>
          · <span class="muted">started</span> ${time(s.started_at)}
          ${s.ended_at ? html` · <span class="muted">ended</span> ${time(s.ended_at)}` : null}
        </div>`
      : null}
    <table>
      <thead><tr><th>time</th><th>hook</th><th>tool</th><th>detail</th></tr></thead>
      <tbody>
        ${events.map((e) => {
          const p = JSON.parse(e.payload);
          const detail = p.tool_input?.command ?? p.tool_input?.file_path ?? p.prompt ?? "";
          return html`<tr><td class="muted">${time(e.at)}</td><td>${e.hook}</td><td>${e.tool_name}</td><td class="mono">${String(detail).slice(0, 200)}</td></tr>`;
        })}
      </tbody>
    </table>`;
}
