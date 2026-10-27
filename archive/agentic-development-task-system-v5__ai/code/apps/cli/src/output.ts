export interface OutputOptions {
  quiet: boolean;
  json: boolean;
  verbose: boolean;
  color: boolean;
  input: boolean;
}

let current: OutputOptions = {
  quiet: false,
  json: false,
  verbose: false,
  color: process.stdout.isTTY === true,
  input: process.stdin.isTTY === true,
};

/**
 * Resolves the effective output options from commander's global flags. `--json` is the strongest
 * signal: it forces machine-readable output, so it implies no color and no interactive prompts. A
 * non-TTY stdout also disables color regardless of flags.
 */
export function configureOutput(flags: {
  quiet?: boolean;
  json?: boolean;
  verbose?: boolean;
  color?: boolean;
  input?: boolean;
}): OutputOptions {
  const json = flags.json === true;
  const isTty = process.stdout.isTTY === true;
  const color = json ? false : flags.color === false ? false : isTty;
  const input = json ? false : flags.input === false ? false : process.stdin.isTTY === true;
  current = {
    quiet: flags.quiet === true,
    json,
    verbose: flags.verbose === true,
    color,
    input,
  };
  return current;
}

export function outputOptions(): OutputOptions {
  return current;
}

/** Informational text (progress, confirmations). Suppressed by --quiet and never emitted as JSON. */
export function printInfo(message: string): void {
  if (current.quiet || current.json) return;
  process.stdout.write(`${message}\n`);
}

/**
 * The command's primary result — an id or requested value. Printed even under --quiet (that is the
 * whole point of --quiet: results only). Never used for JSON; call emitJson for that.
 */
export function printResult(message: string): void {
  if (current.json) return;
  process.stdout.write(`${message}\n`);
}

/** Machine-readable output. Only emitted when --json is set. Always the sole thing on stdout. */
export function emitJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Errors always go to stderr, regardless of --quiet. Under --json, still stderr (stdout stays clean). */
export function printError(message: string): void {
  process.stderr.write(`${message}\n`);
}
