# @awb/github

## Purpose

Deterministic GitHub delivery: push, draft PR create/
update, evidence-matrix comment, PR-feedback classification, and the
interfaces for merge/close tracking and video upload.

## Responsibilities

- `github-client.ts` / `real-github-client.ts` — `GitHubClient`, a narrow
  interface over exactly the operations this package needs (create/update
  PR, post comment, get PR status, list comments), backed by a real
  `@octokit/rest` instance. Deliberately narrow rather than the full
  Octokit surface, so tests can implement the same interface with an
  honest in-memory fake instead of mocking Octokit's internals.
- `push.ts` — `GitPushRunner`/`realGitPushRunner`: shells out to the local
  `git` CLI to push a branch (git-protocol operation, not a GitHub API
  call — Octokit never pushes commits).
- `delivery.ts` — `deliverToGitHub()`: push → create-or-update draft PR →
  post evidence matrix. Force-pushes (with lease) only on PR updates, never
  on first delivery.
- `evidence-matrix.ts` — `renderEvidenceMatrix()`: pure Markdown table
  formatting from `Evidence[]` + candidate SHA.
- `feedback-classification.ts` — `classifyFeedback()`: the six categories
  (question/implementation-defect/plan-defect/contract-
  clarification/non-blocking-suggestion/out-of-scope), plus
  `feedbackRequiresHumanGate()`/`canAutoLoop()` implementing "only a clear,
  unambiguous implementation defect with no routing signal may auto-loop."
- `pre-upload-checks.ts` — `runPreUploadChecks()`: hash verification, size
  limit, a likely-secret pattern scan (private keys, cloud/GitHub/Slack/
  OpenAI-style tokens, DSNs with embedded credentials), and a public-repo
  warning flag (warns, does not block) — the pre-upload checklist.
- `media-uploader.ts` — `GitHubMediaUploader` **interface only**. GitHub's
  public API has no general binary-attachment endpoint for PR comments, so
  the real implementation (narrow Playwright automation against an
  already-authenticated GitHub web session) is intentionally NOT built in
  this milestone — it requires a real authenticated browser session and a
  real target PR to test meaningfully, which this package's automated test
  suite must never do (see "Test safety" below). Building and manually
  verifying the real implementation is tracked separately.
- `types.ts` — shared request/response shapes.

## Test safety — read before touching this package

The developer's local `gh` CLI is authenticated with broad `repo`/
`workflow` scopes. **This package's test suite must never make a real
GitHub API call or a real `git push`.** Every test uses `FakeGitHubClient`/
`FakeGitPushRunner` (`test-fakes.ts`) or a hand-built fake shaped like
Octokit's relevant methods (`real-github-client.test.ts`) — never a real
`Octokit` instance, never `realGitPushRunner` against a real remote. If you
add a test to this package, it must follow the same pattern.

## Does NOT

- Decide phase completion — its outputs feed the Release-phase completion
  criteria in `@awb/workflow`'s `evaluatePhaseCompletion`.
- Poll for PR merge/close status on its own schedule — `GitHubClient.getPrStatus`
  is called by the caller (an Activity) on its own polling cadence.

## Dependencies

`@awb/domain`, `@awb/evidence`, `@octokit/rest`.
