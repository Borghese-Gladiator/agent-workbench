export type Recipe = { start: string | null; url: string; ready: string };

export function parseRecipe(text: string): Recipe {
  const section = text.match(/^##\s+start\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im)?.[1];
  if (!section) throw new Error("run.md has no '## start' section");
  const start = section.match(/```(?:sh|bash|shell)?\n([\s\S]*?)```/)?.[1].trim() || null;
  const url = section.match(/^url:\s*(\S+)\s*$/m)?.[1];
  if (!url) throw new Error("run.md '## start' has no 'url:' line");
  const ready = section.match(/^ready:\s*(\S+)\s*$/m)?.[1] ?? "/";
  return { start, url, ready };
}

export function fill(s: string, port: number): string {
  return s.replaceAll("{port}", String(port));
}
