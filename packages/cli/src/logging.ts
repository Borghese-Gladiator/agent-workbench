import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const COMPOSE_FILE = fileURLToPath(new URL("../../../infra/logging/docker-compose.yml", import.meta.url));

export function composeCommand(home: string, action: string[], file = COMPOSE_FILE) {
  return { cmd: "docker", args: ["compose", "-f", file, ...action], env: { AWB_LOGS: join(home, "logs") } };
}

export function loggingCmd(home: string, action: string[]): number {
  const { cmd, args, env } = composeCommand(home, action);
  try {
    execFileSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...env }, windowsHide: true });
    return 0;
  } catch {
    return 1;
  }
}
