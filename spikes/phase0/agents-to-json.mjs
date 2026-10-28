import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const agents = {};
for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
  const [, head, body] = readFileSync(join(dir, file), "utf8").match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const meta = {};
  for (const line of head.split("\n")) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2];
    if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1).replaceAll("''", "'");
    meta[m[1]] = v;
  }
  agents[meta.name] = {
    description: meta.description,
    tools: meta.tools.split(",").map((t) => t.trim()),
    model: meta.model,
    prompt: body.trim(),
  };
}
process.stdout.write(JSON.stringify(agents, null, 2));
