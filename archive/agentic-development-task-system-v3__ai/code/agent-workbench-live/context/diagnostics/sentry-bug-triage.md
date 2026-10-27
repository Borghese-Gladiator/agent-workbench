# Diagnostics: Sentry bug triage

Applies when: triaging a Sentry-reported error (URL, ID, or pasted stack trace).

Do:

- Identify the project, environment, and release the error came from. They're in the issue header.
- Note frequency and impact: events / day, users affected, when it started. A spike-on-deploy is a different bug than a slow drift.
- Find the **first in-repo stack frame** (skip framework and stdlib frames). That's where you start reading.
- Correlate the start time with recent deploys, dependency bumps, or feature flag flips.
- After root-cause, add a regression test that fails on `master` and passes with the fix. Reference the Sentry issue ID in the docstring.
- Use CODEOWNERS to identify the responsible team before assigning; ping them with the in-repo frame, not the Sentry URL.

Do not:

- Do not assume the top stack frame is the bug. Frameworks raise where they detect, not where the bug is.
- Do not close a Sentry issue without explaining the resolution. Future you will want the trail.
- Do not log sensitive data (PII, tokens) when adding diagnostic logging — that just creates a new incident.
- Do not depend on a Sentry CLI / API / SDK to do triage. The web UI is the source of truth.

Commands:

```bash
# Identify the team owning the first in-repo frame
git log -1 --format="%an %ae" -- path/to/file.py

# Correlate with recent deploys
git log --since="7 days ago" --oneline --first-parent main

# Confirm the bug exists on master before fixing it
git checkout main
# reproduce the failing scenario
```
