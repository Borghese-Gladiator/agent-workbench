import { execSync } from "node:child_process";

export interface TmuxSessionInfo {
  name: string;
  width: number;
  height: number;
}

export function createSession(name: string, cwd?: string): void {
  const cwdArg = cwd ? ` -c ${shellEscape(cwd)}` : "";
  execSync(`tmux new-session -d -s ${shellEscape(name)} -x 200 -y 50${cwdArg}`);
}

export function sessionExists(name: string): boolean {
  try {
    execSync(`tmux has-session -t ${shellEscape(name)}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function listSessions(): TmuxSessionInfo[] {
  try {
    const output = execSync(
      'tmux list-sessions -F "#{session_name}:#{session_width}:#{session_height}"',
      { encoding: "utf-8" },
    );
    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, w, h] = line.split(":");
        return { name, width: Number(w), height: Number(h) };
      });
  } catch {
    return [];
  }
}

export function killSession(name: string): void {
  try {
    execSync(`tmux kill-session -t ${shellEscape(name)}`, { stdio: "ignore" });
  } catch {
    // Session may already be dead — that's fine
  }
}

export function sendKeys(
  name: string,
  keys: string,
  pressEnter = false,
): void {
  if (pressEnter) {
    // For commands like `claude` or `claude --resume <id>`
    execSync(
      `tmux send-keys -t ${shellEscape(name)} ${shellEscape(keys)} Enter`,
    );
  } else {
    // Literal paste — no Enter at end (for pasting ticket prompts)
    execSync(
      `tmux send-keys -t ${shellEscape(name)} -l ${shellEscape(keys)}`,
    );
  }
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
