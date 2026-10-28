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
  process.exit(0);
}
