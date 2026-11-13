import { html, useEffect, useState } from "./vendor/htm-preact.js";
import { get, State, TaskLink, taskOf, time, tok, type Data, type Json } from "./components.ts";

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
  if (error) return html`<p class="FAIL">${error}</p>`;
  const list = calls(events);
  const count = (k: string) => (k === "All" ? list.length : list.filter((c) => kindOf(c.tool) === k).length);
  const runs = new Map<string, number>();
  for (const c of list) if (c.tool === "Bash") runs.set(c.input.command, (runs.get(c.input.command) ?? 0) + 1);
  const repeats = [...runs].filter(([, n]) => n >= 3);
  const shown = list.filter((c) =>
    filter.cmd !== undefined ? c.tool === "Bash" && c.input.command === filter.cmd : filter.kind === "All" || kindOf(c.tool) === filter.kind,
  );
  const toggle = (k: string) => setOpen((o) => (o.has(k) ? (o.delete(k), new Set(o)) : new Set(o).add(k)));
  return html`<h2>Session <span class="mono muted">${id.slice(0, 8)}</span></h2>
    ${s
      ? html`<div class="card">
          <${State} s=${s.state} /> · ${s.repo} · <span class="mono">${s.branch}</span>
          ${taskOf(d, s) ? html` · task <${TaskLink} t=${taskOf(d, s)} />` : null}
          <br /><span class="muted">tokens in / out:</span> <span class="mono">${tok(s.usage) || "not yet"}</span>
          · <span class="muted">started</span> ${time(s.started_at)}
          ${s.ended_at ? html` · <span class="muted">ended</span> ${time(s.ended_at)}` : null}
        </div>`
      : null}
    ${repeats.map(
      ([cmd, n]) => html`<div class="card warnbox" role="alert">
        <b>Same command ran ${n} times</b> <code>${cmd}</code>
        <button class="plain" onClick=${() => setFilter({ kind: "Bash", cmd })}>Show the ${n} calls</button>
      </div>`,
    )}
    <div class="actions filters">
      ${KINDS.map(
        (k) => html`<button class="plain" aria-pressed=${filter.kind === k && filter.cmd === undefined} onClick=${() => setFilter({ kind: k })}>${k} (${count(k)})</button>`,
      )}
    </div>
    <table>
      <thead><tr><th>time</th><th>tool</th><th>summary</th><th class="num">duration</th></tr></thead>
      <tbody>
        ${shown.map(
          (c) => html`<tr class="click" aria-expanded=${open.has(c.key)} onClick=${() => toggle(c.key)}>
              <td class="muted">${time(c.at)}</td>
              <td><span class="badge">${c.tool}</span>${c.prove ? html` <span class="badge doing">Prove #${c.prove}</span>` : null}</td>
              <td class="mono">${summary(c)}</td>
              <td class=${"num mono" + (c.post ? "" : " running")}>${took(c)}</td>
            </tr>
            ${open.has(c.key)
              ? html`<tr><td colspan="4" class="panes">
                  <div><h3>Tool input</h3><pre>${pretty(c.input)}</pre></div>
                  <div><h3>Result</h3><pre>${c.post ? pretty(c.post.tool_response) : "running"}</pre></div>
                </td></tr>`
              : null}`,
        )}
      </tbody>
    </table>
    ${list.length ? null : html`<p class="muted">No tool calls yet.</p>`}`;
}
