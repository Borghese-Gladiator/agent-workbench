const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function page(home: string) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>awb</title>
<style>
:root{--bg:oklch(1 0 0);--fg:oklch(0.141 0.005 285.8);--card:oklch(0.985 0 0);--muted:oklch(0.552 0.016 285.9);
--border:oklch(0.92 0.004 286.3);--accent:oklch(0.5674 0.1585 275.2);--pass:oklch(0.55 0.15 150);--fail:oklch(0.577 0.245 27.3);--warn:oklch(0.6 0.15 70)}
@media (prefers-color-scheme:dark){:root{--bg:oklch(0.0692 0.008 284.1);--fg:oklch(0.9784 0.0011 197.1);--card:oklch(0.1723 0.0026 248);
--muted:oklch(0.65 0.01 286);--border:oklch(0.26 0.004 286);--pass:oklch(0.72 0.17 150);--fail:oklch(0.7 0.19 25);--warn:oklch(0.78 0.15 75)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
header{display:flex;gap:18px;align-items:center;padding:12px 20px;border-bottom:1px solid var(--border);flex-wrap:wrap}
header b{font-size:15px}header a{color:var(--muted);text-decoration:none}header a.on{color:var(--fg);font-weight:600}
#status{margin-left:auto;color:var(--muted);font-size:12px}main{padding:20px;max-width:1200px}
table{border-collapse:collapse;width:100%}td,th{padding:6px 10px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
th{color:var(--muted);font-weight:500;font-size:12px}tr.click{cursor:pointer}tr.click:hover{background:var(--card)}
a{color:var(--accent)}.muted{color:var(--muted)}.mono,pre,code{font-family:ui-monospace,Menlo,monospace;font-size:12px}
.busy,.doing{color:var(--warn);font-weight:600}.idle,.PASS,.done,.merged{color:var(--pass);font-weight:600}
.ended,.waiting,.closed{color:var(--muted)}.FAIL,.failed{color:var(--fail);font-weight:600}
.card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:14px 16px;margin:0 0 16px}
.claims{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(340px,1fr))}
video{width:100%;border-radius:6px;background:#000}pre{overflow:auto;background:var(--card);border:1px solid var(--border);border-radius:6px;padding:10px;max-height:480px}
details summary{cursor:pointer;margin:6px 0}textarea,input{width:100%;font:inherit;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:6px}
button{font:inherit;padding:5px 12px;border-radius:6px;border:1px solid var(--border);background:var(--accent);color:#fff;cursor:pointer}
.add{color:var(--pass)}.del{color:var(--fail)}h2{font-size:17px;margin:4px 0 12px}h3{font-size:14px;margin:0 0 8px}
</style>
<header><b>awb</b><a href="#/" data-v="live">Live</a><a href="#/stacks" data-v="stacks">Stacks</a>
<span class="muted mono">${esc(home)}</span><span id="status">connecting…</span></header>
<main id="app"></main>
<script>
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const tok = (u) => (u ? (u.input + u.cache_read + u.cache_creation).toLocaleString() + " / " + u.output.toLocaleString() : "");
const time = (t) => (t ? new Date(t).toLocaleString() : "");
const file = (p) => "/files?path=" + encodeURIComponent(p);
const get = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error((await r.json()).error); return r.headers.get("content-type").includes("json") ? r.json() : r.text(); };
const sessions = new Map();
let tasks = [];

const es = new EventSource("/api/feed");
es.addEventListener("snapshot", (e) => { sessions.clear(); for (const s of JSON.parse(e.data)) sessions.set(s.id, s); if (view() === "live") live(); });
es.addEventListener("session", (e) => { const s = JSON.parse(e.data); sessions.set(s.id, s); if (view() === "live") live(); if (location.hash === "#/session/" + s.id) session(s.id); });
es.onopen = () => ($("#status").textContent = "live");
es.onerror = () => ($("#status").textContent = "disconnected, retrying…");

const view = () => (location.hash.split("/")[1] || "live");
const taskOf = (s) => tasks.find((t) => t.repo === s.repo && t.branch === s.branch);

function live() {
  const list = [...sessions.values()].sort((a, b) => b.started_at.localeCompare(a.started_at));
  $("#app").innerHTML = "<h2>Live</h2><table><thead><tr><th>state</th><th>repo</th><th>branch</th><th>task</th><th>last tool</th><th>last event</th><th>tokens in / out</th><th>started</th></tr></thead><tbody>" +
    list.map((s) => { const t = taskOf(s); return "<tr class='click' data-href='#/session/" + esc(s.id) + "'><td class='" + s.state + "'>" + s.state + "</td><td>" + esc(s.repo.split("/").at(-1)) +
      "</td><td class='mono'>" + esc(s.branch) + "</td><td>" + (t ? "<a href='#/task/" + t.id + "'>" + esc(t.title) + "</a>" : "") + "</td><td>" + esc(s.last_tool) +
      "</td><td>" + esc(s.last_hook) + " <span class='muted'>" + time(s.last_event_at) + "</span></td><td class='mono'>" + tok(s.usage) + "</td><td class='muted'>" + time(s.started_at) + "</td></tr>"; }).join("") +
    "</tbody></table>" + (list.length ? "" : "<p class='muted'>No sessions yet. Run <code>awb</code> in a repo.</p>");
}

async function session(id) {
  const s = sessions.get(id);
  const events = await get("/api/sessions/" + id + "/events");
  const t = s && taskOf(s);
  $("#app").innerHTML = "<h2>Session <span class='mono muted'>" + esc(id.slice(0, 8)) + "</span></h2>" +
    (s ? "<div class='card'><span class='" + s.state + "'>" + s.state + "</span> · " + esc(s.repo) + " · <span class='mono'>" + esc(s.branch) + "</span>" +
      (t ? " · task <a href='#/task/" + t.id + "'>" + esc(t.title) + "</a>" : "") + "<br><span class='muted'>tokens in / out:</span> <span class='mono'>" + (tok(s.usage) || "not yet") +
      "</span> · <span class='muted'>started</span> " + time(s.started_at) + (s.ended_at ? " · <span class='muted'>ended</span> " + time(s.ended_at) : "") + "</div>" : "") +
    "<table><thead><tr><th>time</th><th>hook</th><th>tool</th><th>detail</th></tr></thead><tbody>" +
    events.map((e) => { const p = JSON.parse(e.payload); const d = p.tool_input?.command ?? p.tool_input?.file_path ?? p.prompt ?? "";
      return "<tr><td class='muted'>" + time(e.at) + "</td><td>" + esc(e.hook) + "</td><td>" + esc(e.tool_name) + "</td><td class='mono'>" + esc(String(d).slice(0, 200)) + "</td></tr>"; }).join("") +
    "</tbody></table>";
}

async function stacksView() {
  const list = await get("/api/stacks");
  $("#app").innerHTML = "<h2>Stacks</h2>" + (list.length ? "" : "<p class='muted'>No stacks yet.</p>") + list.map((st) =>
    "<div class='card'><h3>" + esc(st.repo.split("/").at(-1)) + " <span class='muted mono'>stack " + esc(st.id.slice(0, 8)) + " · version " + st.version + " · base " + esc(st.base) + "</span></h3>" +
    "<table><thead><tr><th>#</th><th>status</th><th>task</th><th>branch</th><th>PR</th><th></th></tr></thead><tbody>" +
    st.tasks.map((t, i) => "<tr><td>" + (i + 1) + "</td><td class='" + t.status + "'>" + t.status + "</td><td><a href='#/task/" + t.id + "'>" + esc(t.title) + "</a>" +
      (t.fail_reason ? "<div class='muted'>" + esc(t.fail_reason) + "</div>" : "") + "</td><td class='mono'>" + esc(t.branch) + "</td><td>" +
      (t.pr_url ? "<a href='" + esc(t.pr_url) + "'>#" + t.pr_number + "</a>" : "") + "</td><td>" +
      (t.status === "waiting" ? "<details><summary>edit</summary><form data-stack='" + st.id + "' data-version='" + st.version + "' data-task='" + t.id + "'>" +
        "<label>Title<input name='title' value='" + esc(t.title) + "'></label><label>Claims, one a line: <code>C1: text</code><textarea name='claims' rows='4'>" +
        esc(t.claims.map((c) => c.id + ": " + c.text).join("\\n")) + "</textarea></label><button>Save</button> <span class='msg muted'></span></form></details>" : "") +
      "</td></tr>").join("") + "</tbody></table></div>").join("");
  for (const f of document.querySelectorAll("form[data-stack]")) f.onsubmit = (e) => { e.preventDefault(); saveTask(f, list.find((s) => s.id === f.dataset.stack)); };
}

async function saveTask(f, st) {
  const claims = f.claims.value.split("\\n").map((l) => l.match(/^\\s*(C\\d+)\\s*:\\s*(.+)$/)).filter(Boolean).map((m) => ({ id: m[1], text: m[2] }));
  const body = { stackId: st.id, version: Number(f.dataset.version), repo: st.repo, branch: st.tasks[0].branch, base: st.base,
    tasks: st.tasks.map((t) => t.id === f.dataset.task ? { id: t.id, title: f.title.value, claims } : { id: t.id, title: t.title, claims: t.claims }) };
  const r = await fetch("/api/stacks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) return (f.querySelector(".msg").textContent = j.error);
  await loadTasks();
  stacksView();
}

async function proof(id) {
  const [t, diff] = await Promise.all([get("/api/tasks/" + id), get("/api/tasks/" + id + "/diff").catch(() => "")]);
  const gates = t.attempts.flatMap((a) => a.gates);
  const g = gates.at(-1);
  const rows = g ? g.result.rows : [];
  const claimCards = t.claims.map((c) => { const r = rows.find((x) => x.id === c.id);
    return "<div class='card'><h3>" + esc(c.id) + " <span class='" + (r?.status ?? "waiting") + "'>" + (r?.status ?? "not run") + "</span></h3><p>" + esc(c.text) + "</p>" +
      (r?.reasons.length ? "<p class='FAIL'>" + esc(r.reasons.join(", ")) + "</p>" : "") +
      (r?.videos ?? []).map((v) => "<video controls preload='metadata' src='" + file(v) + "'></video>").join("") +
      (r?.traces ?? []).map((tr) => "<p><a href='" + file(tr) + "' download>trace.zip</a> <span class='muted'>· open with</span> <code>npx playwright show-trace " + esc(tr) + "</code></p>").join("") + "</div>"; }).join("");
  const diffHtml = diff.split("\\n").map((l) => "<span class='" + (l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : "") + "'>" + esc(l) + "</span>").join("\\n");
  $("#app").innerHTML = "<h2>" + esc(t.title) + " <span class='" + t.status + "'>" + t.status + "</span></h2>" +
    "<div class='card'><span class='mono'>" + esc(t.branch) + "</span> → <span class='mono'>" + esc(t.base) + "</span>" +
    (t.pr_url ? " · <a href='" + esc(t.pr_url) + "'>PR #" + t.pr_number + "</a>" : " · no PR yet") +
    (g ? " · gate <span class='" + (g.pass ? "PASS" : "FAIL") + "'>" + (g.pass ? "PASS" : "FAIL") + "</span> at <span class='mono'>" + esc(g.commit_sha.slice(0, 10)) + "</span>" : " · no gate run") +
    " · cost " + t.cost_usd.toFixed(2) + " USD · " + t.attempts.length + " attempt(s)" +
    (t.fail_reason ? "<p class='FAIL'>" + esc(t.fail_reason) + "</p>" : "") + "</div>" +
    "<div class='claims'>" + claimCards + "</div>" +
    "<details><summary>Attempts (" + t.attempts.length + ")</summary><table><tbody>" + t.attempts.map((a) => "<tr><td class='muted'>" + time(a.started_at) + "</td><td>" +
      a.gates.map((x) => "<span class='" + (x.pass ? "PASS" : "FAIL") + "'>" + (x.pass ? "PASS" : "FAIL") + "</span> <span class='mono'>" + esc(x.commit_sha.slice(0, 10)) + "</span> " +
        x.result.rows.map((r) => r.id + "=" + r.status).join(" ")).join("<br>") + "</td></tr>").join("") + "</tbody></table></details>" +
    "<details" + (t.specs.length ? " open" : "") + "><summary>Proof tests (" + t.specs.length + ")</summary>" + t.specs.map((s) => "<h3 class='mono'>" + esc(s.name) + "</h3><pre>" + esc(s.text) + "</pre>").join("") + "</details>" +
    "<details open><summary>Diff</summary><pre id='diff'>" + (diff ? diffHtml : "<span class='muted'>no diff</span>") + "</pre></details>" +
    (t.transcripts.length ? "<details><summary>Transcripts</summary>" + t.transcripts.map((f) => "<div class='mono'>" + esc(f) + "</div>").join("") + "</details>" : "");
}

async function loadTasks() {
  try { tasks = await get("/api/tasks"); } catch {}
}

async function route() {
  for (const a of document.querySelectorAll("header a[data-v]")) a.classList.toggle("on", a.dataset.v === view());
  const [, v, id] = location.hash.split("/");
  await loadTasks();
  try {
    if (v === "session") await session(id);
    else if (v === "stacks") await stacksView();
    else if (v === "task") await proof(id);
    else live();
  } catch (err) {
    $("#app").innerHTML = "<p class='FAIL'>" + esc(err.message) + "</p>";
  }
}
document.addEventListener("click", (e) => { const tr = e.target.closest("tr[data-href]"); if (tr && !e.target.closest("a")) location.hash = tr.dataset.href; });
window.addEventListener("hashchange", route);
route();
</script></html>`;
}
