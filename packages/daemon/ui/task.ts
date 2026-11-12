import { html, useEffect, useState } from "./vendor/htm-preact.js";
import { file, get, Pass, post, time, type Data, type Json } from "./components.ts";

function LogLine({ l }: { l: Json }) {
  const { ts, level, source, event, ...rest } = l;
  const text =
    ts.slice(0, 19).replace("T", " ") + " " + level.toUpperCase().padEnd(5) + " " + source + "." + event + " " +
    Object.entries(rest).map(([k, v]) => k + "=" + (typeof v === "string" ? v : JSON.stringify(v))).join(" ");
  return html`<span class=${level === "error" ? "FAIL" : level === "warn" ? "busy" : ""}>${text}</span>${"\n"}`;
}

function Actions({ t, reload }: { t: Json; reload: () => void }) {
  const [msg, setMsg] = useState<[string, boolean]>(["", false]);
  const [out, setOut] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
    <h3>Actions</h3>
    <div class="actions">
      <button onClick=${retry}>Retry</button>
      <button class="danger" onClick=${drop}>Drop</button>
      <span class=${msg[1] ? "FAIL" : "muted"}>${msg[0]}</span>
    </div>
    <form style="margin-top:12px" onSubmit=${rewrite}>
      <div>
        ${t.claims.map(
          (c: Json) => html`<label class="box"><input type="checkbox" name="claim" value=${c.id} checked=${t.failed_claims.includes(c.id)} />${c.id}</label>`,
        )}
        <button class="plain" disabled=${!t.worktree || busy}>Rewrite test</button>
      </div>
      ${t.worktree ? null : html`<p class="muted">This task has no worktree, so the proof cannot run from here.</p>`}
      ${out === null ? null : html`<pre>${out}</pre>`}
    </form>
  </div>`;
}

function ClaimCard({ c, r }: { c: Json; r?: Json }) {
  return html`<div class="card">
    <h3>${c.id} <span class=${r?.status ?? "waiting"}>${r?.status ?? "not run"}</span></h3>
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

export function TaskView({ d, id }: { d: Data; id: string }) {
  const [data, setData] = useState<{ t: Json; diff: string; setupLog: string } | null>(null);
  const [error, setError] = useState("");
  const load = async () => {
    try {
      const [t, diff] = await Promise.all([get("/api/tasks/" + id), get("/api/tasks/" + id + "/diff").catch(() => "")]);
      const setupLog = await get(file(t.folder + "/setup.log")).catch(() => "");
      setData({ t, diff, setupLog });
    } catch (err) {
      setError((err as Error).message);
    }
  };
  useEffect(() => void load(), [id]);
  if (error) return html`<p class="FAIL">${error}</p>`;
  if (!data) return html`<p class="muted">Loading…</p>`;
  const { diff, setupLog } = data;
  const t: Json = { ...data.t, failed_claims: d.tasks.find((x) => x.id === data.t.id)?.failed_claims ?? [] };
  const writer = t.transcripts.find((f: string) => f.endsWith("writer.jsonl"));
  const g = t.attempts.flatMap((a: Json) => a.gates).at(-1);
  const rows: Json[] = g ? g.result.rows : [];
  return html`<h2>${t.title} <span class=${t.status}>${t.status}</span></h2>
    <div class="card">
      <span class="mono">${t.branch}</span> → <span class="mono">${t.base}</span>
      ${t.pr_url ? html` · <a href=${t.pr_url}>PR #${t.pr_number}</a>` : " · no PR yet"}
      ${g ? html` · gate <${Pass} pass=${g.pass} /> at <span class="mono">${g.commit_sha.slice(0, 10)}</span>` : " · no gate run"}
      ${" · cost " + t.cost_usd.toFixed(2) + " USD · " + t.attempts.length + " attempt(s)"}
      ${t.fail_reason ? html`<p class="FAIL">${t.fail_reason}</p>` : null}
      ${t.writer_end
        ? html`<p><span class="muted">test writer ended:</span> <span class=${t.writer_end.startsWith("success") ? "PASS" : "FAIL"}>${t.writer_end}</span></p>`
        : null}
    </div>
    ${t.status === "failed" ? html`<${Actions} t=${t} reload=${load} />` : null}
    <div class="claims">${t.claims.map((c: Json) => html`<${ClaimCard} c=${c} r=${rows.find((x) => x.id === c.id)} />`)}</div>
    <details open=${t.status === "failed"}>
      <summary>Logs (${t.log.length} lines)</summary>
      <pre>${t.log.length ? t.log.map((l: Json) => html`<${LogLine} l=${l} />`) : html`<span class="muted">no log lines for this task</span>`}</pre>
      ${setupLog ? html`<h3>Setup log</h3><pre>${setupLog}</pre>` : null}
      ${writer ? html`<p><a href=${file(writer)} target="_blank">Test writer log</a> <span class="muted mono">${writer}</span></p>` : null}
    </details>
    <details>
      <summary>Attempts (${t.attempts.length})</summary>
      <table><tbody>
        ${t.attempts.map(
          (a: Json) => html`<tr><td class="muted">${time(a.started_at)}</td><td>
            ${a.gates.map(
              (x: Json) => html`<div><${Pass} pass=${x.pass} /> <span class="mono">${x.commit_sha.slice(0, 10)}</span> ${x.result.rows.map((r: Json) => r.id + "=" + r.status).join(" ")}</div>`,
            )}
          </td></tr>`,
        )}
      </tbody></table>
    </details>
    <details open=${t.specs.length > 0}>
      <summary>Proof tests (${t.specs.length})</summary>
      ${t.specs.map((s: Json) => html`<h3 class="mono">${s.name}</h3><pre>${s.text}</pre>`)}
    </details>
    <details open>
      <summary>Diff</summary>
      <pre id="diff">${diff ? html`<${Diff} diff=${diff} />` : html`<span class="muted">no diff</span>`}</pre>
    </details>
    ${t.transcripts.length
      ? html`<details><summary>Transcripts</summary>${t.transcripts.map((f: string) => html`<div class="mono"><a href=${file(f)} target="_blank">${f}</a></div>`)}</details>`
      : null}`;
}
