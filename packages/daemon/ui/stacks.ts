import { html, useEffect, useRef, useState } from "./vendor/htm-preact.js";
import { Branch, Chip, Empty, Failure, get, Id, Loading, Page, post, repoName, usd, type Data, type Json } from "./components.ts";
import { costlyFailures, splitStacks, stackCost, stackProgress, stepStates } from "./select.ts";

function EditModal({ st, t, onSaved }: { st: Json; t: Json; onSaved: () => void }) {
  const dlg = useRef<HTMLDialogElement | null>(null);
  const [title, setTitle] = useState<string>(t.title);
  const [claims, setClaims] = useState<string>(t.claims.map((c: Json) => c.id + ": " + c.text).join("\n"));
  const [msg, setMsg] = useState("");
  const open = () => {
    setTitle(t.title);
    setClaims(t.claims.map((c: Json) => c.id + ": " + c.text).join("\n"));
    setMsg("");
    dlg.current?.showModal();
  };
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
      dlg.current?.close();
      onSaved();
    } catch (err) {
      setMsg((err as Error).message);
    }
  };
  return html`<button onClick=${open} aria-label=${"Edit " + t.title}>Edit</button>
    <dialog ref=${dlg} aria-label="Edit task" onClick=${(e: MouseEvent) => e.target === dlg.current && dlg.current?.close()}>
      <form class="body" onSubmit=${save}>
        <h3>Edit task</h3>
        <label>Title<input name="title" value=${title} onInput=${(e: Event) => setTitle((e.target as HTMLInputElement).value)} /></label>
        <label>Claims, one a line, like <code>C1: text</code>
          <textarea name="claims" rows="8" value=${claims} onInput=${(e: Event) => setClaims((e.target as HTMLTextAreaElement).value)}></textarea>
        </label>
        ${msg ? html`<p class="FAIL" role="alert">${msg}</p>` : null}
        <div class="actions"><button type="button" onClick=${() => dlg.current?.close()}>Cancel</button><button class="primary">Save</button></div>
      </form>
    </dialog>`;
}

const STEP: Record<string, string> = { done: "done", running: "doing", failed: "failed", blocked: "Blocked", waiting: "waiting" };

function Progress({ tasks }: { tasks: Json[] }) {
  const { finished, total, current } = stackProgress(tasks);
  return html`<p class="muted"><progress max=${total} value=${finished} aria-label="Stack progress"></progress> ${finished} of ${total} tasks done${current ? html` · now: <a href=${"#/task/" + current.id}>${current.title}</a>` : null}</p>`;
}

const KEY = "awb.archivedStacks";
const readArchived = (): Set<string> => {
  try { return new Set(JSON.parse(localStorage.getItem(KEY) ?? "[]")); } catch { return new Set(); }
};

function StackPanel({ st, d, costly, onSaved, action }: { st: Json; d: Data; costly: Set<string>; onSaved: () => void; action: unknown }) {
  const steps = stepStates(st.tasks);
  return html`<section class="panel" key=${st.id + ":" + st.version}>
    <div class="panel-head">
      <h3>${repoName(st.repo)} <span class="muted">· base <span class="mono">${st.base}</span> · version ${st.version} · <${Id} v=${st.id} /></span></h3>
      ${action}
    </div>
    <${Progress} tasks=${st.tasks} />
    <p class="muted">Stack cost <b class="mono">${usd(stackCost(st.tasks, d.taskUsd))} USD</b></p>
    ${st.tasks.length
      ? html`<table class="list">
          <thead><tr><th>#</th><th>State</th><th>Task</th><th>Branch</th><th class="num">USD</th><th>PR</th><th></th></tr></thead>
          <tbody>${st.tasks.map(
            (t: Json, i: number) => html`<tr>
              <td class="muted">${i + 1}</td>
              <td class="nowrap"><${Chip} s=${STEP[steps[i]]} label=${steps[i]} /></td>
              <td><a href=${"#/task/" + t.id}>${t.title}</a>${t.fail_reason ? html`<span class="note FAIL">${t.fail_reason}</span>` : null}</td>
              <td><${Branch} b=${t.branch} /></td>
              <td class="mono num">${usd(d.taskUsd[t.id])}${costly.has(t.id) ? html`<span class="note FAIL">costly failure</span>` : null}</td>
              <td class="pr">${t.pr_url ? html`<a href=${t.pr_url} target="_blank">#${t.pr_number}</a>` : null}</td>
              <td class="end">${t.status === "waiting" ? html`<${EditModal} st=${st} t=${t} onSaved=${onSaved} />` : null}</td>
            </tr>`,
          )}</tbody>
        </table>`
      : html`<p class="muted">This stack has no tasks.</p>`}
  </section>`;
}

export function Stacks({ d }: { d: Data }) {
  const [list, setList] = useState<Json[] | null>(null);
  const [error, setError] = useState("");
  const [archived, setArchived] = useState(readArchived);
  const load = () => get("/api/stacks").then(setList, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);
  if (error) return html`<${Page} title="Stacks"><${Failure} text=${error} /><//>`;
  if (!list) return html`<${Page} title="Stacks"><${Loading} /><//>`;
  const costly = costlyFailures(list.flatMap((st) => st.tasks), d.taskUsd);
  const saved = async () => {
    await d.reload();
    await load();
  };
  const toggle = (id: string) => {
    const next = new Set(archived);
    next.has(id) ? next.delete(id) : next.add(id);
    try { localStorage.setItem(KEY, JSON.stringify([...next])); } catch {}
    setArchived(next);
  };
  const { shown, hidden } = splitStacks(list, archived);
  return html`<${Page} title="Stacks">
    ${shown.length ? null : html`<${Empty} text=${list.length ? "Every stack is archived." : "No stacks yet."} />`}
    ${shown.map((st) => html`<${StackPanel} st=${st} d=${d} costly=${costly} onSaved=${saved} action=${html`<button onClick=${() => toggle(st.id)} aria-label=${"Archive stack " + st.id.slice(0, 8)}>Archive</button>`} />`)}
    ${hidden.length
      ? html`<details><summary>Archived (${hidden.length})</summary>
          ${hidden.map((st) => html`<${StackPanel} st=${st} d=${d} costly=${costly} onSaved=${saved} action=${archived.has(st.id) ? html`<button onClick=${() => toggle(st.id)} aria-label=${"Restore stack " + st.id.slice(0, 8)}>Restore</button>` : null} />`)}
        </details>`
      : null}
  <//>`;
}
