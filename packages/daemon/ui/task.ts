import { html, useEffect, useState } from "./vendor/htm-preact.js";
import { ago, Branch, file, get, LogLine, Pass, post, State, time, usd, type Data, type Json } from "./components.ts";

function Buttons({ t, setMsg, reload }: { t: Json; setMsg: (m: [string, boolean]) => void; reload: () => void }) {
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
  return html`<button onClick=${retry}>Retry</button> <button class="danger" onClick=${drop}>Drop</button>`;
}

function Rewrite({ t, msg, setMsg }: { t: Json; msg: [string, boolean]; setMsg: (m: [string, boolean]) => void }) {
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
  return html`<div class="card">
    <h3>Rewrite proof tests</h3>
    ${msg[0] ? html`<p class=${msg[1] ? "FAIL" : "muted"}>${msg[0]}</p>` : null}
    <form onSubmit=${rewrite}>
      <div>
        ${t.claims.map(
          (c: Json) => html`<label class="box"><input type="checkbox" name="claim" value=${c.id} checked=${t.failed_claims.includes(c.id)} />${c.id}</label>`,
        )}
        <button class="plain" disabled=${!t.worktree || busy}>Rewrite test</button>
      </div>
      ${t.worktree ? null : html`<p class="muted">This task has no worktree, so the proof cannot run from here.</p>`}
      ${out === null ? null : html`<pre aria-label="Rewrite output">${out}</pre>`}
    </form>
  </div>`;
}

function ClaimCard({ c, r }: { c: Json; r?: Json }) {
  return html`<div class="card">
    <h3>${c.id} <span class=${"badge " + (r?.status ?? "waiting")}>${r?.status ?? "not run"}</span></h3>
    <p>${c.text}</p>
    ${r?.reasons.length ? html`<p class="FAIL">${r.reasons.join(", ")}</p>` : null}
    ${(r?.videos ?? []).map((v: string) => html`<video controls preload="metadata" src=${file(v)}></video>`)}
    ${(r?.traces ?? []).map(
      (tr: string) => html`<p><a href=${file(tr)} download>trace.zip</a> <span class="muted">· open with</span> <code>npx playwright show-trace ${tr}</code></p>`,
    )}
  </div>`;
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
  return html`<details open>
    <summary>Changed files (${files.length})</summary>
    ${files.length
      ? html`<table><tbody>${files.map(
          (f) => html`<tr><td><button class="plain mono" aria-pressed=${f.name === pick} onClick=${() => setPick(f.name)}>${f.name}</button></td>
            <td class="num add">+${f.add}</td><td class="num del">-${f.del}</td></tr>`,
        )}</tbody></table>`
      : null}
    ${shown ? html`<p><button class="plain" onClick=${() => setPick(null)}>Show all files</button></p>` : null}
    <pre id="diff">${diff ? html`<${Diff} diff=${shown ? shown.text : diff} />` : html`<span class="muted">no diff</span>`}</pre>
  </details>`;
}

function Shipped({ t }: { t: Json }) {
  const from = t.attempts[0]?.started_at ?? t.created_at;
  const to = t.attempts.at(-1)?.ended_at ?? null;
  return html`<div class="card">
    <h3><span class="badge PASS">Shipped</span> <a href=${t.pr_url} target="_blank">Open draft PR #${t.pr_number}</a></h3>
    <div class="stats">
      <div><span class="muted">Total time</span><b>${ago(from, to)}</b></div>
      <div><span class="muted">Tool calls</span><b>${t.tool_calls}</b></div>
      <div><span class="muted">Cost</span><b>${usd(t.cost_usd)} USD</b></div>
    </div>
  </div>`;
}

