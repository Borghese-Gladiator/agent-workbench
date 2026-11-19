import { html, useEffect, useState } from "./vendor/htm-preact.js";
import { ago, Chip, Empty, Failure, get, Page, post, time, type Json } from "./components.ts";

export function Schedule() {
  const [s, setS] = useState<Json | null>(null);
  const [runs, setRuns] = useState<Json[]>([]);
  const [open, setOpen] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState("");

  const load = async () => {
    try {
      const [status, list] = await Promise.all([get("/api/schedule"), get("/api/schedule/runs?limit=50")]);
      setS(status);
      setRuns(list);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  useEffect(() => {
    void load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  const runNow = async (name: string) => {
    setError("");
    try {
      await post("/api/schedule/run", { name });
    } catch (err) {
      setError((err as Error).message);
    }
    await load();
  };
  const view = async (id: string) => {
    if (open === id) return setOpen("");
    setOpen(id);
    try {
      setText(await get(`/api/schedule/runs/${id}/output`));
    } catch (err) {
      setText((err as Error).message);
    }
  };

  return html`<${Page} title="Schedule">
    <p class="muted">The daemon reads <span class="mono">${s?.file ?? "schedule.json"}</span> and starts each job once a day.</p>
    ${s?.error ? html`<${Failure} text=${"The file is not valid: " + s.error} />` : null}
    ${error ? html`<${Failure} text=${error} />` : null}
    ${s && !s.jobs.length && !s.error ? html`<${Empty} text="No jobs." />` : null}
    ${s?.jobs.length
      ? html`<table>
          <thead><tr><th>Job</th><th>At</th><th>State</th><th>Next</th><th>Last run</th><th></th></tr></thead>
          <tbody>
            ${s.jobs.map(
              (j: Json) => html`<tr>
                <td class="mono">${j.name}</td>
                <td class="mono">${j.at}</td>
                <td>${j.running ? html`<${Chip} s="running" />` : html`<span class="muted">idle</span>`}</td>
                <td>${time(j.next)}</td>
                <td>${j.last ? html`<${Chip} s=${j.last.state} /> <span class="muted">${time(j.last.started_at)} ${j.last.end ?? ""}</span>` : html`<span class="muted">never ran</span>`}</td>
                <td class="num"><button disabled=${j.running} onClick=${() => runNow(j.name)}>Run now</button></td>
              </tr>`,
            )}
          </tbody>
        </table>`
      : null}
    <h2>History</h2>
    ${runs.length
      ? html`<table>
          <thead><tr><th>Job</th><th>State</th><th>Started</th><th>Took</th><th>Result</th><th></th></tr></thead>
          <tbody>
            ${runs.map(
              (r) => html`<tr>
                <td class="mono">${r.job}</td>
                <td><${Chip} s=${r.state} /></td>
                <td>${time(r.started_at)}</td>
                <td>${r.ended_at ? ago(r.started_at, r.ended_at) : ""}</td>
                <td class="muted">${r.end ?? ""}</td>
                <td class="num">${r.output ? html`<button aria-expanded=${open === r.id} onClick=${() => view(r.id)}>Output</button>` : null}</td>
              </tr>
              ${open === r.id ? html`<tr><td colspan="6"><pre class="wrap" aria-label="Job output">${text}</pre></td></tr>` : null}`,
            )}
          </tbody>
        </table>`
      : html`<${Empty} text="No job has run yet." />`}
  <//>`;
}
