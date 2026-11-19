import { html, useEffect, useState } from "./vendor/htm-preact.js";
import { Branch, Chip, Empty, Failure, get, Id, Loading, Page, post, repoName, Seg, usd, type Data, type Json } from "./components.ts";
import { costlyFailures, filterTasks, stackCost, stackProgress, stepStates } from "./select.ts";
import { STATUS } from "./tasks.ts";

function EditForm({ st, t, onSaved }: { st: Json; t: Json; onSaved: () => void }) {
  const [title, setTitle] = useState<string>(t.title);
  const [claims, setClaims] = useState<string>(t.claims.map((c: Json) => c.id + ": " + c.text).join("\n"));
  const [msg, setMsg] = useState("");
  const save = async (e: Event) => {
    e.preventDefault();
    const parsed = claims
      .split("\n")
      .map((l) => l.match(/^\s*(C\d+)\s*:\s*(.+)$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => ({ id: m[1], text: m[2], proof: t.claims.find((o: Json) => o.id === m[1])?.proof }));
    try {
      await post("/api/stacks", {
        stackId: st.id,
        version: st.version,
        repo: st.repo,
        branch: st.tasks[0].branch,
        base: st.base,
        tasks: st.tasks.map((x: Json) => (x.id === t.id ? { id: x.id, title, claims: parsed } : { id: x.id, title: x.title, claims: x.claims })),
      });
      onSaved();
    } catch (err) {
      setMsg((err as Error).message);
    }
  };
  return html`<details><summary>Edit title and claims</summary>
    <form onSubmit=${save}>
      <label>Title<input name="title" value=${title} onInput=${(e: Event) => setTitle((e.target as HTMLInputElement).value)} /></label>
      <label>Claims, one a line: <code>C1: text</code>
        <textarea name="claims" rows="4" value=${claims} onInput=${(e: Event) => setClaims((e.target as HTMLTextAreaElement).value)}></textarea>
      </label>
      <p><button class="primary">Save</button> <span class="msg muted">${msg}</span></p>
    </form>
  </details>`;
}

const STEP: Record<string, string> = { done: "done", running: "doing", failed: "failed", blocked: "Blocked", waiting: "waiting" };

function Progress({ tasks }: { tasks: Json[] }) {
  const { finished, total, current } = stackProgress(tasks);
  return html`<p class="muted"><progress max=${total} value=${finished} aria-label="Stack progress"></progress> ${finished} of ${total} tasks done${current ? html` · now: <a href=${"#/task/" + current.id}>${current.title}</a>` : null}</p>`;
}

export function Stacks({ d }: { d: Data }) {
  const [list, setList] = useState<Json[] | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("all");
  const load = () => get("/api/stacks").then(setList, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);
  if (error) return html`<${Page} title="Stacks"><${Failure} text=${error} /><//>`;
  if (!list) return html`<${Page} title="Stacks"><${Loading} /><//>`;
  const costly = costlyFailures(list.flatMap((st) => st.tasks), d.taskUsd);
  const saved = async () => {
    await d.reload();
    await load();
  };
  const shown = list.map((st) => ({ st, rows: filterTasks(st.tasks, "", status) })).filter((x) => x.rows.length);
  const count = shown.reduce((n, x) => n + x.rows.length, 0);
  return html`<${Page} title="Stacks">
    <div class="toolbar">
      <${Seg} label="Status" value=${status} options=${STATUS} onPick=${setStatus} />
      <span class="muted">${count} ${count === 1 ? "task" : "tasks"}</span>
    </div>
    ${shown.length ? null : html`<${Empty} text=${list.length ? "No task matches." : "No stacks yet."} />`}
    ${shown.map(({ st, rows }) => {
      const steps = stepStates(st.tasks);
      return html`<section class="panel" key=${st.id + ":" + st.version}>
        <h3>${repoName(st.repo)} <span class="muted">· base <span class="mono">${st.base}</span> · version ${st.version} · <${Id} v=${st.id} /></span></h3>
        <${Progress} tasks=${st.tasks} />
        <p class="muted">Stack cost <b class="mono">${usd(stackCost(st.tasks, d.taskUsd))} USD</b></p>
        <table>
          <thead><tr><th>#</th><th>State</th><th>Task</th><th>Branch</th><th class="num">USD</th><th>PR</th><th></th></tr></thead>
          <tbody>${rows.map(
            (t: Json) => {
              const i = st.tasks.indexOf(t);
              return html`<tr>
              <td class="muted">${i + 1}</td>
              <td><${Chip} s=${STEP[steps[i]]} label=${steps[i]} /></td>
              <td><a href=${"#/task/" + t.id}>${t.title}</a>${t.fail_reason ? html`<span class="note FAIL">${t.fail_reason}</span>` : null}</td>
              <td><${Branch} b=${t.branch} /></td>
              <td class="mono num">${usd(d.taskUsd[t.id])}${costly.has(t.id) ? html`<span class="note FAIL">costly failure</span>` : null}</td>
              <td>${t.pr_url ? html`<a href=${t.pr_url} target="_blank">#${t.pr_number}</a>` : null}</td>
              <td>${t.status === "waiting" ? html`<${EditForm} st=${st} t=${t} onSaved=${saved} />` : null}</td>
            </tr>`;
            },
          )}</tbody>
        </table>
      </section>`;
    })}
  <//>`;
}
