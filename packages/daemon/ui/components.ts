import { html } from "./vendor/htm-preact.js";

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

export const State = ({ s }: { s: string }) => html`<span class=${s}>${s}</span>`;
export const Pass = ({ pass }: { pass: boolean }) => html`<span class=${pass ? "PASS" : "FAIL"}>${pass ? "PASS" : "FAIL"}</span>`;
export const TaskLink = ({ t }: { t?: Json }) => (t ? html`<a href=${"#/task/" + t.id}>${t.title}</a>` : null);
