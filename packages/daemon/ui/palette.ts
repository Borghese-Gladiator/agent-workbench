import { html, useEffect, useRef, useState } from "./vendor/htm-preact.js";
import { Chip, Empty, type Json } from "./components.ts";
import { paletteRows } from "./select.ts";

export function Palette({ pages, tasks }: { pages: [string, string][]; tasks: Json[] }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const dlg = useRef<HTMLDialogElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (dlg.current?.open) return;
        setQ("");
        setSel(0);
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    const d = dlg.current!;
    if (!d.open) d.showModal();
    input.current?.focus();
  }, [open]);

  useEffect(() => document.getElementById("pal-" + sel)?.scrollIntoView({ block: "nearest" }), [sel, q, open]);

  if (!open) return null;
  const rows = paletteRows(pages, tasks, q);
  const close = () => dlg.current?.open && dlg.current.close();
  const go = (href: string) => ((location.hash = href), close());
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length) setSel((sel + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
    } else if (e.key === "Enter" && rows[sel]) {
      e.preventDefault();
      go(rows[sel].href);
    }
  };

  return html`<dialog ref=${dlg} role="dialog" class="palette" aria-label="Command palette" onClose=${() => setOpen(false)} onClick=${(e: Event) => e.target === dlg.current && close()}>
    <input ref=${input} role="combobox" aria-expanded="true" aria-controls="pal-list" aria-activedescendant=${rows.length ? "pal-" + sel : undefined} aria-label="Search pages and tasks" placeholder="Search pages and tasks…" autocomplete="off" value=${q} onInput=${(e: Event) => (setQ((e.target as HTMLInputElement).value), setSel(0))} onKeyDown=${onKeyDown} />
    <div id="pal-list" role="listbox" aria-label="Results">
      ${rows.length
        ? rows.map((r, i) => html`<div id=${"pal-" + i} key=${r.key} role="option" class="opt" aria-selected=${i === sel} onMouseMove=${() => i !== sel && setSel(i)} onClick=${() => go(r.href)}>
            <span class="trunc-row">${r.label}</span>${r.status ? html`<${Chip} s=${r.status} />` : html`<span class="muted">Page</span>`}
          </div>`)
        : html`<${Empty} text="No results" />`}
    </div>
  </dialog>`;
}
