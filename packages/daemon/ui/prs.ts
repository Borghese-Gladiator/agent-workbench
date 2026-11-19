import { html, useState } from "./vendor/htm-preact.js";
import { Branch, post, repoName, usd, type Data, type Json } from "./components.ts";

import { prGroup, type PrGroup } from "./select.ts";

const GROUPS: [PrGroup, string][] = [
  ["review", "Ready to review"],
  ["waiting", "Waiting for an earlier PR in the stack"],
  ["blocked", "Blocked: no gate or a failed gate"],
];

const Gate =({ t }: { t: Json }) =>
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
          <td><${Branch} b=${t.branch} /></td>
          <td><${Gate} t=${t} /></td>
          <td class="mono num">${usd(d.taskUsd[t.id])}</td>
        </tr>`,
      )}
    </tbody>
  </table>`;
}

export function Prs({ d }: { d: Data }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const prs = d.tasks
    .filter((t) => t.pr_number)
    .sort((a, b) => (a.status === "done" ? 0 : 1) - (b.status === "done" ? 0 : 1) || b.created_at.localeCompare(a.created_at));
  const open = prs.filter((t) => t.status === "done");
  const closed = prs.filter((t) => t.status !== "done");
  const sync = async () => {
    setBusy(true);
    setError("");
    try {
      await post("/api/sync", {});
    } catch (err) {
      setError((err as Error).message);
    }
    await d.reload();
    setBusy(false);
  };
  return html`<h2>Reviews</h2>
    <div class="actions">
      <button class="plain" disabled=${busy} onClick=${sync}>Sync now</button>
      <span class="muted">The daemon reads the state of each open PR from GitHub every minute.</span>
    </div>
    ${error ? html`<p class="FAIL" role="alert">Sync failed: ${error}</p>` : null}
    <p class="muted">A gate PASS shows that the AI proof passed. It does not show that a human reviewed the PR.</p>
    ${open.length
      ? GROUPS.map(([k, label]) => {
          const list = open.filter((t) => prGroup(t, d.tasks) === k);
          return list.length ? html`<h3>${label} (${list.length})</h3><${Rows} list=${list} d=${d} />` : null;
        })
      : html`<p class="muted">No open PRs.</p>`}
    ${closed.length ? html`<details><summary>Merged and closed (${closed.length})</summary><${Rows} list=${closed} d=${d} /></details>` : null}`;
}
