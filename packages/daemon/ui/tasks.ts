import { html, useState } from "./vendor/htm-preact.js";
import { Branch, Chip, Empty, Page, repoName, Seg, usd, type Data } from "./components.ts";
import { filterTasks, SORT_START, sortTasks, type SortDir, type SortKey } from "./select.ts";

export const STATUS: [string, string][] = [["all", "All"], ["waiting", "Waiting"], ["doing", "Running"], ["failed", "Failed"], ["done", "Done"], ["merged", "Merged"], ["closed", "Closed"]];

function Th({ k, label, sort, onSort, cls }: { k: SortKey; label: string; sort: [SortKey, SortDir | "none"]; onSort: (k: SortKey) => void; cls?: string }) {
  const on = sort[0] === k && sort[1] !== "none";
  return html`<th class=${cls ?? ""} aria-sort=${on ? (sort[1] === "asc" ? "ascending" : "descending") : "none"}>
    <button class="sort" onClick=${() => onSort(k)}>${label}${on ? (sort[1] === "asc" ? " \u2191" : " \u2193") : ""}</button></th>`;
}

export function Tasks({ d }: { d: Data }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState<[SortKey, SortDir] | null>(null);
  const onSort = (k: SortKey) => setSort(sort?.[0] === k ? [k, sort[1] === "asc" ? "desc" : "asc"] : [k, SORT_START[k]]);
  const found = filterTasks(d.tasks, q, status);
  const list = sort ? sortTasks(found, sort[0], sort[1], d.taskUsd) : [...found].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const th = (k: SortKey, label: string, cls?: string) => html`<${Th} k=${k} label=${label} sort=${sort ?? ["title", "none"]} onSort=${onSort} cls=${cls} />`;
  return html`<${Page} title="Tasks">
    <div class="toolbar">
      <input class="search" type="search" aria-label="Search tasks" placeholder="Search title, branch, repo, id" value=${q} onInput=${(e: Event) => setQ((e.target as HTMLInputElement).value)} />
      <${Seg} label="Status" value=${status} options=${STATUS} onPick=${setStatus} />
    </div>
    ${list.length
      ? html`<table>
          <thead><tr>${th("title", "Task")}${th("status", "Status")}${th("repo", "Repository")}<th>Branch</th>${th("usd", "USD", "num")}<th>PR</th></tr></thead>
          <tbody>${list.map(
            (t) => html`<tr class="click" onClick=${(e: MouseEvent) => !(e.target as Element).closest("a,button") && (location.hash = "#/task/" + t.id)}>
              <td><a href=${"#/task/" + t.id}>${t.title}</a></td>
              <td class="nowrap"><${Chip} s=${t.status} /></td>
              <td class="muted nowrap">${repoName(t.repo)}</td>
              <td><${Branch} b=${t.branch} /></td>
              <td class="num mono">${usd(d.taskUsd[t.id])}</td>
              <td class="nowrap">${t.pr_url ? html`<a href=${t.pr_url} target="_blank">#${t.pr_number}</a>` : null}</td>
            </tr>`,
          )}</tbody>
        </table>`
      : html`<${Empty} text=${d.tasks.length ? "No task matches." : "No tasks yet."} />`}
  <//>`;
}
