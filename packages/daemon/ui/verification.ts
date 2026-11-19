import { html } from "./vendor/htm-preact.js";
import { Chip, Empty, Page, Stat, Stats, time, type Data } from "./components.ts";

export function Verification({ d }: { d: Data }) {
  const rows = d.tasks.filter((t) => t.last_gate_at).sort((a, b) => b.last_gate_at.localeCompare(a.last_gate_at));
  const failed = rows.filter((t) => t.failed_claims.length);
  return html`<${Page} title="Verification">
    <${Stats}>
      <${Stat} label="Tasks with a gate" value=${rows.length} />
      <${Stat} label="Passing" value=${rows.length - failed.length} />
      <${Stat} label="Failing" value=${failed.length} tone=${failed.length ? "FAIL" : ""} />
    <//>
    <h2>Latest gate of each task</h2>
    ${rows.length
      ? html`<table>
          <thead><tr><th>Task</th><th>Result</th><th>Failed claims</th><th>Gate time</th><th></th></tr></thead>
          <tbody>${rows.map(
            (t) => html`<tr class="click" onClick=${(e: MouseEvent) => !(e.target as Element).closest("a") && (location.hash = "#/task/" + t.id + "/verification")}>
              <td><a href=${"#/task/" + t.id}>${t.title}</a></td>
              <td><${Chip} s=${t.failed_claims.length ? "FAIL" : "PASS"} /></td>
              <td class="mono">${t.failed_claims.join(", ")}</td>
              <td class="muted">${time(t.last_gate_at)}</td>
              <td class="num"><a href=${"#/task/" + t.id + "/verification"}>Evidence</a></td>
            </tr>`,
          )}</tbody>
        </table>`
      : html`<${Empty} text="No gate has run yet." />`}
  <//>`;
}