export function TaskView({ d, id }: { d: Data; id: string }) {
  const [data, setData] = useState<{ t: Json; diff: string; setupLog: string; grafana: string | null } | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState<[string, boolean]>(["", false]);
  const [tab, setTab] = useState("overview");
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
  if (error) return html`<p class="FAIL">${error}</p>`;
  if (!data) return html`<p class="muted">Loading…</p>`;
  const { diff, setupLog, grafana } = data;
  const t: Json = { ...data.t, failed_claims: d.tasks.find((x) => x.id === data.t.id)?.failed_claims ?? [] };
  const writer = t.transcripts.find((f: string) => f.endsWith("writer.jsonl"));
  const g = t.attempts.flatMap((a: Json) => a.gates).at(-1);
  const rows: Json[] = g ? g.result.rows : [];
  const failed = t.status === "failed" ? rows.filter((r) => r.status === "FAIL") : [];
  const errors = t.log.filter((l: Json) => l.level === "error").length;
  const tabs: [string, string][] = [["overview", "Overview"], ["attempts", "Attempts"], ["verification", "Verification"], ["changes", "Changes"], ["logs", "Logs"]];
  const head = html`<div class="head">
      <h2>${t.title} <${State} s=${t.status} /></h2>
      ${t.status === "failed" ? html`<div class="actions"><${Buttons} t=${t} setMsg=${setMsg} reload=${load} /></div>` : null}
    </div>
    ${t.fail_reason ? html`<div class="card banner" role="alert"><b class="FAIL">${t.fail_reason}</b>${t.status === "failed" ? html`<p class="muted">Next action: Retry the task, or Rewrite the proof tests.</p>` : null}</div>` : null}
    <div class="actions filters" role="tablist" aria-label="Task sections">
      ${tabs.map(([k, label]) => html`<button class="plain" role="tab" aria-selected=${tab === k} aria-pressed=${tab === k} onClick=${() => setTab(k)}>${label}</button>`)}
    </div>`;
  const overview = html`${t.pr_url ? html`<${Shipped} t=${t} />` : null}
    <div class="card">
      <${Branch} b=${t.branch} /> → <${Branch} b=${t.base} />
      ${t.pr_url ? html` · <a href=${t.pr_url}>PR #${t.pr_number}</a>` : " · no PR yet"}
      ${g ? html` · gate <${Pass} pass=${g.pass} /> at <span class="mono">${g.commit_sha.slice(0, 10)}</span>` : " · no gate run"}
      ${" · cost " + t.cost_usd.toFixed(2) + " USD · " + t.attempts.length + " attempt(s)"}
      ${t.writer_end
        ? html`<p><span class="muted">test writer ended:</span> <span class=${t.writer_end.startsWith("success") ? "PASS" : "FAIL"}>${t.writer_end}</span></p>`
        : null}
    </div>
    ${failed.length
      ? html`<div class="card banner" role="alert">
          <h3 class="FAIL">Assertion failure</h3>
          ${failed.map((r) => html`<p><b>${r.id}</b> ${r.reasons.join(", ")}</p>`)}
        </div>`
      : null}
    ${t.status === "failed" ? html`<${Rewrite} t=${t} msg=${msg} setMsg=${setMsg} />` : null}
    <details open=${t.specs.length > 0}>
      <summary>Proof tests (${t.specs.length})</summary>
      ${t.specs.map((s: Json) => html`<h3 class="mono">${s.name}</h3><pre>${s.text}</pre>`)}
    </details>
    ${t.transcripts.length
      ? html`<details><summary>Transcripts</summary>${t.transcripts.map((f: string) => html`<div class="mono"><a href=${file(f)} target="_blank">${f}</a></div>`)}</details>`
      : null}`;
  const attempts = html`<table><tbody>
      ${t.attempts.map(
        (a: Json) => html`<tr><td class="muted">${time(a.started_at)}</td><td>
          ${a.gates.map(
            (x: Json) => html`<div><${Pass} pass=${x.pass} /> <span class="mono">${x.commit_sha.slice(0, 10)}</span> ${x.result.rows.map((r: Json) => r.id + "=" + r.status).join(" ")}</div>`,
          )}
        </td></tr>`,
      )}
    </tbody></table>`;
  const verification = html`<div class="claims">${t.claims.map((c: Json) => html`<${ClaimCard} c=${c} r=${rows.find((x) => x.id === c.id)} />`)}</div>
    ${rows.length ? null : html`<p class="muted">No gate has run for this task.</p>`}`;
  const logs = html`<p class="muted">${t.log.length} lines · ${errors} ${errors === 1 ? "error" : "errors"}</p>
    <pre>${t.log.length ? t.log.map((l: Json) => html`<${LogLine} l=${l} />`) : html`<span class="muted">no log lines for this task</span>`}</pre>
    ${setupLog ? html`<h3>Setup log</h3><pre>${setupLog}</pre>` : null}
    ${writer ? html`<p><a href=${file(writer)} target="_blank">Test writer log</a> <span class="muted mono">${writer}</span></p>` : null}
    <p><a href=${"#/logs/" + t.id}>All logs of this task</a>${grafana
      ? html` · <a href=${grafana.replace(/\/$/, "") + "/d/awb/awb?var-task=" + encodeURIComponent(t.id)} target="_blank">Open in Grafana</a>`
      : null}</p>`;
  return html`${head}${tab === "attempts" ? attempts : tab === "verification" ? verification : tab === "changes" ? html`<${ChangedFiles} diff=${diff} />` : tab === "logs" ? logs : overview}`;
}
