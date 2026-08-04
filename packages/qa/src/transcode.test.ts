import { describe, expect, it } from 'vitest';
import {
  transcodeWebmToGif,
  GIF_MAX_BYTES,
  GIF_MAX_WIDTH,
  GIF_STEP_DOWN,
  type TranscodeRunner,
} from './transcode.js';

/** A runner that records every ffmpeg invocation and returns a scripted output size per encode. */
function fakeRunner(sizes: number[]): { runner: TranscodeRunner; calls: string[][] } {
  const calls: string[][] = [];
  let encode = -1; // each encode = two runs (palettegen + paletteuse); statSize advances the encode.
  const runner: TranscodeRunner = {
    async run(_file, args) {
      calls.push(args);
    },
    async statSize() {
      encode += 1;
      return sizes[encode] ?? sizes[sizes.length - 1] ?? 0;
    },
  };
  return { runner, calls };
}

describe('transcodeWebmToGif', () => {
  it('encodes at the full budget (640px/10fps) and stops when within budget', async () => {
    const { runner, calls } = fakeRunner([GIF_MAX_BYTES - 1]);
    const result = await transcodeWebmToGif('in.webm', 'out.gif', runner);

    expect(result.width).toBe(GIF_MAX_WIDTH);
    expect(result.fps).toBe(10);
    expect(result.withinBudget).toBe(true);
    // Two ffmpeg passes (palettegen + paletteuse), no step-down.
    expect(calls).toHaveLength(2);
    // The width cap is present in the scale filter of every pass.
    for (const args of calls) {
      expect(args.join(' ')).toContain(`min(${GIF_MAX_WIDTH}`);
    }
  });

  it('steps down width then fps when the encode is over budget, and re-encodes', async () => {
    // First encode over budget, second (480px) still over, third (480px/5fps) fits.
    const { runner, calls } = fakeRunner([GIF_MAX_BYTES + 1, GIF_MAX_BYTES + 1, GIF_MAX_BYTES - 1]);
    const result = await transcodeWebmToGif('in.webm', 'out.gif', runner);

    expect(result.withinBudget).toBe(true);
    expect(result.width).toBe(480);
    expect(result.fps).toBe(5);
    // Three encodes × two passes each.
    expect(calls).toHaveLength(GIF_STEP_DOWN.length * 2);
    // A later pass uses the stepped-down 480 width.
    expect(calls.some((args) => args.join(' ').includes('min(480'))).toBe(true);
    // And a later pass uses 5fps.
    expect(calls.some((args) => args.join(' ').includes('fps=5'))).toBe(true);
  });

  it('returns the smallest encode reached when every step-down is still over budget', async () => {
    const { runner } = fakeRunner([GIF_MAX_BYTES + 100, GIF_MAX_BYTES + 100, GIF_MAX_BYTES + 100]);
    const result = await transcodeWebmToGif('in.webm', 'out.gif', runner);

    expect(result.withinBudget).toBe(false);
    // The last (smallest) rung.
    expect(result.width).toBe(GIF_STEP_DOWN[GIF_STEP_DOWN.length - 1]!.width);
    expect(result.fps).toBe(GIF_STEP_DOWN[GIF_STEP_DOWN.length - 1]!.fps);
  });
});
