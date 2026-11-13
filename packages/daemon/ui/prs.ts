import { html, useState } from "./vendor/htm-preact.js";
import { post, repoName, usd, type Data, type Json } from "./components.ts";

const Gate = ({ t }: { t: Json }) =>
  !t.last_gate_at
    ? html`<span class="muted">no gate</span>`
    : t.failed_claims.length
      ? html`<span class="FAIL">FAIL</span> <span class="mono">${t.failed_claims.join(", ")}</span>`
      : html`<span class="PASS">PASS</span>`;

function Rows({ list, d }: { list: Json[]; d: Data }) {
  return html`<table>
    <thead><tr><th>PR</th><th>state</th><th>task</th><th>repo</th><th>branch</th><th>gate</th><th class="num">USD</th></tr></thead>
    <tbody>
      ${list.map(
        (t) => html`<tr>
          <td><a href=${t.pr_url}>#${t.pr_number}</a></td>
          <td class=${t.status}>${t.status === "done" ? "open" : t.status}</td>
          <td><a href=${"#/task/" + t.id}>${t.title}</a></td>
          <td>${repoName(t.repo)}</td>
          <td class="mono">${t.branch}</td>
          <td><${Gate} t=${t} /></td>
          <td class="mono num">${usd(d.taskUsd[t.id])}</td>
        </tr>`,
      )}
    </tbody>
  </table>`;
}

export function Prs({ d }: { d: Data }) {
  const [busy, setBusy] = useState(false);
  const prs = d.tasks
    .filter((t) => t.pr_number)
    .sort((a, b) => (a.status === "done" ? 0 : 1) - (b.status === "done" ? 0 : 1) || b.created_at.localeCompare(a.created_at));
  const open = prs.filter((t) => t.status === "done");
  const closed = prs.filter((t) => t.status !== "done");
  const sync = async () => {
    setBusy(true);
    try {
      await post("/api/sync", {});
    } catch {}
    await d.reload();
    setBusy(false);
  };
  return html`<h2>PRs</h2>
    <div class="actions">
      <button class="plain" disabled=${busy} onClick=${sync}>Sync now</button>
      <span class="muted">The daemon reads the state of each open PR from GitHub every minute.</span>
    </div>
    ${open.length ? html`<${Rows} list=${open} d=${d} />` : html`<p class="muted">No open PRs.</p>`}
    ${closed.length ? html`<details><summary>Merged and closed (${closed.length})</summary><${Rows} list=${closed} d=${d} /></details>` : null}`;
}
