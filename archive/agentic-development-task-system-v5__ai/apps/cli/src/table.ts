/**
 * Fixed-width aligned rows for a human on a TTY: each column is as wide as its header or its
 * widest cell, whichever is larger. Returns the header line followed by one line per row.
 *
 * The width-then-pad dance was written out separately in every command that prints a table; this
 * is the one copy.
 */
export function formatColumns(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  // Iterate the widths, not the row, so a row with fewer cells than the header still lines up
  // instead of silently dropping its trailing columns.
  const line = (cols: string[]): string =>
    widths
      .map((w, i) => (cols[i] ?? '').padEnd(w))
      .join('  ')
      .trimEnd();
  return [line(header), ...rows.map(line)];
}
