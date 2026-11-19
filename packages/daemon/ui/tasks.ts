import { html, useState } from "./vendor/htm-preact.js";
import { Branch, Chip, Empty, Page, repoName, Seg, usd, type Data } from "./components.ts";
import { filterTasks } from "./select.ts";

const STATUS: [string, string][] = [["all", "All"], ["doing", "Running"], ["failed", "Failed"], ["waiting", "Waiting"], ["done", "Done"], ["merged", "Merged"]];

export function Tasks({ d }: { d: Data }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const list = filterTasks(d.tasks, q, status).sort((a, b) => b.created_at.localeCompare(a.created_at));
  return html`<${Page} title="Tasks">
    <div class="toolbar">
      <input class="search" type="search" aria-label="Search tasks" placeholder="Search title, branch, repo, id" value=${q} onInput=${(e: Event) => setQ((e.target as HTMLInputElement).value)} />
      <${Seg} label="Status" value=${status} options=${STATUS} onPick=${setStatus} />
    </div>
    ${list.length
      ? html`<table>
          <thead><tr><th>Task</th><th>Status</th><th>Repository</th><th>Branch</th><th class="num">USD</th><th>PR</th></tr></thead>
          <tbody>${list.map(
            (t) => html`<tr class="click" onClick=${(e: MouseEvent) => !(e.target as Element).closest("a,button") && (location.hash = "#/task/" + t.id)}>
              <td><a href=${"#/task/" + t.id}>${t.title}</a></td>
              <td><${Chip} s=${t.status} /></td>
              <td class="muted">${repoName(t.repo)}</td>
              <td><${Branch} b=${t.branch} /></td>
              <td class="num mono">${usd(d.taskUsd[t.id])}</td>
              <td>${t.pr_url ? html`<a href=${t.pr_url} target="_blank">#${t.pr_number}</a>` : null}</td>
            </tr>`,
          )}</tbody>
        </table>`
      : html`<${Empty} text=${d.tasks.length ? "No task matches." : "No tasks yet."} />`}
  <//>`;
}
