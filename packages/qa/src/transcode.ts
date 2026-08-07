import { execFile } from 'node:child_process';
import { stat, rm } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Inline-image budget for a QA recording GIF. GitHub embeds an animated GIF inline via image
 * markdown (the same path the screenshot uses), but only up to its inline-image ceiling — a
 * full-res/full-length GIF blows past it and degrades to a link. The caps keep the GIF small
 * enough to render inline; when the first encode is over budget we step down (width, then fps)
 * and re-encode. Named so they're tunable in one place.
 */
export const GIF_MAX_WIDTH = 640;
export const GIF_MAX_FPS = 10;
export const GIF_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Ordered encode ladder: start at the full budget (640px / 10fps), then step DOWN width first, then
 * fps — matching TASK-58's "width → 480, then fps → 5". Each rung is only reached if the previous
 * one came back over `GIF_MAX_BYTES`.
 */
export const GIF_STEP_DOWN: ReadonlyArray<{ width: number; fps: number }> = [
  { width: GIF_MAX_WIDTH, fps: GIF_MAX_FPS },
  { width: 480, fps: GIF_MAX_FPS },
  { width: 480, fps: 5 },
];

export interface TranscodeRunner {
  run(file: string, args: string[]): Promise<void>;
  /** Byte size of a produced file, used to decide whether to step down. */
  statSize(path: string): Promise<number>;
  /** Best-effort removal of an intermediate file (the palette PNG). */
  cleanup(path: string): Promise<void>;
}

const defaultRunner: TranscodeRunner = {
  async run(file, args) {
    await execFileAsync(file, args);
  },
  async statSize(path) {
    return (await stat(path)).size;
  },
  async cleanup(path) {
    await rm(path, { force: true });
  },
};

/** The palette-PNG intermediate ffmpeg writes for a given GIF destination. */
function palettePath(dest: string): string {
  return `${dest}.palette.png`;
}

/** ffmpeg args for a single two-pass palettegen/paletteuse GIF encode at a given width + fps. */
function gifPassArgs(src: string, dest: string, width: number, fps: number): string[][] {
  // `min(width,iw)` never upscales; lanczos keeps the downscale crisp.
  const filters = `fps=${fps},scale=min(${width}\\,iw):-1:flags=lanczos`;
  const palette = palettePath(dest);
  return [
    ['-y', '-i', src, '-vf', `${filters},palettegen`, palette],
    ['-y', '-i', src, '-i', palette, '-lavfi', `${filters}[x];[x][1:v]paletteuse`, dest],
  ];
}

export interface TranscodeResult {
  /** The width cap actually used for the final encode. */
  width: number;
  /** The fps actually used for the final encode. */
  fps: number;
  /** Final output size in bytes. */
  byteSize: number;
  /** True when the output is within `GIF_MAX_BYTES` after the last attempted step-down. */
  withinBudget: boolean;
}

/**
 * Transcodes a WEBM QA recording to a downscaled animated GIF that GitHub can render inline. Runs
 * ffmpeg two-pass (palettegen → paletteuse) at width ≤ 640 / 10fps; if the result is over
 * `GIF_MAX_BYTES` it steps down (width → 480, then fps → 5) and re-encodes, returning the smallest
 * encode it reached. The runner + size probe are injectable so the step-down logic is unit-testable
 * without a real ffmpeg.
 */
export async function transcodeWebmToGif(
  src: string,
  dest: string,
  runner: TranscodeRunner = defaultRunner,
): Promise<TranscodeResult> {
  let last: TranscodeResult | undefined;
  try {
    for (const { width, fps } of GIF_STEP_DOWN) {
      for (const args of gifPassArgs(src, dest, width, fps)) {
        await runner.run('ffmpeg', args);
      }
      const byteSize = await runner.statSize(dest);
      last = { width, fps, byteSize, withinBudget: byteSize <= GIF_MAX_BYTES };
      if (last.withinBudget) return last;
    }
    // Every step-down was still over budget — return the smallest encode we reached (last rung).
    return last!;
  } finally {
    // Drop the palette-PNG intermediate so it is never swept into the PR branch alongside the GIF.
    await runner.cleanup(palettePath(dest));
  }
}
