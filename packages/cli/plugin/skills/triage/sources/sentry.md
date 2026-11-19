# Source: Sentry

The `triage` skill loads this file for a Sentry item. Use the report format below for one item. Map the result to a `triage` verdict: a code fault is `fix`, a third-party or infra fault is `skip` or `route`.

Given a Sentry issue, produce a short triage report that answers:

> **What broke, how bad is it, what repo/files/team(s) own it, and who should look at it first?**

The point is routing + first-pass severity, not root-cause analysis or a fix.

## When to use

- User pastes a Sentry URL and asks any variant of: "triage this", "what team owns this", "who should fix this", "which repo", "is this new", "is this a regression", "how bad is this", "investigate this sentry".
- User invokes `/awb:triage <url>`.

Do NOT use this for full root-cause analysis or proposing a fix — that's a follow-up after triage routes it to the right team.

## Inputs

- A Sentry issue URL (e.g. `https://klaviyo-1.sentry.io/issues/6776026978/...`)
- Or a bare issue ID
- Or a Sentry short ID (e.g. `PRODUCTION-HN8S`)

## Step 1 — Fetch the issue

Prefer the Sentry MCP (no auth setup required):

```
mcp__sentry__get_sentry_resource(url="<the sentry URL the user gave>")
```

If MCP is unavailable, fall back to the `sentry-fetch` skill (app repo) or a direct API call with `SENTRY_AUTH_TOKEN`.

From the response, capture and quote verbatim:

- `title`, `culprit`, `transaction` — entry point
- `level`, `status`, `substatus`, `Assigned To`
- `First Seen`, `Last Seen`, `Occurrences`, `Users Impacted`
- `release` tag — relevant for regression check
- `environment`, `service`, `cluster`, `server_name` — blast-radius context
- `Event Details` → the full traceback (every `File "..."` + function + line number)
- `Seer Actionability` if present

You'll need exact paths to grep CODEOWNERS and exact tag values for severity.

## Step 2 — Map frames to repos

Every traceback frame has an absolute path. Classify each frame:

| Path prefix | Repo | CODEOWNERS file |
|---|---|---|
| `/opt/venv/lib/python*/site-packages/klaviyo/...` | **k-repo** | `~/Klaviyo/Repos/k-repo/.github/CODEOWNERS` |
| `/opt/app/...` or `learning/app/...` or `src/learning/app/...` | **app** | `~/Klaviyo/Repos/app/.github/CODEOWNERS` |
| `/opt/venv/...` non-klaviyo (`redis/`, `tenacity/`, `asyncio/`, `sentry_sdk/`, etc.) | third-party | skip — not owned by a Klaviyo team |
| `/usr/local/lib/python*/...` | stdlib | skip |
| TS/TSX from a browser stack | **fender** | `~/Klaviyo/Repos/fender/.github/CODEOWNERS` |
| Matches a directory under `~/Klaviyo/Repos/` (e.g. `segmentation-service/...`, `chariot/...`) | that repo | that repo's `.github/CODEOWNERS` |

For each Klaviyo-owned frame, derive the **repo-relative path** for CODEOWNERS lookup:

- k-repo: strip `/opt/venv/lib/python*/site-packages/` and **prepend `python/`** → e.g. `klaviyo/security/kzit/.../kzit_async_distributed_cache.py` becomes `python/klaviyo/security/kzit/.../kzit_async_distributed_cache.py`. k-repo's CODEOWNERS paths all start with `python/klaviyo/...`.
- app: strip the runtime prefix and use the in-repo path, e.g. `src/learning/app/home/views/recently_sent.py`.

Also derive the **entry-point file** from `transaction` / `culprit`:

- A Django route like `/ajax/home/recently_sent/` → grep `src/learning/_pattern_owners_generated.py` in the app repo for the URL pattern. That file already maps URLs → owning team.
- A Celery task name → grep app for the `@task` registration.

## Step 3 — Look up CODEOWNERS

For each repo-relative path identified in Step 2:

```bash
grep -nE "<dir-prefix>" ~/Klaviyo/Repos/<repo>/.github/CODEOWNERS
```

CODEOWNERS uses **last-match-wins** ordering. When multiple lines match, the **last matching line** is the effective owner — quote that one with `<repo>/.github/CODEOWNERS:<lineno>`. Start with the most specific prefix (deepest directory or exact file) and walk up if no match.

Reference points to keep in mind:

- `python/klaviyo/security/kzit` → `@klaviyo/appsec`
- `python/klaviyo/core/api_client/` → `@klaviyo/internal-apis`
- `/src/learning/app/home/` → `@klaviyo/product-expansion`

If the in-repo `_pattern_owners_generated.py` is more specific than CODEOWNERS for the route, prefer it for the entry-point team.

