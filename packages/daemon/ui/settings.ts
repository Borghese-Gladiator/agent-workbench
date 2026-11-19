import { html, useEffect, useState } from "./vendor/htm-preact.js";
import { get, Page, Seg, time, type Json } from "./components.ts";

const pref = (k: string, v: string) => {
  try { return localStorage.getItem(k) ?? v; } catch { return v; }
};

export function applyPrefs() {
  const r = document.documentElement;
  const theme = pref("awb.theme", "system");
  theme === "system" ? r.removeAttribute("data-theme") : r.setAttribute("data-theme", theme);
  r.setAttribute("data-density", pref("awb.density", "comfortable"));
}

export function Settings() {
  const [theme, setTheme] = useState(pref("awb.theme", "system"));
  const [density, setDensity] = useState(pref("awb.density", "comfortable"));
  const [health, setHealth] = useState<Json | null>(null);
  useEffect(() => void get("/health").then(setHealth, () => setHealth({})), []);
  const set = (k: string, v: string) => {
    try { localStorage.setItem(k, v); } catch {}
    k === "awb.theme" ? setTheme(v) : setDensity(v);
    applyPrefs();
  };
  return html`<${Page} title="Settings">
    <h2>Appearance</h2>
    <div class="toolbar"><span>Theme</span><${Seg} label="Theme" value=${theme} options=${[["system", "System"], ["light", "Light"], ["dark", "Dark"]]} onPick=${(v: string) => set("awb.theme", v)} /></div>
    <div class="toolbar"><span>Density</span><${Seg} label="Density" value=${density} options=${[["comfortable", "Comfortable"], ["compact", "Compact"]]} onPick=${(v: string) => set("awb.density", v)} /></div>
    <h2>Daemon</h2>
    ${health
      ? html`<table><tbody>
          <tr><td class="muted">Home folder</td><td class="mono">${health.home ?? ""}</td></tr>
          <tr><td class="muted">Process</td><td class="mono">${health.pid ?? ""}</td></tr>
          <tr><td class="muted">Started</td><td>${time(health.startedAt)}</td></tr>
          <tr><td class="muted">Sessions</td><td>${health.sessions ?? ""}</td></tr>
          <tr><td class="muted">Grafana</td><td>${health.grafana ? html`<a href=${health.grafana} target="_blank">${health.grafana}</a>` : html`<span class="muted">not set</span>`}</td></tr>
        </tbody></table>`
      : html`<p class="empty">Loading…</p>`}
  <//>`;
}
