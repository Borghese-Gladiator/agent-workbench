import { html, useEffect, useState } from "./vendor/htm-preact.js";
import { ago, Branch, Chip, Empty, Failure, file, get, Id, Loading, LogEntry, LogLine, Page, Pass, post, Stat, Stats, time, usd, type Data, type Json } from "./components.ts";
import { lastGate } from "./select.ts";

type Msg = [string, boolean];

function Buttons({ t, setMsg, reload }: { t: Json; setMsg: (m: Msg) => void; reload: () => void }) {
  const fail = (err: unknown) => setMsg([(err as Error).message, true]);
  const retry = async () => {
    try {
      await post("/api/retry", { taskId: t.id });
      setMsg(["Retried. The run starts again.", false]);
      setTimeout(reload, 800);
    } catch (err) {
      fail(err);
    }
  };
  const drop = async () => {
    if (!confirm("Drop the task " + t.title + "? Its attempts and gate results are removed.")) return;
    try {
      await post("/api/tasks/rm", { ids: [t.id] });
      location.hash = "#/stacks";
    } catch (err) {
      fail(err);
    }
  };
  return html`<button class="primary" onClick=${retry}>Retry</button><button class="danger" onClick=${drop}>Drop</button>`;
}

function Rewrite({ t, setMsg }: { t: Json; setMsg: (m: Msg) => void }) {
  const [out, setOut] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rewrite = async (e: Event) => {
    e.preventDefault();
    const ids = [...(e.target as HTMLFormElement).querySelectorAll<HTMLInputElement>("input[name=claim]:checked")].map((x) => x.value);
    if (!ids.length) return setMsg(["Select one or more claims to rewrite.", true]);
    setBusy(true);
    let text = "";
    setOut(text);
    const r = await fetch("/api/prove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: t.stack.repo, branch: t.branch, worktree: t.worktree, rewrite: ids }),
    });
    if (!r.ok || !r.body) {
      setOut((await r.json()).error);
      return setBusy(false);
    }
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        text += (m.log ?? m.error ?? (m.result ? (m.result.pass ? "PASS" : "FAIL") + "\n" + m.result.table : "")) + "\n";
        setOut(text);
      }
    }
    setBusy(false);
  };
  return html`<section class="panel">
    <h3>Rewrite proof tests</h3>
    <p class="muted">Remove the test of a claim and write it again. The proof then runs.</p>
    <form onSubmit=${rewrite}>
      <div class="toolbar">
        ${t.claims.map(
          (c: Json) => html`<label class="box"><input type="checkbox" name="claim" value=${c.id} checked=${t.failed_claims.includes(c.id)} />${c.id}</label>`,
        )}
        <button disabled=${!t.worktree || busy}>Rewrite test</button>
      </div>
      ${t.worktree ? null : html`<p class="muted">This task has no worktree, so the proof cannot run from here.</p>`}
      ${out === null ? null : html`<pre class="wrap" aria-label="Rewrite output">${out}</pre>`}
    </form>
  </section>`;
}

function ClaimRow({ c, r }: { c: Json; r?: Json }) {
  const status = r?.status ?? "waiting";
  return html`<details class="ev claim"><summary style="grid-template-columns: 56px 90px 1fr">
      <b class="mono">${c.id}</b><${Chip} s=${status} label=${r ? undefined : "Not run"} /><span>${c.text}${r?.reasons.length ? html`<span class="note FAIL">${r.reasons.join(", ")}</span>` : null}</span></summary>
    <div style="padding: 4px 4px 12px">
      ${(r?.videos ?? []).map((v: string) => html`<video controls preload="metadata" src=${file(v)}></video>`)}
      ${(r?.traces ?? []).map(
        (tr: string) => html`<p><a href=${file(tr)} download>Download trace.zip</a> <span class="muted">· open with</span> <code>npx playwright show-trace ${tr}</code></p>`,
      )}
      ${r?.videos.length || r?.traces.length ? null : html`<p class="muted">No video or trace for this claim.</p>`}
    </div></details>`;
}

function Gates({ t }: { t: Json }) {
  const gates = t.attempts.flatMap((a: Json, i: number) => a.gates.map((x: Json) => ({ i, x })));
  if (!gates.length) return html`<${Empty} text="No gate has run for this task." />`;
  return gates.map(
    ({ i, x }: Json, n: number) => html`<details open=${n === gates.length - 1} aria-label=${"Attempt " + (i + 1) + " gate"}>
      <summary>Attempt ${i + 1} · ${x.pass ? "passed" : "failed"} · <span class="mono">${x.commit_sha.slice(0, 10)}</span></summary>
      <table><thead><tr><th>Claim</th><th>Result</th><th class="num">Tests</th><th>Evidence</th></tr></thead><tbody>
        ${x.result.rows.map(
          (r: Json) => html`<tr><td class="mono">${r.id}</td><td><${Pass} pass=${r.status === "PASS"} />${r.reasons.length ? html`<span class="note FAIL">${r.reasons.join(", ")}</span>` : null}</td>
            <td class="num">${r.tests}</td>
            <td>${r.videos.length} video, ${r.traces.length} trace${r.videos.map((v: string) => html` <a href=${file(v)} target="_blank">video</a>`)}${r.traces.map((tr: string) => html` <a href=${file(tr)} download>trace</a>`)}</td></tr>`,
        )}
      </tbody></table></details>`,
  );
}

