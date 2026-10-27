# QA log

> Append-only record of QA passes against this run. Each pass updates the run
> status to `qa` (via `scripts/qa-pass.sh`) and adds an entry below.
>
> Format per entry:
>
> ## QA-N — YYYY-MM-DD
> **Tester:** name / agent.
> **Build under test:** branch + commit SHA (from the worktree).
> **Scope:** which parts of the QA plan were exercised.
> **Findings:**
>   - [ ] description (severity: blocker | major | minor | nit)
> **Result:** pass | pass-with-followups | fail.
> **Follow-ups:** linked issues / new run IDs if any.

<!-- entries below -->
