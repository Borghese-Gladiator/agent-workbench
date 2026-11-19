import { html, useState } from "./vendor/htm-preact.js";
import { ago, Branch, repoName, State, TaskLink, taskOf, time, tok, usd, type Data, type Json, type Session } from "./components.ts";
import { needsAttention } from "./select.ts";

const NOTE: Record<string, string> = { quiet: "no event in the quiet time", lost: "its awb process is gone" };

function RunCard({ r }: { r: Json }) {
  return html`<div class="card">
    <h3>Run <span class=${r.state}>${r.state}</span> <span class="muted mono">${r.id.slice(0, 8)}</span></h3>
    ${r.state === "stopped" && r.reason ? html`<p class="FAIL">${r.reason}</p>` : null}
    ${repoName(r.repo)}${r.current ? html` · task <a href=${"#/task/" + r.current}>${r.title ?? r.current.slice(0, 8)}</a>` : null}
    ${" · " + (r.state === "running" ? "running for " : "ran for ") + ago(r.started_at, r.ended_at)} <span class="muted">since ${time(r.started_at)}</span>
  </div>`;
}

const Op = ({ s }: { s: Session }) =>
  s.current_op ? html`<b>${s.current_op.tool}</b> <code>${s.current_op.detail}</code>` : html`<span class="muted">none</span>`;

function SessionCard({ d, s }: { d: Data; s: Session }) {
  const t = taskOf(d, s);
  return html`<div class="card">
    <h3>${t ? html`<${TaskLink} t=${t} />` : html`<span class="mono">${s.branch}</span>`} <${State} s=${s.state} /></h3>
    ${repoName(s.repo)} · running for ${ago(s.started_at)} · <span class="mono">${usd(s.usage?.cost_usd ?? 0)} USD</span>
    <p>Current operation: <${Op} s=${s} /></p>
  </div>`;
}

const FILTERS = [["All", "all"], ["Busy", "busy"], ["Quiet", "quiet"], ["Lost", "lost"]];

function Finished({ d }: { d: Data }) {
  const done = d.tasks
    .filter((t) => t.status === "done" || t.status === "failed")
    .sort((a, b) => (b.last_gate_at ?? b.created_at).localeCompare(a.last_gate_at ?? a.created_at));
  return html`<h3>Recently finished</h3>
    ${done.length
      ? html`<table>
          <thead><tr><th>status</th><th>task</th><th>branch</th><th class="num">USD</th><th>result</th></tr></thead>
          <tbody>
            ${done.slice(0, 10).map(
              (t) => html`<tr>
                <td><${State} s=${t.status} /></td>
                <td><${TaskLink} t=${t} /></td>
                <td><${Branch} b=${t.branch} /></td>
                <td class="mono num">${usd(d.taskUsd[t.id] ?? 0)}</td>
                <td>${t.pr_number ? html`<a href=${t.pr_url} target="_blank">PR #${t.pr_number}</a>` : t.status === "failed" ? html`<span class="FAIL">${t.fail_reason}</span>` : null}</td>
              </tr>`,
            )}
          </tbody>
        </table>`
      : html`<p class="muted">No finished tasks yet.</p>`}`;
}

function Overview({ d, running }: { d: Data; running: number }) {
  const attention = needsAttention(d.tasks);
  const openPrs = d.tasks.filter((t) => t.pr_number && t.status === "done").length;
  const spent = Object.values(d.taskUsd).reduce((a, b) => a + b, 0);
  return html`<div class="card stats" aria-label="Summary">
      <div><span class="muted">Running</span><b>${running}</b></div>
      <div><span class="muted">Needs attention</span><b class=${attention.length ? "FAIL" : ""}>${attention.length}</b></div>
      <div><span class="muted">Open PRs</span><b>${openPrs}</b></div>
      <div><span class="muted">Total cost</span><b>${usd(spent)} USD</b></div>
    </div>
    <h3>Needs attention</h3>
    ${attention.length
      ? html`<table><tbody>${attention.map(
          ({ task, reason }) => html`<tr><td><${State} s=${task.status} /></td><td><${TaskLink} t=${task} /></td><td class="FAIL">${reason}</td>
            <td><a href=${"#/task/" + task.id}>Inspect</a></td></tr>`,
        )}</tbody></table>`
      : html`<p class="muted">Nothing needs attention.</p>`}`;
}

export function Live({ d }: { d: Data }) {
  const [filter, setFilter] = useState("all");
  const all = [...d.sessions.values()].sort((a, b) => b.started_at.localeCompare(a.started_at));
  const list = filter === "all" ? all : all.filter((s) => s.state === filter);
  const busy = all.filter((s) => s.state === "busy");
  const active = d.runs.filter((r) => r.state === "running");
  return html`<h2>Overview</h2>
    <${Overview} d=${d} running=${active.length} />
    ${(active.length ? active : d.runs.slice(0, 1)).map((r) => html`<${RunCard} r=${r} />`)}
    ${busy.map((s) => html`<${SessionCard} key=${s.id} d=${d} s=${s} />`)}
    <div class="actions filters" role="group" aria-label="Session state">
      ${FILTERS.map(
        ([label, k]) => html`<button class="plain" aria-pressed=${filter === k} onClick=${() => setFilter(k)}>${label} (${k === "all" ? all.length : all.filter((s) => s.state === k).length})</button>`,
      )}
    </div>
    <table>
      <thead><tr><th>state</th><th>repo</th><th>branch</th><th>task</th><th>Current operation</th><th>last event</th><th>tokens in / out</th><th class="num">USD</th><th>started</th></tr></thead>
      <tbody>
        ${list.map(
          (s) => html`<tr class="click" onClick=${(e: MouseEvent) => !(e.target as Element).closest("a") && (location.hash = "#/session/" + s.id)}>
            <td><${State} s=${s.state} />${NOTE[s.state] ? html`<span class="note">${NOTE[s.state]}</span>` : null}</td>
            <td>${repoName(s.repo)}</td>
            <td><${Branch} b=${s.branch} /></td>
            <td><${TaskLink} t=${taskOf(d, s)} /></td>
            <td><${Op} s=${s} /></td>
            <td>${s.last_hook} <span class="muted">${time(s.last_event_at)}</span></td>
            <td class="mono">${tok(s.usage)}</td>
            <td class="mono num">${usd(s.usage?.cost_usd)}</td>
            <td class="muted">${time(s.started_at)}</td>
          </tr>`,
        )}
      </tbody>
    </table>
    ${all.length ? null : html`<p class="muted">No sessions yet. Run <code>awb</code> in a repo.</p>`}
    <${Finished} d=${d} />`;
}
