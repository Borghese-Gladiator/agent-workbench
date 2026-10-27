---
name: qa-artifacts
description: Assemble a durable, human-readable proof bundle for a completed QA/E2E run — the test script and its captured output, the browser video+trace paths, and a machine-readable summary with a single PASS/FAIL verdict.
profile: any
---

Produce the durable proof that a feature actually works — the thing unit tests can't
give: a browser recording of the real user flow plus a machine-readable verdict. Every
field must come from a **real side effect**; there is no path to `PASS` without the work
having happened.

This is the second half of the QA stage (after `qa-e2e-playwright` ran the browser).
Project-agnostic: it summarizes whatever the E2E run produced in THIS repo.

## What to collect
- **The E2E run output**: the harness run result — scenarios run, pass/fail per
  scenario (read `$QA_OUTPUT_DIR/results.json`), and the captured stdout/stderr. Never
  summarize away the raw output.
- **Browser video(s) + trace**: the concrete `*.webm` and `trace*.zip` paths under
  `$QA_OUTPUT_DIR` that `qa-e2e-playwright` reported.
  > The daemon copies these files out of `QA_OUTPUT_DIR` into durable storage and appends
  > their stored paths to the `demo_evidence` artifact automatically — you do not need to
  > move them yourself. Just report their paths accurately so the capture finds them.
- **The test spec**: the path to the spec under `$QA_SPEC_DIR`, so a human can re-run it.

## demo_evidence body
Write a clear Markdown report — this IS the `demo_evidence` artifact. Include:
- A one-line **verdict** (PASS only if every scenario passed and a video was produced).
- The scenario table (name → status → the user-visible assertion that proved it).
- The produced video + trace paths (the daemon turns these into durable references).
- The exact command to reproduce (`npx playwright test ...`).

## Output
End with a ```json block echoing the summary:

```jsonc
{
  "scenarios": [{ "name": "...", "status": "passed" }],
  "videoPaths": ["test-results/.../video.webm"],
  "tracePaths": ["test-results/.../trace.zip"],
  "verdict": "PASS"   // PASS only if all scenarios passed AND at least one video exists
}
```

The verdict is the single assertable line: a green QA stage means a real browser drove
the real feature and the recording exists to prove it.
