// Proof artifact generator for TASK-58 (committed so it is re-runnable, not just pasted output).
//
// Produces a REAL WEBM and transcodes it to a REAL downscaled GIF via the production
// `transcodeWebmToGif` (real ffmpeg two-pass), writing both into `.awb/qa/` so they can be
// committed to the PR branch and referenced by the QA-media comment. Then prints the exact comment
// markdown the daemon would post, built by the production `renderQaMediaSection`.
//
// Run from the repo root:  node scripts/proof-task58-media.mjs
// Requires: ffmpeg + ffprobe on PATH, and `pnpm build` already run (imports compiled dist).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { transcodeWebmToGif, GIF_MAX_BYTES } from '../packages/qa/dist/transcode.js';
import { renderQaMediaSection } from '../packages/github/dist/pr-content.js';

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const qaDir = join(repoRoot, '.awb', 'qa');
const webm = join(qaDir, 'recording.webm');
const gif = join(qaDir, 'recording.gif');

async function dims(path) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', path,
  ]);
  return stdout.trim();
}

await mkdir(qaDir, { recursive: true });

// 1. Real 1280x720 test-pattern WEBM (wider than the 640px cap so the downscale is real).
await execFileAsync('ffmpeg', [
  '-y', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=3',
  '-c:v', 'libvpx-vp9', '-b:v', '1M', webm,
]);

// 2. Real transcode through the production code path.
const result = await transcodeWebmToGif(webm, gif);

const webmSize = (await stat(webm)).size;
const gifSize = (await stat(gif)).size;
const gifDims = await dims(gif);

console.log('TASK-58 media artifacts generated:');
console.log(`  .awb/qa/recording.webm  ${(webmSize / 1024).toFixed(0)} KB  (1280x720 source)`);
console.log(`  .awb/qa/recording.gif   ${(gifSize / 1024).toFixed(0)} KB  ${gifDims}`);
console.log(`  transcode: width cap ${result.width}px, ${result.fps}fps, withinBudget=${result.withinBudget} (cap ${(GIF_MAX_BYTES / 1024 / 1024)}MB)`);
console.log('');

// 3. The exact comment the daemon posts, from the production renderer. The owner/repo/branch match
//    draft PR #5 so the raw.githubusercontent URL resolves once the files are pushed.
const comment = renderQaMediaSection({
  ref: { owner: 'Borghese-Gladiator', repo: 'agent-workbench' },
  branch: 'timothyshee/group-d-pr-quality',
  qaSummary: 'TASK-58 proof: recording transcoded to a downscaled GIF and embedded inline.',
  items: [
    { kind: 'qa-video-gif', repoPath: '.awb/qa/recording.gif' },
    { kind: 'qa-video', repoPath: '.awb/qa/recording.webm' },
  ],
});
console.log('--- QA-media comment (renderQaMediaSection) ---');
console.log(comment);
