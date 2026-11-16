import { readFileSync } from "node:fs";
import { join } from "node:path";

export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"] as const;

export function eventBody(raw: string, awbSessionId: string) {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = { hook_event_name: "unparsed", raw: raw.slice(0, 10_000) };
  }
  return { awb_session_id: awbSessionId, payload };
}

export function blockReason(raw: string): string | null {
  let p: any;
  try {
    p = JSON.parse(raw);
  } catch {
    return null;
  }
  if (p?.hook_event_name !== "PreToolUse" || p?.tool_name !== "Bash") return null;
  const cmd = String(p?.tool_input?.command ?? "");
  for (const segment of cmd.split(/&&|\|\||[;|\n]/)) {
    const s = segment.trim();
    if (!/^gh\s+pr\s+create\b/.test(s)) continue;
    if (!/(^|\s)(--draft|-d)(?=\s|=|$)/.test(s)) {
      return "awb: open a PR only as a draft. Add --draft to gh pr create.";
    }
  }
  return null;
}

export async function sendHook(raw: string, env: NodeJS.ProcessEnv, timeoutMs = 1000): Promise<boolean> {
  try {
    const home = env.AWB_HOME;
    const id = env.AWB_SESSION_ID;
    if (!home || !id) return false;
    const { port } = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8"));
    const res = await fetch(`http://127.0.0.1:${port}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(eventBody(raw, id)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

if (import.meta.main) {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {}
  await sendHook(raw, process.env);
  const reason = blockReason(raw);
  if (reason) {
    process.stderr.write(reason + "\n");
    process.exit(2);
  }
  process.exit(0);
}
