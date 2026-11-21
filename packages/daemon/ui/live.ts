import { html } from "./vendor/htm-preact.js";
import { ago, Chip, Empty, Page, repoName, Stat, Stats, TaskLink, taskOf, usd, When, type Data, type Json, type Session } from "./components.ts";
import { needsAttention } from "./select.ts";

export const Op = ({ s }: { s: Session }) =>
  s.current_op ? html`<b>${s.current_op.tool}</b> <code class="trunc" title=${s.current_op.detail}>${s.current_op.detail}</code>` : html`<span class="muted">none</span>`;

function Active({ d }: { d: Data }) {
  const runs = d.runs.filter((r) => r.state === "running");
  const busy = [...d.sessions.values()].filter((s) => s.state === "busy");
  if (!runs.length && !busy.length) return html`<${Empty} text="No agent is running." />`;
  return html`<table><tbody>
    ${runs.map(
      (r: Json) => html`<tr><td><${Chip} s="running" /></td>
        <td>${r.current ? html`<a href=${"#/task/" + r.current}>${r.title ?? r.current.slice(0, 8)}</a>` : "Run"}<span class="note">${repoName(r.repo)}</span></td>
        <td class="muted">running for ${ago(r.started_at)}</td></tr>`,
    )}
    ${busy.map(
      (s) => html`<tr class="click" onClick=${() => (location.hash = "#/session/" + s.id)}><td><${Chip} s="busy" /></td>
        <td>${taskOf(d, s) ? html`<${TaskLink} t=${taskOf(d, s)} />` : s.branch}<span class="note">Session · ${repoName(s.repo)}</span></td>
        <td><${Op} s=${s} /></td></tr>`,
    )}
  </tbody></table>`;
}

function Attention({ d }: { d: Data }) {
  const items = needsAttention(d.tasks);
  if (!items.length) return html`<${Empty} text="Nothing needs attention." />`;
  return html`<table class="list"><tbody>${items.map(
    ({ task, reason }) => html`<tr class="click" onClick=${() => (location.hash = "#/task/" + task.id)}>
      <td class="state"><${Chip} s=${task.status} /></td>
      <td><${TaskLink} t=${task} /><span class="note FAIL">${reason}</span></td>
      <td class="end"><a href=${"#/task/" + task.id}>Inspect</a></td></tr>`,
  )}</tbody></table>`;
}

export function Overview({ d }: { d: Data }) {
  const running = d.runs.filter((r) => r.state === "running").length;
  const attention = needsAttention(d.tasks).length;
  const openPrs = d.tasks.filter((t) => t.pr_number && t.status === "done").length;
  const spent = Object.values(d.taskUsd).reduce((a, b) => a + b, 0);
  const recent = [...d.tasks].sort((a, b) => (b.last_gate_at ?? b.created_at).localeCompare(a.last_gate_at ?? a.created_at)).slice(0, 6);
  return html`<${Page} title="Overview">
    <${Stats}>
      <${Stat} label="Running" value=${running} />
      <${Stat} label="Needs attention" value=${attention} tone=${attention ? "FAIL" : ""} />
      <${Stat} label="Open PRs" value=${openPrs} />
      <${Stat} label="Total cost" value=${usd(spent) + " USD"} />
    <//>
    <h2>Active now</h2><${Active} d=${d} />
    <h2>Needs attention</h2><${Attention} d=${d} />
    <h2>Recent activity</h2>
    ${recent.length
      ? html`<table class="list" aria-label="Recent activity"><tbody>${recent.map(
          (t) => html`<tr class="click" onClick=${(e: MouseEvent) => !(e.target as Element).closest("a") && (location.hash = "#/task/" + t.id)}>
            <td class="state"><${Chip} s=${t.status} /></td>
            <td><${TaskLink} t=${t} /></td>
            <td class="pr">${t.pr_url ? html`<a href=${t.pr_url} target="_blank" aria-label=${"Open PR " + t.pr_number}>PR #${t.pr_number}</a>` : null}</td>
            <td class="when muted"><${When} t=${t.last_gate_at ?? t.created_at} /></td></tr>`,
        )}</tbody></table>`
      : html`<${Empty} text="No activity yet." />`}
  <//>`;
}
