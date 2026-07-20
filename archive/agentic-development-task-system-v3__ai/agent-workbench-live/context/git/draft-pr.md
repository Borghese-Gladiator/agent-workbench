# Git: draft PR

Applies when: ready to surface a feature branch to humans for review.

Do:

- Inspect the diff yourself first: `git diff <base-ref>...HEAD`. If you wouldn't merge it, don't open the PR.
- Run validation + tests locally before opening. CI is not for shaking out obvious failures.
- Open as **draft** when work is incomplete, blocked, or carrying known issues. Mark ready only when you'd merge it.
- Body = `## Summary` (1–3 bullets, why) + `## Test plan` (checklist of what was verified).
- Reference issues or run IDs in the body, not the title. Keep titles ≤70 chars and imperative.
- Push to a feature branch, never directly to `main`.

Do not:

- Do not force-push to `main` / `master` ever. Refuse and surface the request.
- Do not open a PR before running tests locally; CI catches the rest, not the basics.
- Do not bury known issues in commit messages — list them under `## Known issues` in the PR body.
- Do not delete the source branch from inside the PR; let merge cleanup handle it.

Commands:

```bash
git diff <base-ref>...HEAD --stat
git push -u origin <branch>

gh pr create --draft --title "<imperative summary>" --body "$(cat <<'EOF'
## Summary
- <why this PR exists>

## Test plan
- [ ] unit tests pass
- [ ] integration tests pass
- [ ] manual smoke described in run handoff

## Known issues
- <if any>
EOF
)"
```
