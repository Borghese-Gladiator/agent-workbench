# @awb/qa

## Purpose

Four real QA executors (product spec §23): browser, CLI, HTTP API, and
library. Consumer-level QA, not just automated unit tests — every executor
produces both a real recording/trace artifact AND structured, typed
assertion results; **a video alone never passes QA**.

## Responsibilities

- `browser-qa.ts` — `runBrowserQa()`: real `chromium.launch()`, scripted
  steps (navigate/click/type/waitForSelector/waitForText/screenshot/
  ariaSnapshot), real video recording + Playwright trace, console-error and
  failed-network-request capture.
- `cli-qa.ts` — `runCliQa()`: real process execution via `@awb/execution`'s
  `runCommand`, structured expectations (exit code, stdout/stderr contains).
- `http-api-qa.ts` — `runHttpApiQa()`: real `fetch` calls, structured
  per-request expectations (status, body contains, header equals);
  Authorization/Cookie/Set-Cookie header values are redacted to
  `"[redacted]"` before storage.
- `library-qa.ts` — `runLibraryQa()`: writes a disposable consumer script to
  a temp dir outside the source tree, runs it via real `node`, parses
  `ASSERT:<name>=true|false` marker lines from stdout as structured
  assertions.
- `shared.ts` — `QaAssertionResult` and `produceQaEvidence()`:
  `deriveQaStatus()`'s precedence is executionErrored → `"inconclusive"`
  (an error means assertions never got a fair run) → any failed assertion
  → `"failed"` → missing required artifact → `"inconclusive"` → otherwise
  `"passed"`. This single function is the only place pass/fail is decided.

## MVP scope limitations (documented, not hidden)

- CLI/library "terminal recording" is a plain text transcript, not an
  ANSI-rendered video — sufficient for the MVP's non-interactive scenarios;
  a real PTY-based terminal video is future work if an interactive CLI
  scenario needs it.
- Library QA only runs JS/TS consumer scripts via `node`; Python consumer
  execution is out of scope for the MVP.
- HTTP QA redaction covers Authorization/Cookie/Set-Cookie header values
  only — not the full secret-scanning sweep described in product spec §28
  (that's `@awb/github`'s job before PR upload).

## Does NOT

- Mock Playwright, child_process, or fetch/http in its own tests — every
  test in this package drives real execution (real chromium, real
  processes, a real local `node:http` fixture server), which is the whole
  point given this rebuild's explicit goal of making QA evidence
  non-optional and non-RNG (see `archive/README.md`).

## Dependencies

`@awb/domain`, `@awb/evidence`, `@awb/execution`, `playwright`.
