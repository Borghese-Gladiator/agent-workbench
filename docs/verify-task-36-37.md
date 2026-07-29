# Verifying TASK-36 (one trace per run) + TASK-37 (task delete cascade)

A copy-paste query cheat-sheet to prove both features yourself. Three independent
proof paths: a pure function (no stack), SQLite (survives teardown), and Tempo
(needs a live stack).

Paths used below:
- DB: `~/.agentic-workbench/database/workbench.sqlite` (survives `awb down`)
- **Grafana UI** (open this in a browser): `http://127.0.0.1:3000` — Explore → Tempo
- OTLP receiver: `http://127.0.0.1:4318` — this is an **ingest endpoint, not a UI**;
  a browser hitting it returns `404 page not found` even when healthy. Do not
  open it in a browser; spans are POSTed to it by the worker/daemon.

> **Two hard prerequisites for any Tempo query to return data:**
> 1. **Run under the claude runtime.** Boot with
>    `AWB_AGENT_RUNTIME=claude AWB_QA_MODE=browser awb up`. The default (mock)
>    runtime emits little/no telemetry — Tempo will look empty.
> 2. **The trace must still exist.** The collector is `grafana/otel-lgtm --rm`
>    with an in-memory store, so **`awb down` wipes every trace.** Query a trace
>    from the *current* stack session, not a previous one. A trace id from a prior
>    run will return `"traces": []` / "Not Found" — that is expected, not a bug.

Fill these in from your run:
- `TASK` = a task id (from `awb task list`)
- `RUN`  = `${TASK}-run` (the deterministic run id; see `runIdForTask`)

---

## A. TASK-36 — deterministic trace id (pure function, no stack needed)

The core of TASK-36: `deriveRunTraceId(runId)` = SHA-256(runId), first 16 bytes
as hex. Same run id → same 32-hex trace id, forever. This is why phases spread
across separate Temporal activity executions all share one trace.

```bash
# shell — matches packages/telemetry/src/spans.ts deriveRunTraceId()
printf '%s' "31e630e9-56cb-49e2-afec-9b45df389097-run" | openssl dgst -sha256 | awk '{print substr($NF,1,32)}'
# -> 12cb3f480a4105651d049f1fd4f07486
```

```bash
# node — identical result, and shows a different run id yields a different trace
node -e 'const{createHash}=require("crypto");const f=r=>createHash("sha256").update(r).digest("hex").slice(0,32);
console.log(f("31e630e9-56cb-49e2-afec-9b45df389097-run"));'
```

The value this prints is exactly the trace id Tempo received for that run
(`12cb3f480a4105651d049f1fd4f07486` on the 2026-07-28 run).

---

## B. TASK-36 — the nested trace in Tempo (requires `awb up`)

Only Grafana (:3000) and OTLP (:4318) are published; Tempo's query API (3200) is
reached through the Grafana datasource proxy. Telemetry is diagnostics-only and
the collector is `--rm`, so trace data is wiped on `awb down`.

```bash
# 1. Find the trace for a run by its bridge tag (task_id). Returns ONE traceID.
curl -s "http://127.0.0.1:3000/api/datasources/proxy/uid/tempo/api/search?tags=task_id%3D${TASK}&limit=20" | python3 -m json.tool

# 2. Fetch that trace and print the span tree. Every phase.* parents to the same
#    derived run root; session.builder nests under phase.implement.
TRACE=$(printf '%s' "${TASK}-run" | openssl dgst -sha256 | awk '{print substr($NF,1,32)}')
curl -s "http://127.0.0.1:3000/api/datasources/proxy/uid/tempo/api/traces/${TRACE}" \
| python3 -c '
import sys, json, base64
d = json.load(sys.stdin)
def hx(x):
    return base64.b64decode(x).hex() if x else ""
spans = [s for b in (d.get("batches") or [])
           for ss in b.get("scopeSpans", [])
           for s in ss.get("spans", [])]
byid = {hx(s["spanId"]): s for s in spans}
print("distinct traceIds:", {hx(s["traceId"]) for s in spans}, "(expect exactly one)")
for s in spans:
    pid = hx(s.get("parentSpanId", ""))
    par = byid.get(pid)
    pdesc = par["name"] if par else ("DERIVED-RUN-ROOT" if pid else "NONE")
    dur = (int(s.get("endTimeUnixNano", 0)) - int(s.get("startTimeUnixNano", 0))) // 1_000_000
    name = s["name"]
    print("  {:22} {:7}ms  parent -> {}".format(name, dur, pdesc))'
```

Expected shape (durations vary):
```
distinct traceIds: {'12cb3f480a4105651d049f1fd4f07486'} (expect exactly one)
  phase.specify         ...ms  parent -> DERIVED-RUN-ROOT
  phase.plan            ...ms  parent -> DERIVED-RUN-ROOT
  phase.implement       ...ms  parent -> DERIVED-RUN-ROOT
  session.builder       ...ms  parent -> phase.implement      <- the nesting
  phase.verify          ...ms  parent -> DERIVED-RUN-ROOT
  ...
```

Or open it in a browser: `http://127.0.0.1:3000` → Explore → Tempo → search by
`task_id`. (`DERIVED-RUN-ROOT` = the non-recording run span we parent to but never
emit; Tempo labels it "root span not yet received" — expected.)

Metrics (Prometheus, same proxy) also carry the bridge tags:
```bash
curl -s "http://127.0.0.1:3000/api/datasources/proxy/uid/prometheus/api/v1/query?query=awb_phase_started_total" | python3 -m json.tool
```

---

## C. TASK-37 — the cascade delete in SQLite (survives teardown)

`awb task remove <repo> <task> --yes` terminates the workflow, then cascades.
After removing a task, prove nothing anywhere references it, a sibling is intact,
and there are no FK orphans.

```bash
sqlite3 ~/.agentic-workbench/database/workbench.sqlite <<SQL
.headers on
.mode column
-- deleted task: every count must be 0
SELECT 'tasks' t, COUNT(*) n FROM tasks WHERE id='${TASK}'
UNION ALL SELECT 'runs',            COUNT(*) FROM runs            WHERE task_id='${TASK}'
UNION ALL SELECT 'phase_attempts',  COUNT(*) FROM phase_attempts  WHERE task_id='${TASK}'
UNION ALL SELECT 'agent_sessions',  COUNT(*) FROM agent_sessions  WHERE task_id='${TASK}'
UNION ALL SELECT 'semantic_events', COUNT(*) FROM semantic_events WHERE run_id='${TASK}-run'
UNION ALL SELECT 'evidence',        COUNT(*) FROM evidence        WHERE task_id='${TASK}'
UNION ALL SELECT 'plans',           COUNT(*) FROM plans           WHERE task_id='${TASK}'
UNION ALL SELECT 'task_contracts',  COUNT(*) FROM task_contracts  WHERE task_id='${TASK}'
UNION ALL SELECT 'artifacts',       COUNT(*) FROM artifacts       WHERE task_id='${TASK}'
UNION ALL SELECT 'workspace_leases',COUNT(*) FROM workspace_leases WHERE task_id='${TASK}';

-- FK integrity: prints nothing when clean
PRAGMA foreign_key_check;
SQL
```

`PRAGMA foreign_key_check` with no output = no orphaned rows anywhere in the DB.

To see a full pre-delete footprint before removing, run the same counts against a
task that still exists (e.g. from `awb task list`).

Note: `memory_sources` is intentionally NOT deleted — its `task_id` is a plain
column with no FK to `tasks` (it belongs to repo-scoped memory), so deleting it
would orphan repository memory. It never blocks the cascade.
