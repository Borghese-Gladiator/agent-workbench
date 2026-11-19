import { html, useEffect, useState } from "./vendor/htm-preact.js";
import { Branch, get, post, repoName, usd, type Data, type Json } from "./components.ts";
import { costlyFailures, stackCost, stackProgress } from "./select.ts";

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
      <button>Save</button> <span class="msg muted">${msg}</span>
    </form>
  </details>`;
}

function Progress({ tasks }: { tasks: Json[] }) {
  const { finished, total, current } = stackProgress(tasks);
  return html`<p><progress max=${total} value=${finished} aria-label="Stack progress"></progress> ${finished} of ${total} tasks done${current ? html` · now: <a href=${"#/task/" + current.id}>${current.title}</a>` : null}</p>`;
}

export function Stacks({ d }: { d: Data }) {
  const [list, setList] = useState<Json[] | null>(null);
  const [error, setError] = useState("");
  const load = () => get("/api/stacks").then(setList, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);
  if (error) return html`<p class="FAIL">${error}</p>`;
  if (!list) return html`<h2>Stacks</h2><p class="muted">Loading…</p>`;
  const costly = costlyFailures(list.flatMap((st) => st.tasks), d.taskUsd);
  const saved = async () => {
    await d.reload();
    await load();
  };
  return html`<h2>Stacks</h2>
    ${list.length ? null : html`<p class="muted">No stacks yet.</p>`}
    ${list.map(
      (st) => html`<div class="card" key=${st.id + ":" + st.version}>
        <h3>${repoName(st.repo)} <span class="muted mono">stack ${st.id.slice(0, 8)} · version ${st.version} · base ${st.base}</span></h3>
        <${Progress} tasks=${st.tasks} />
        <p>Stack cost: <b class="mono">${usd(stackCost(st.tasks, d.taskUsd))} USD</b></p>
        <table>
          <thead><tr><th>#</th><th>status</th><th>task</th><th>branch</th><th class="num">USD</th><th>PR</th><th></th></tr></thead>
          <tbody>
            ${st.tasks.map(
              (t: Json, i: number) => html`<tr>
                <td>${i + 1}</td>
                <td class=${t.status}>${t.status}</td>
                <td><a href=${"#/task/" + t.id}>${t.title}</a>${t.fail_reason ? html`<div class="muted">${t.fail_reason}</div>` : null}</td>
                <td><${Branch} b=${t.branch} /></td>
                <td class="mono num">${usd(d.taskUsd[t.id])}${costly.has(t.id) ? html`<span class="note FAIL">costly failure</span>` : null}</td>
                <td>${t.pr_url ? html`<a href=${t.pr_url}>#${t.pr_number}</a>` : null}</td>
                <td>${t.status === "waiting" ? html`<${EditForm} st=${st} t=${t} onSaved=${saved} />` : null}</td>
              </tr>`,
            )}
          </tbody>
        </table>
      </div>`,
    )}`;
}