const Diff = ({ diff }: { diff: string }) =>
  diff.split("\n").map((l) => {
    const cls = l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : "";
    return html`<span class=${cls}>${l}</span>${"\n"}`;
  });

const splitDiff = (diff: string) =>
  diff
    .split(/^(?=diff --git )/m)
    .filter((p) => p.startsWith("diff --git "))
    .map((text) => {
      const lines = text.split("\n");
      return {
        name: text.match(/^diff --git a\/.* b\/(.*)$/m)?.[1] ?? "",
        text,
        add: lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length,
        del: lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length,
      };
    });

function ChangedFiles({ diff }: { diff: string }) {
  const [pick, setPick] = useState<string | null>(null);
  const files = splitDiff(diff);
  const shown = files.find((f) => f.name === pick);
  return html`<h2>Changed files (${files.length})</h2>
    ${files.length
      ? html`<table><tbody>${files.map(
          (f) => html`<tr class="click" onClick=${() => setPick(f.name === pick ? null : f.name)}><td><span class="mono">${f.name}</span></td>
            <td class="num add">+${f.add}</td><td class="num del">-${f.del}</td></tr>`,
        )}</tbody></table>`
      : null}
    ${shown ? html`<p><button onClick=${() => setPick(null)}>Show all files</button></p>` : null}
    <pre id="diff">${diff ? html`<${Diff} diff=${shown ? shown.text : diff} />` : html`<span class="muted">no diff</span>`}</pre>`;
}

const TABS: [string, string][] = [["overview", "Overview"], ["attempts", "Attempts"], ["verification", "Verification"], ["changes", "Changes"], ["logs", "Logs"]];

