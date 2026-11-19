import { html, useEffect, useState } from "./vendor/htm-preact.js";
import { Empty, Failure, get, Loading, Page, repoName, Seg, Stat, Stats, usd, type Data, type Json } from "./components.ts";
import { barRows } from "./select.ts";

const RANGES: [string, string][] = [["1d", "Day"], ["7d", "Week"], ["30d", "Month"], ["3650d", "All"]];

const Bars = ({ title, rows }: { title: string; rows: { name: string; label?: string; usd: number; pct: number }[] }) =>
  html`<h2>${title}</h2>
    ${rows.length
      ? html`<table aria-label=${title}><tbody>${rows.map(
          (r) => html`<tr><td title=${r.name}>${r.label ?? r.name}</td><td style="width:40%"><div class="bar"><i style=${"width:" + r.pct + "%"}></i></div></td><td class="num mono" style="white-space:nowrap">${usd(r.usd)}</td></tr>`,
        )}</tbody></table>`
      : html`<${Empty} text="No cost in this range." />`}`;

export function Usage({ d }: { d: Data }) {
  const [since, setSince] = useState("7d");
  const [r, setR] = useState<Json | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setR(null);
    get("/api/cost?since=" + since).then(setR, (e: Error) => setError(e.message));
  }, [since]);
  const sessions = [...d.sessions.values()];
  const tokens = sessions.reduce((n, s) => n + (s.usage ? s.usage.input + s.usage.cache_read + s.usage.cache_creation : 0), 0);
  const out = sessions.reduce((n, s) => n + (s.usage?.output ?? 0), 0);
  return html`<${Page} title="Usage" actions=${html`<${Seg} label="Range" value=${since} options=${RANGES} onPick=${setSince} />`}>
    ${error ? html`<${Failure} text=${error} />` : null}
    ${!r
      ? html`<${Loading} />`
      : html`<${Stats}>
            <${Stat} label="Total" value=${usd(r.total_usd) + " USD"} />
            <${Stat} label="Sessions" value=${usd(r.session_usd) + " USD"} />
            <${Stat} label="Test writer" value=${usd(r.writer_usd) + " USD"} />
            <${Stat} label="Unpriced sessions" value=${r.unpriced_sessions} />
          <//>
          <${Bars} title="By day" rows=${barRows(r.by_day, 14)} />
          <${Bars} title="By repository" rows=${barRows(r.by_repo).map((x) => ({ ...x, label: repoName(x.name) }))} />
          <${Bars} title="By task" rows=${barRows(Object.fromEntries(r.by_task.map((x: Json) => [x.title ?? x.task_id.slice(0, 8), x.usd])), 10)} />`}
    <h2>Tokens in the live feed</h2>
    <p class="muted">Input (with cache) <b class="mono">${tokens.toLocaleString()}</b> · output <b class="mono">${out.toLocaleString()}</b> · ${sessions.length} sessions.</p>
  <//>`;
}
