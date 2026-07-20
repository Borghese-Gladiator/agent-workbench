#!/usr/bin/env node
/**
 * Derive a per-stage MODEL-WAIT vs TOOL-WAIT split for a task's agent runs,
 * purely from the timestamps the daemon already persists on each AgentRunEvent.
 * This fills the one gap the built-in `wb task profile` doesn't cover: how much
 * of each stage's wall-clock was spent waiting on the model vs executing tools.
 *
 *   node scripts/profile-latency-split.mjs <taskId> [--url http://127.0.0.1:4602]
 *
 * Method (events are seq-ordered within a run):
 *   - tool-wait  = sum over tool_call -> next tool_result of (result - call)
 *   - model-wait = sum of the gaps that are NOT tool-wait, i.e. run-start->first
 *     event, and each tool_result -> next (assistant_text|tool_call). That's the
 *     time the model was producing tokens / "thinking".
 *   - other      = total wall-clock - (model-wait + tool-wait); covers queueing,
 *     spawn overhead, and the tail after the last event.
 * All three are LOWER/derived bounds — event timestamps are when the daemon
 * RECORDED each line, so model-wait also absorbs streaming + IPC. It's still the
 * cleanest split available without capturing the CLI's duration_api_ms.
 */
const taskId = process.argv[2];
if (!taskId) {
  console.error('usage: node scripts/profile-latency-split.mjs <taskId> [--url <base>]');
  process.exit(1);
}
const urlFlag = process.argv.indexOf('--url');
const base = (urlFlag >= 0 ? process.argv[urlFlag + 1] : 'http://127.0.0.1:4602').replace(
  /\/$/,
  '',
);

const ms = (n) =>
  n == null
    ? '—'
    : n >= 60000
      ? `${Math.floor(n / 60000)}m ${Math.round((n % 60000) / 1000)}s`
      : `${(n / 1000).toFixed(1)}s`;
const pct = (n, d) => (d > 0 ? `${Math.round((100 * n) / d)}%` : '—');
const at = (ts) => (ts ? Date.parse(ts) : null);

async function getJson(path) {
  const r = await fetch(base + path);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

function splitOf(events) {
  const ev = [...events].sort((a, b) => a.seq - b.seq);
  let modelWait = 0;
  let toolWait = 0;
  // Pair tool_call -> next tool_result for tool-wait; everything else is model.
  for (let i = 0; i < ev.length; i++) {
    const e = ev[i];
    if (e.type !== 'tool_call') continue;
    for (let j = i + 1; j < ev.length; j++) {
      if (ev[j].type === 'tool_call') break;
      if (ev[j].type === 'tool_result') {
        const a = at(e.createdAt);
        const b = at(ev[j].createdAt);
        if (a != null && b != null) toolWait += Math.max(0, b - a);
        break;
      }
    }
  }
  // Model-wait: gaps that aren't a tool_call->tool_result span. Walk consecutive
  // events; if the gap isn't the tool execution we just counted, attribute to model.
  for (let i = 1; i < ev.length; i++) {
    const prev = ev[i - 1];
    const cur = ev[i];
    const a = at(prev.createdAt);
    const b = at(cur.createdAt);
    if (a == null || b == null) continue;
    const gap = Math.max(0, b - a);
    // The tool execution gap is prev=tool_call -> cur=tool_result; skip (counted).
    if (prev.type === 'tool_call' && cur.type === 'tool_result') continue;
    modelWait += gap;
  }
  return { modelWait, toolWait, firstSeq: ev[0]?.seq, count: ev.length };
}

const detail = await getJson(`/api/tasks/${taskId}`);
const runs = [...detail.agentRuns].sort((a, b) => a.startedAt.localeCompare(b.startedAt));

// Per-run events come from the SINGULAR run endpoint ({run, events}) — NOT the
// /events route, which is an SSE stream.
async function eventsOf(runId) {
  const { events } = await getJson(`/api/tasks/${taskId}/agent/runs/${runId}`);
  return events ?? [];
}

console.log(`# Latency split (model-wait vs tool-wait) — ${detail.task.title}`);
console.log(`\nTask \`${taskId}\` · ${detail.project?.name ?? '—'} · ${runs.length} runs\n`);
console.log(`| Stage | Wall-clock | Model-wait | Tool-wait | Other | Model % |`);
console.log(`|---|--:|--:|--:|--:|--:|`);

let tWall = 0,
  tModel = 0,
  tTool = 0;
for (const r of runs) {
  const events = await eventsOf(r.id);
  const { modelWait, toolWait } = splitOf(events);
  const wall =
    at(r.finishedAt) != null && at(r.startedAt) != null ? at(r.finishedAt) - at(r.startedAt) : null;
  const other = wall != null ? Math.max(0, wall - modelWait - toolWait) : null;
  tWall += wall ?? 0;
  tModel += modelWait;
  tTool += toolWait;
  console.log(
    `| ${r.stage} | ${ms(wall)} | ${ms(modelWait)} | ${ms(toolWait)} | ${ms(other)} | ${pct(modelWait, modelWait + toolWait)} |`,
  );
}
console.log(
  `| **total** | ${ms(tWall)} | ${ms(tModel)} | ${ms(tTool)} | ${ms(Math.max(0, tWall - tModel - tTool))} | ${pct(tModel, tModel + tTool)} |`,
);
console.log(
  `\n_Derived from event-record timestamps: tool-wait = Σ(tool_call→tool_result); model-wait = the remaining inter-event gaps (model producing tokens + stream/IPC); other = wall-clock minus both (spawn/queue/tail). For TRUE model API time, capture the CLI result line's duration_api_ms._`,
);
