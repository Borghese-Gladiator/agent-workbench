import { html } from "./vendor/htm-preact.js";
import { ago, repoName, State, TaskLink, taskOf, time, tok, usd, type Data, type Json } from "./components.ts";

const NOTE: Record<string, string> = { quiet: "no event in the quiet time", lost: "its awb process is gone" };

function RunCard({ r }: { r: Json }) {
  return html`<div class="card">
    <h3>Run <span class=${r.state}>${r.state}</span> <span class="muted mono">${r.id.slice(0, 8)}</span></h3>
    ${r.state === "stopped" && r.reason ? html`<p class="FAIL">${r.reason}</p>` : null}
    ${repoName(r.repo)}${r.current ? html` · task <a href=${"#/task/" + r.current}>${r.title ?? r.current.slice(0, 8)}</a>` : null}
    ${" · " + (r.state === "running" ? "running for " : "ran for ") + ago(r.started_at, r.ended_at)} <span class="muted">since ${time(r.started_at)}</span>
  </div>`;
}

export function Live({ d }: { d: Data }) {
  const list = [...d.sessions.values()].sort((a, b) => b.started_at.localeCompare(a.started_at));
  const active = d.runs.filter((r) => r.state === "running");
  return html`<h2>Live</h2>
    ${(active.length ? active : d.runs.slice(0, 1)).map((r) => html`<${RunCard} r=${r} />`)}
    <table>
      <thead><tr><th>state</th><th>repo</th><th>branch</th><th>task</th><th>last tool</th><th>last event</th><th>tokens in / out</th><th class="num">USD</th><th>started</th></tr></thead>
      <tbody>
        ${list.map(
          (s) => html`<tr class="click" onClick=${(e: MouseEvent) => !(e.target as Element).closest("a") && (location.hash = "#/session/" + s.id)}>
            <td><${State} s=${s.state} />${NOTE[s.state] ? html`<span class="note">${NOTE[s.state]}</span>` : null}</td>
            <td>${repoName(s.repo)}</td>
            <td class="mono">${s.branch}</td>
            <td><${TaskLink} t=${taskOf(d, s)} /></td>
            <td>${s.last_tool}</td>
            <td>${s.last_hook} <span class="muted">${time(s.last_event_at)}</span></td>
            <td class="mono">${tok(s.usage)}</td>
            <td class="mono num">${usd(s.usage?.cost_usd)}</td>
            <td class="muted">${time(s.started_at)}</td>
          </tr>`,
        )}
      </tbody>
    </table>
    ${list.length ? null : html`<p class="muted">No sessions yet. Run <code>awb</code> in a repo.</p>`}`;
}
