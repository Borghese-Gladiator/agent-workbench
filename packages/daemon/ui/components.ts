import { html } from "./vendor/htm-preact.js";
import { relTime, toneOf } from "./select.ts";

export type Json = Record<string, any>;
export type Usage = { input: number; output: number; cache_read: number; cache_creation: number; cost_usd?: number };
export type Session = Json & { id: string; repo: string; branch: string; state: string; started_at: string; usage?: Usage };
export type Data = {
  sessions: Map<string, Session>;
  tasks: Json[];
  bySession: Record<string, string>;
  runs: Json[];
  taskUsd: Record<string, number>;
  reload: () => Promise<void>;
};

export const tok = (u?: Usage | null) => (u ? (u.input + u.cache_read + u.cache_creation).toLocaleString() + " / " + u.output.toLocaleString() : "");
export const time = (t?: string | null) => (t ? new Date(t).toLocaleString() : "");
export const file = (p: string) => "/files?path=" + encodeURIComponent(p);
export const usd = (n: unknown) => (typeof n === "number" ? n.toFixed(2) : "");
export const repoName = (r?: string | null) => (r ?? "").split("/").at(-1);
export const ago = (from: string, to?: string | null) => {
  const m = Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 60000);
  return m < 60 ? m + " min" : Math.floor(m / 60) + " h " + (m % 60) + " min";
};

export async function get(u: string): Promise<any> {
  const r = await fetch(u);
  if (!r.ok) throw new Error((await r.json()).error);
  return r.headers.get("content-type")?.includes("json") ? r.json() : r.text();
}

export async function post(u: string, body: unknown): Promise<any> {
  const r = await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  return j;
}

export const taskOf = (d: Data, s: Session) =>
  d.tasks.find((t) => t.id === d.bySession[s.id]) ?? d.tasks.find((t) => t.repo === s.repo && t.branch === s.branch);

export const Chip = ({ s, label }: { s: string; label?: string }) =>
  html`<span class=${"chip " + toneOf(s)}><i></i>${label ?? (s === "PASS" ? "Passed" : s === "FAIL" ? "Failed" : s)}</span>`;
export const State = Chip;
export const Pass = ({ pass }: { pass: boolean }) => html`<${Chip} s=${pass ? "PASS" : "FAIL"} />`;

export const Branch = ({ b }: { b?: string | null }) =>
  b ? html`<span class="nowrap"><span class="mono trunc" title=${b}>${b}</span><button class="copy" aria-label=${"Copy branch " + b} onClick=${(e: Event) => (e.stopPropagation(), navigator.clipboard?.writeText(b))}>Copy</button></span>` : null;
export const When = ({ t }: { t?: string | null }) => (t ? html`<time datetime=${t} title=${time(t)}>${relTime(t)}</time>` : null);
export const Id = ({ v }: { v?: string | null }) => (v ? html`<span class="id" title=${v}>${v.slice(0, 8)}</span>` : null);
export const TaskLink = ({ t }: { t?: Json }) => (t ? html`<a href=${"#/task/" + t.id}>${t.title}</a>` : null);

export const Stat = ({ label, value, tone }: { label: string; value: unknown; tone?: string }) =>
  html`<div class="stat"><span>${label}</span><b class=${tone ?? ""}>${value}</b></div>`;
export const Stats = ({ children }: { children?: unknown }) => html`<div class="stats" role="group" aria-label="Summary">${children}</div>`;
export const Empty = ({ text }: { text: string }) => html`<p class="empty">${text}</p>`;
export const Loading = () => html`<p class="empty" role="status">Loading…</p>`;
export const Failure = ({ text }: { text: string }) => html`<p class="callout" role="alert"><b>${text}</b></p>`;

export const Crumbs = ({ items }: { items: [string, string?][] }) =>
  html`<nav class="crumbs" aria-label="Breadcrumb">${items.map(([label, href], i) => html`${i ? "/" : ""}${href ? html`<a href=${href}>${label}</a>` : html`<span>${label}</span>`}`)}</nav>`;

export const Page = ({ title, crumbs, actions, children }: { title: unknown; crumbs?: [string, string?][]; actions?: unknown; children?: unknown }) =>
  html`${crumbs ? html`<${Crumbs} items=${crumbs} />` : null}
    <div class="page-head"><h1 class="title">${title}</h1>${actions ? html`<div class="actions">${actions}</div>` : null}</div>
    ${children}`;

export const Seg = ({ label, value, options, onPick }: { label: string; value: string; options: [string, string][]; onPick: (v: string) => void }) =>
  html`<div class="seg" role="group" aria-label=${label}>${options.map(([k, text]) => html`<button aria-pressed=${value === k} onClick=${() => onPick(k)}>${text}</button>`)}</div>`;

const LEVEL: Record<string, string> = { error: "error", warn: "warn" };
const IDS = new Set(["task", "run", "stack", "session", "attempt", "sha", "repo"]);
const val = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

export function LogLine({ l }: { l: Json }) {
  const { ts, level, source, event, ...rest } = l;
  const text = " " + ts.slice(0, 19).replace("T", " ") + " " + source + "." + event + " " + Object.entries(rest).map(([k, v]) => k + "=" + val(v)).join(" ");
  return html`<span class=${"lv " + (LEVEL[level] ?? "")}>${level.toUpperCase()}</span><span class=${level === "error" ? "FAIL" : ""}>${text}</span>${"\n"}`;
}

export function LogEntry({ l }: { l: Json }) {
  const { ts, level, source, event, ...rest } = l;
  const keys = Object.entries(rest);
  const brief = String(keys.find(([k]) => k === "reason" || k === "error")?.[1] ?? keys.filter(([k]) => !IDS.has(k)).map(([k, v]) => k + "=" + val(v)).join(" "));
  return html`<details class="ev"><summary><span class="muted mono">${ts.slice(11, 19)}</span><span class=${"lv " + (LEVEL[level] ?? "")}>${level}</span>
    <span class="what"><b>${source}.${event}</b> <span class="muted">${brief.length > 140 ? brief.slice(0, 140) + "…" : brief}</span></span></summary>
    <dl class="kv">${keys.map(([k, v]) => html`<dt>${k}</dt><dd>${val(v)}</dd>`)}<dt>time</dt><dd>${ts}</dd></dl></details>`;
}
