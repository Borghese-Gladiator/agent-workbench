import { html, useEffect, useState } from "./vendor/htm-preact.js";
import { Branch, Chip, Empty, Failure, get, Id, Page, Seg, TaskLink, taskOf, time, tok, type Data, type Json } from "./components.ts";

type Call = { key: string; at: string; tool: string; input: Json; pre?: Json; post?: Json; done?: string; prove?: number };

const KINDS = ["All", "Bash", "Edit", "Read", "MCP"];
const kindOf = (tool: string) => (tool.startsWith("mcp__") ? "MCP" : tool);
const summary = (c: Call) => String(c.input.command ?? c.input.file_path ?? c.input.pattern ?? JSON.stringify(c.input)).slice(0, 200);

export function calls(events: Json[]): Call[] {
  const out: Call[] = [];
  const byId = new Map<string, Call>();
  for (const e of events) {
    if (!e.tool_name || (e.hook !== "PreToolUse" && !e.hook.startsWith("PostToolUse"))) continue;
    const p = JSON.parse(e.payload);
    const id = p.tool_use_id;
    let c = id ? byId.get(id) : undefined;
    if (!c) {
      c = { key: id ?? "e" + e.id, at: e.at, tool: e.tool_name, input: p.tool_input ?? {} };
      out.push(c);
      if (id) byId.set(id, c);
    }
    if (e.hook === "PreToolUse") c.pre = p;
    else (c.post = p), (c.done = e.at);
  }
  let n = 0;
  for (const c of out) if (c.tool === "Bash" && String(c.input.command ?? "").startsWith("awb prove")) c.prove = ++n;
  return out;
}

const took = (c: Call) => (c.post && c.pre ? ((Date.parse(c.done!) - Date.parse(c.at)) / 1000).toFixed(1) + "s" : c.post ? "" : "running");
const pretty = (v: unknown) => JSON.stringify(v ?? null, null, 2);

export function SessionView({ d, id }: { d: Data; id: string }) {
  const s = d.sessions.get(id);
  const [events, setEvents] = useState<Json[]>([]);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<{ kind: string; cmd?: string }>({ kind: "All" });
  const [open, setOpen] = useState(new Set<string>());
  useEffect(() => {
    get("/api/sessions/" + id + "/events").then(setEvents, (e: Error) => setError(e.message));
  }, [id, s]);
  if (error) return html`<${Page} title="Session" crumbs=${[["Runs", "#/runs"], ["Not found"]]}><${Failure} text=${error} /><//>`;
  const list = calls(events);
  const count = (k: string) => (k === "All" ? list.length : list.filter((c) => kindOf(c.tool) === k).length);
  const runs = new Map<string, number>();
  for (const c of list) if (c.tool === "Bash") runs.set(c.input.command, (runs.get(c.input.command) ?? 0) + 1);
  const repeats = [...runs].filter(([, n]) => n >= 3);
  const shown = list.filter((c) =>
    filter.cmd !== undefined ? c.tool === "Bash" && c.input.command === filter.cmd : filter.kind === "All" || kindOf(c.tool) === filter.kind,
  );
  const toggle = (k: string) => setOpen((o) => (o.has(k) ? (o.delete(k), new Set(o)) : new Set(o).add(k)));
  const options: [string, string][] = KINDS.map((k) => [k, k + " (" + count(k) + ")"]);
  return html`<${Page} crumbs=${[["Runs", "#/runs"], ["Session"]]} title=${html`Session <${Id} v=${id} />`}>
    ${s
      ? html`<section class="panel">
          <${Chip} s=${s.state} /> <span class="muted">· ${s.repo} ·</span> <${Branch} b=${s.branch} />
          ${taskOf(d, s) ? html` <span class="muted">· task</span> <${TaskLink} t=${taskOf(d, s)} />` : null}
          <p class="muted">Tokens in / out <span class="mono">${tok(s.usage) || "not yet"}</span> · started ${time(s.started_at)}${s.ended_at ? " · ended " + time(s.ended_at) : ""}</p>
        </section>`
      : null}
    ${repeats.map(
      ([cmd, n]) => html`<div class="callout warn" role="alert">
        <b>Same command ran ${n} times</b> <code>${cmd}</code>
        <p><button onClick=${() => setFilter({ kind: "Bash", cmd })}>Show the ${n} calls</button></p>
      </div>`,
    )}
    <div class="toolbar"><${Seg} label="Tool kind" value=${filter.cmd !== undefined ? "" : filter.kind} options=${options} onPick=${(k: string) => setFilter({ kind: k })} /></div>
    ${list.length
      ? html`<table>
          <thead><tr><th>Time</th><th>Tool</th><th>Summary</th><th class="num">Duration</th></tr></thead>
          <tbody>
            ${shown.map(
              (c) => html`<tr class="click" aria-expanded=${open.has(c.key)} onClick=${() => toggle(c.key)}>
                  <td class="muted">${time(c.at)}</td>
                  <td><b>${c.tool}</b>${c.prove ? html` <${Chip} s="doing" label=${"Prove #" + c.prove} />` : null}</td>
                  <td class="mono">${summary(c)}</td>
                  <td class=${"num mono" + (c.post ? "" : " muted")}>${took(c)}</td>
                </tr>
                ${open.has(c.key)
                  ? html`<tr><td colspan="4"><div class="panes">
                      <div><h3>Tool input</h3><pre class="wrap">${pretty(c.input)}</pre></div>
                      <div><h3>Result</h3><pre class="wrap">${c.post ? pretty(c.post.tool_response) : "running"}</pre></div>
                    </div></td></tr>`
                  : null}`,
            )}
          </tbody>
        </table>`
      : html`<${Empty} text="No tool calls yet." />`}
  <//>`;
}
