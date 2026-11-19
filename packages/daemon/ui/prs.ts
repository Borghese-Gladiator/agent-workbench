import { html, useState } from "./vendor/htm-preact.js";
import { Branch, Chip, Empty, Failure, Page, post, repoName, usd, type Data, type Json } from "./components.ts";
import { prGroup, type PrGroup } from "./select.ts";

const GROUPS: [PrGroup, string, string][] = [
  ["review", "Ready to review", "The proof passed and no earlier PR in the stack is open."],
  ["waiting", "Waiting for an earlier PR", "The proof passed. Merge the earlier PRs of the stack first."],
  ["blocked", "Blocked", "The task has no gate result, or a gate failed."],
];

const Verified = ({ t }: { t: Json }) =>
  !t.last_gate_at
    ? html`<${Chip} s="waiting" label="No gate" />`
    : t.failed_claims.length
      ? html`<${Chip} s="FAIL" label=${"Failed " + t.failed_claims.join(", ")} />`
      : html`<${Chip} s="PASS" label="Verified" />`;

function Rows({ list, d }: { list: Json[]; d: Data }) {
  return html`<table>
    <thead><tr><th>PR</th><th>Task</th><th>Repository</th><th>Branch</th><th>AI proof</th><th class="num">USD</th><th></th></tr></thead>
    <tbody>${list.map(
      (t) => html`<tr>
        <td><a href=${t.pr_url} target="_blank">#${t.pr_number}</a>${t.status === "done" ? null : html`<span class="note">${t.status}</span>`}</td>
        <td><a href=${"#/task/" + t.id}>${t.title}</a></td>
        <td class="muted">${repoName(t.repo)}</td>
        <td><${Branch} b=${t.branch} /></td>
        <td><${Verified} t=${t} /></td>
        <td class="mono num">${usd(d.taskUsd[t.id])}</td>
        <td class="num"><a href=${"#/task/" + t.id + "/changes"}>Changes</a></td>
      </tr>`,
    )}</tbody>
  </table>`;
}

export function Prs({ d }: { d: Data }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const prs = d.tasks.filter((t) => t.pr_number).sort((a, b) => b.created_at.localeCompare(a.created_at));
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
  return html`<${Page} title="Reviews" actions=${html`<button disabled=${busy} onClick=${sync}>Sync now</button>`}>
    <p class="muted">The daemon reads the state of each open PR from GitHub every minute. A verified PR passed the AI proof. It does not show that a person reviewed it.</p>
    ${error ? html`<${Failure} text=${"Sync failed: " + error} />` : null}
    ${open.length
      ? GROUPS.map(([k, label, hint]) => {
          const list = open.filter((t) => prGroup(t, d.tasks) === k);
          return list.length ? html`<h2>${label} (${list.length})</h2><p class="muted">${hint}</p><${Rows} list=${list} d=${d} />` : null;
        })
      : html`<${Empty} text="No open PRs." />`}
    ${closed.length ? html`<details><summary>Merged and closed (${closed.length})</summary><${Rows} list=${closed} d=${d} /></details>` : null}
  <//>`;
}