export function TaskView({ d, id, tab }: { d: Data; id: string; tab: string }) {
  const [data, setData] = useState<{ t: Json; diff: string; setupLog: string; grafana: string | null } | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState<Msg>(["", false]);
  const load = async () => {
    try {
      const [t, diff, health] = await Promise.all([get("/api/tasks/" + id), get("/api/tasks/" + id + "/diff").catch(() => ""), get("/health").catch(() => ({}))]);
      const setupLog = await get(file(t.folder + "/setup.log")).catch(() => "");
      setData({ t, diff, setupLog, grafana: health.grafana ?? null });
    } catch (err) {
      setError((err as Error).message);
    }
  };
  useEffect(() => void load(), [id]);
  if (error) return html`<${Page} title="Task" crumbs=${[["Tasks", "#/tasks"], ["Not found"]]}><${Failure} text=${error} /><//>`;
  if (!data) return html`<${Loading} />`;
  const { diff, setupLog, grafana } = data;
  const t: Json = { ...data.t, failed_claims: d.tasks.find((x) => x.id === data.t.id)?.failed_claims ?? [] };
  const writer = t.transcripts.find((f: string) => f.endsWith("writer.jsonl"));
  const g = lastGate(t);
  const rows: Json[] = g ? g.result.rows : [];
  const passed = rows.filter((r) => r.status === "PASS").length;
  const errors = t.log.filter((l: Json) => l.level === "error").length;
  const failedIds = rows.filter((r) => r.status === "FAIL").map((r) => r.id);
  const from = t.attempts[0]?.started_at ?? t.created_at;
  const to = t.attempts.at(-1)?.ended_at ?? null;
  const cur = TABS.some(([k]) => k === tab) ? tab : "overview";

  const overview = html`<section class="panel">
      <p><${Branch} b=${t.branch} /> <span class="muted">into</span> <${Branch} b=${t.base} /></p>
      <p>${t.pr_url ? html`<a href=${t.pr_url} target="_blank">Open draft PR #${t.pr_number}</a>` : html`<span class="muted">No PR yet.</span>`}
        ${g ? html` <span class="muted">· last gate</span> <${Pass} pass=${g.pass} />` : html` <span class="muted">· no gate has run</span>`}</p>
      ${t.writer_end ? html`<p class="muted">Test writer ended: <span class=${t.writer_end.startsWith("success") ? "PASS" : "FAIL"}>${t.writer_end}</span></p>` : null}
    </section>
    <h2>Claims</h2>
    ${t.claims.map((c: Json) => html`<${ClaimRow} c=${c} r=${rows.find((x) => x.id === c.id)} />`)}
    <details><summary>Proof tests (${t.specs.length})</summary>
      ${t.specs.map((s: Json) => html`<h3 class="mono">${s.name}</h3><pre>${s.text}</pre>`)}</details>
    <details><summary>Technical details</summary>
      <dl class="kv" style="padding-left:4px"><dt>Task id</dt><dd>${t.id}</dd><dt>Folder</dt><dd>${t.folder}</dd><dt>Worktree</dt><dd>${t.worktree ?? "none"}</dd><dt>Tool calls</dt><dd>${t.tool_calls}</dd></dl>
      ${t.transcripts.map((f: string) => html`<div class="mono"><a href=${file(f)} target="_blank">${f}</a></div>`)}
    </details>`;

  const attempts = t.attempts.length
    ? html`<table><thead><tr><th>#</th><th>Started</th><th>Duration</th><th>Gate</th></tr></thead><tbody>${t.attempts.map(
        (a: Json, i: number) => html`<tr><td class="muted">${i + 1}</td><td>${time(a.started_at)}</td><td class="muted">${a.ended_at ? ago(a.started_at, a.ended_at) : "running"}</td>
          <td>${a.gates.length ? a.gates.map((x: Json) => html`<div><${Pass} pass=${x.pass} /> <span class="mono muted">${x.commit_sha.slice(0, 10)}</span> <span class="muted">${x.result.rows.map((r: Json) => r.id + " " + r.status.toLowerCase()).join(", ")}</span></div>`) : html`<span class="muted">no gate</span>`}</td></tr>`,
      )}</tbody></table>`
    : html`<${Empty} text="No attempt has run." />`;

  const verification = html`${t.status === "failed" ? html`<${Rewrite} t=${t} setMsg=${setMsg} />` : null}
    <h2>Gate history</h2><${Gates} t=${t} />`;

  const logs = html`<p class="muted">${t.log.length} lines · ${errors} ${errors === 1 ? "error" : "errors"}</p>
    ${t.log.length ? html`<div class="events">${t.log.map((l: Json) => html`<${LogEntry} l=${l} />`)}</div>` : html`<${Empty} text="No log lines for this task." />`}
    <details><summary>Raw log</summary><pre class="wrap">${t.log.map((l: Json) => html`<${LogLine} l=${l} />`)}</pre></details>
    ${setupLog ? html`<details><summary>Setup log</summary><pre class="wrap">${setupLog}</pre></details>` : null}
    ${writer ? html`<p><a href=${file(writer)} target="_blank">Test writer log</a></p>` : null}
    <p><a href=${"#/logs/" + t.id}>All logs of this task</a>${grafana ? html` · <a href=${grafana.replace(/\/$/, "") + "/d/awb/awb?var-task=" + encodeURIComponent(t.id)} target="_blank">Open in Grafana</a>` : null}</p>`;

  return html`<${Page} crumbs=${[["Tasks", "#/tasks"], [t.title]]} title=${html`${t.title} <${Chip} s=${t.status} />`}
      actions=${t.status === "failed" ? html`<${Buttons} t=${t} setMsg=${setMsg} reload=${load} />` : null}>
    ${t.status === "failed" && t.fail_reason
      ? html`<div class="callout" role="alert"><b>${t.fail_reason}</b>
          <span class="note">${failedIds.length ? "Failed claims: " + failedIds.join(", ") + ". " : ""}Retry the task, or rewrite the proof tests in Verification.</span></div>`
      : null}
    ${msg[0] ? html`<p class=${msg[1] ? "FAIL" : "muted"} role="status">${msg[0]}</p>` : null}
    <${Stats}>
      <${Stat} label="Attempts" value=${t.attempts.length} />
      <${Stat} label="Claims passed" value=${rows.length ? passed + " / " + rows.length : "none"} tone=${rows.length && passed < rows.length ? "FAIL" : ""} />
      <${Stat} label="Cost" value=${usd(t.cost_usd) + " USD"} />
      <${Stat} label="Time" value=${ago(from, to)} />
    <//>
    <div class="tabs" role="tablist" aria-label="Task sections">
      ${TABS.map(([k, label]) => html`<button role="tab" aria-selected=${cur === k} onClick=${() => (location.hash = "#/task/" + id + "/" + k)}>${label}</button>`)}
    </div>
    ${cur === "attempts" ? attempts : cur === "verification" ? verification : cur === "changes" ? html`<${ChangedFiles} diff=${diff} />` : cur === "logs" ? logs : overview}
  <//>`;
}
