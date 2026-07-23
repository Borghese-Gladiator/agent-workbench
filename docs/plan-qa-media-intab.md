# Plan: cmd+click-to-watch QA media links (no download)

## Brief
Today the release phase uploads QA media as GitHub **release assets** and links them in
PR comments. GitHub signs release-asset URLs with `Content-Disposition: attachment` +
`octet-stream`, so cmd+click always force-downloads — the reviewer must download →
(extract) → open locally. We want links that **open in a browser tab and play/display**.

## What we proved (empirically, on the real repo)
- Release assets: always `rscd=attachment` + `rsct=application/octet-stream` baked into
  the signed URL → forced download. Cannot override.
- User-attachments (github.com/user-attachments): the only native inline player, but the
  upload endpoint is session-cookie + CSRF only; a token gets 422. No REST/GraphQL API.
  Dead for automation.
- **Committing media into the branch works:**
  - PNG via `raw.githubusercontent.com/<owner>/<repo>/<branch>/.awb/qa/x.png` →
    `content-type: image/png`, NO attachment → opens viewable in tab.
  - WebM via the **blob view** `github.com/<owner>/<repo>/blob/<branch>/.awb/qa/x.webm`
    → 200 HTML page with GitHub's native inline `<video>` player → watch in tab.
    (raw for webm is attachment+audio/webm, so use the BLOB url for video.)
  - Trace `.zip`: no viewer exists anywhere → keep as a release-asset download link.

## Changes
1. `packages/github/src/qa-media-commit.ts` (new): `commitQaMediaToBranch({ worktreePath,
   mediaDir='.awb/qa', files: {srcPath, name}[] })` — copies each file into
   `<worktree>/.awb/qa/`, writes a `.awb/qa/.gitattributes` marking `* linguist-generated`
   (so GitHub COLLAPSES these files in the PR diff by default — the machine-readable "ignore
   this"), `git add .awb/qa`, `git commit -m "chore(qa): attach QA media (generated, not part
   of the change)"`. Returns committed repo-relative paths. No-op (returns []) when files empty.
2. `packages/github/src/pr-content.ts`: add `renderQaMediaSection({ ref, branch, items })`
   where each item is `{ kind, repoPath?, downloadUrl?, qaSummary }`:
   - `screenshot` → `![...](raw url)` (inline image, also opens in tab)
   - `qa-video`   → `[▶ Watch recording (in-tab player)](blob url)`
   - `browser-trace` → `[⬇ Download trace — npx playwright show-trace <file>](release download url)`
   Rendered as ONE consolidated comment (or appended to PR body).
3. `workers/temporal-worker/src/activities/run-phase.ts` release handler:
   - Build the media file list INCLUDING the screenshot (currently filtered out).
   - Before `deliverToGitHub` push: `commitQaMediaToBranch` for screenshot + video.
   - Keep uploading the TRACE zip as a release asset (download link).
   - Post ONE consolidated QA-media comment via `renderQaMediaSection` with blob/raw/download
     links. `requiredVideosUploaded` = video+screenshot committed AND (trace upload ok OR no trace).
4. `qa-media-support.ts`: replace the per-file release-asset loop with the commit-then-link flow;
   keep trace-only release upload. Preserve the guard semantics (fail → requiredVideosUploaded=false).

## Tests
### Unit
- `qa-media-commit.test.ts`: given a temp git repo + fake media, commits files under .awb/qa,
  returns repo-relative paths; empty input → no commit, [].
- `pr-content.test.ts`: `renderQaMediaSection` emits a raw `![]()` image link for screenshot,
  a blob-view link for qa-video, a release-download link for browser-trace; omits missing kinds.
- `qa-media-support.test.ts`: update to the new flow — screenshot+video committed & linked,
  trace uploaded & linked; commit failure → requiredVideosUploaded=false, no broken links.

### Manual (live)
- Rebuild worker, fresh task on wip-browser-games, drive to release.
- Confirm the PR has ONE QA comment: screenshot renders inline; "Watch recording" cmd+click
  opens the blob page and plays the webm in-tab (no download); trace link downloads the zip.
- Confirm `.awb/qa/` media is committed on the PR branch in its own commit.
