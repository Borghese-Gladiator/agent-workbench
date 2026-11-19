import { html, useState } from "./vendor/htm-preact.js";
import { ago, Branch, Chip, Empty, Id, Page, repoName, Seg, TaskLink, taskOf, time, tok, usd, type Data, type Json } from "./components.ts";
import { Op } from "./live.ts";

const NOTE: Record<string, string> = { quiet: "No event in the quiet time", lost: "Its awb process is gone" };
const FILTERS: [string, string][] = [["all", "All"], ["busy", "Busy"], ["quiet", "Quiet"], ["lost", "Lost"], ["ended", "Ended"]];

function RunHistory({ runs }: { runs: Json[] }) {
  if (!runs.length) return html`<${Empty} text="No runs yet." />`;
  return html`<table>
    <thead><tr><th>Run</th><th>State</th><th>Task</th><th>Repository</th><th>Duration</th></tr></thead>
    <tbody>${runs.map(
      (r) => html`<tr>
        <td><${Id} v=${r.id} /></td>
        <td><${Chip} s=${r.state} />${r.state === "stopped" && r.reason ? html`<span class="note FAIL">${r.reason}</span>` : null}</td>
        <td>${r.current ? html`<a href=${"#/task/" + r.current}>${r.title ?? r.current.slice(0, 8)}</a>` : null}</td>
        <td class="muted">${repoName(r.repo)}</td>
        <td class="muted">${ago(r.started_at, r.ended_at)}<span class="note">${time(r.started_at)}</span></td>
      </tr>`,
    )}</tbody>
  </table>`;
}

export function Runs({ d }: { d: Data }) {
  const [filter, setFilter] = useState("all");
  const all = [...d.sessions.values()].sort((a, b) => b.started_at.localeCompare(a.started_at));
  const list = filter === "all" ? all : all.filter((s) => s.state === filter);
  const options: [string, string][] = FILTERS.map(([k, label]) => [k, label + " (" + (k === "all" ? all.length : all.filter((s) => s.state === k).length) + ")"]);
  return html`<${Page} title="Runs">
    <h2>Run history</h2>
    <${RunHistory} runs=${d.runs} />
    <h2>Sessions</h2>
    <div class="toolbar"><${Seg} label="Session state" value=${filter} options=${options} onPick=${setFilter} /></div>
    ${list.length
      ? html`<table>
          <thead><tr><th>State</th><th>Task</th><th>Branch</th><th>Current operation</th><th>Tokens in / out</th><th class="num">USD</th><th>Started</th></tr></thead>
          <tbody>${list.map(
            (s) => html`<tr class="click" onClick=${(e: MouseEvent) => !(e.target as Element).closest("a,button") && (location.hash = "#/session/" + s.id)}>
              <td><${Chip} s=${s.state} />${NOTE[s.state] ? html`<span class="note">${NOTE[s.state]}</span>` : null}</td>
              <td>${taskOf(d, s) ? html`<${TaskLink} t=${taskOf(d, s)} />` : html`<span class="muted">${repoName(s.repo)}</span>`}</td>
              <td><${Branch} b=${s.branch} /></td>
              <td><${Op} s=${s} /><span class="note">${s.last_hook ?? ""} ${time(s.last_event_at)}</span></td>
              <td class="mono">${tok(s.usage)}</td>
              <td class="num mono">${usd(s.usage?.cost_usd)}</td>
              <td class="muted">${time(s.started_at)}</td>
            </tr>`,
          )}</tbody>
        </table>`
      : html`<${Empty} text=${all.length ? "No session in this state." : "No sessions yet. Run awb in a repo."} />`}
  <//>`;
}