## Step 4 — Distinguish calling site vs. fault site

A Sentry traceback typically has two interesting teams:

- **Calling site** — the deepest in-app frame (the product view / handler that initiated the call). Owned by the product team.
- **Fault site** — the frame where the exception is actually raised. Often inside a shared library (`klaviyo/...`) owned by a platform team.

If Sentry has auto-assigned a team, note it but don't blindly trust it — auto-assignment usually targets the fault site; the right team(s) to ping often includes both.

When the traceback spans multiple shared libraries (e.g. KZit cache wrapping a `core/api_client` sync→async wrapper), list each library frame with its owner — the *underlying* lib is often where the bug actually lives, not the top wrapper.

## Step 5 — Triage signals (severity + regression)

Compute these from the issue metadata you already have:

### Severity buckets

Pick **one** bucket based on the most severe signal that applies:

- **SEV-HIGH** — any of:
  - `users_impacted > 1000` in a rolling window, OR
  - `occurrences > 10000` and still `lastSeen` within the last 24h, OR
  - `transaction` is a high-traffic core path (login, signup, checkout, send pipeline, billing), OR
  - `level: fatal` or data-corruption signature in the title (e.g. "Integrity", "deadlock", "data loss").
- **SEV-MEDIUM** — recurring (`occurrences > 100`), affects real users (`users_impacted > 10`), but in a non-critical path, OR a freshly-introduced error tied to a recent release.
- **SEV-LOW** — long-tail noise: low volume, few users, status often `ignored`/`resolved` historically, or known flaky infra (e.g. transient Redis disconnects with no user-visible impact).

State the bucket in one sentence, citing the numbers you used.

### Regression vs. chronic

- **Chronic** — `firstSeen` is months/years old and the issue has steady occurrences over time. Not a regression; routing matters more than urgency.
- **Possible regression** — `firstSeen` is within the last ~14 days, OR there's a clear spike in `lastSeen` activity relative to history. Flag the release tag — the assigned team will want to compare against the deploy that introduced it.
- **Unclear** — say so; don't guess.

For a regression check when needed, you can list recent same-fingerprint events:

```
mcp__sentry__search_issue_events(organizationSlug="klaviyo-1", issueId="<short-id>", query="")
```

### Blast radius

One sentence on scope: which environments, which clusters/services, how many companies (look for `company_id` tag distribution if relevant), whether `is_top_account: True` shows up.

## Step 6 — Report

Keep the report short. Structure:

```
## Triage: <Sentry short-id> — <one-line what broke>

**Severity**: SEV-<HIGH|MEDIUM|LOW> — <reason: numbers + path criticality>
**Regression**: <Chronic since <firstSeen> | Possible regression in release <X> | Unclear>
**Blast radius**: <env, cluster/service, users impacted, top-account flag>
**Sentry assignment**: <team Sentry already assigned, or "none">

### What's failing

<2-3 sentences: the exception, the endpoint/transaction, the immediate trigger from the traceback. Quote the deepest in-app frame and the fault frame.>

### Repo: <name> (<calling site | library | fault site>)

- **File**: `<repo-relative path>:<line>` — `<symbol>`
- **CODEOWNERS** (`<repo>/.github/CODEOWNERS:<line>`):
  - `<pattern>` → **@klaviyo/<team>**

(Repeat per repo involved.)

### Teams

- **@klaviyo/<team-A>** — <one-line role: "owns the calling view", "owns the failing async cache", etc.>
- **@klaviyo/<team-B>** — <role>

**First ping**: **@klaviyo/<team>** — <reason grounded in the traceback and severity, e.g. "fault site is in their library and severity is HIGH">.
```

## Rules

- **Quote, don't paraphrase.** Every team attribution must cite a CODEOWNERS line (`<repo>/.github/CODEOWNERS:<lineno>`) or an in-repo owner-map line. If you can't cite it, don't claim it.
- **Every severity claim cites a number.** Don't say "high impact" without quoting `users_impacted`, `occurrences`, or the criticality of the transaction path.
- **Don't guess at root cause.** One sentence on "likely fix lives in X based on the traceback" is fine; the deliverable is triage, not a patch.
- **Don't read third-party frames as fault sites.** A `redis/asyncio/connection.py` frame is just the symptom — keep walking up until you hit a Klaviyo frame.
- **Multiple teams is the norm.** When the traceback spans repos, list each one. Pick a single first-ping team based on severity + where the bug most likely lives.
- **Don't propose CODEOWNERS edits** unless the user asks.
- **Respect MCP-only rules.** For `linear.app/klaviyo/...` or `klaviyo.atlassian.net/...` links found in the issue, use the corresponding MCP — never curl.

## Output length

Aim for under 350 words. If the traceback is huge, summarize and link to file paths — don't dump the full trace.
