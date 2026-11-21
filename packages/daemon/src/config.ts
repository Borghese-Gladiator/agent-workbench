import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_STACKS, stackLimit } from "./runner.ts";
import { StackError } from "./stacks.ts";

export type Config = { maxStacks?: number };

export function readConfig(home: string): Config {
  try {
    return existsSync(join(home, "config.json")) ? JSON.parse(readFileSync(join(home, "config.json"), "utf8")) : {};
  } catch {
    return {};
  }
}

export function setStackLimit(home: string, v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_STACKS) throw new StackError(`the limit must be an integer from 1 to ${MAX_STACKS}, not ${v}`, 400);
  const file = join(home, "config.json");
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...readConfig(home), maxStacks: n }, null, 2));
  renameSync(tmp, file);
  return n;
}

export const currentLimit = (home: string, env = process.env.AWB_MAX_STACKS) => {
  const v = readConfig(home).maxStacks;
  return typeof v === "number" ? stackLimit(String(v)) : stackLimit(env);
};
