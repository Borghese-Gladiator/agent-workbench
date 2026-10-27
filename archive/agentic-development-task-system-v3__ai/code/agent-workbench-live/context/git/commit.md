# Git: commit

Applies when: about to run `git commit`.

Do:

- One logical change per commit. If you can't summarize it in the subject line, split it.
- Imperative subject ≤70 chars: `add foo`, `fix bar parsing`, not `added foo` or `bar fixes`.
- Multiline bodies via HEREDOC so newlines survive. Blank line between subject and body.
- Stage explicit paths (`git add path/to/file`) over `git add -A`; the latter sweeps in junk.
- Run the suite before commit if hooks don't.
- Prefer a follow-up commit over `--amend`. Reversibility > tidiness.

Do not:

- Do not `git commit --no-verify` without explicit approval. Hooks exist for a reason.
- Do not amend a commit that's already pushed unless the user has explicitly asked.
- Do not commit secrets, `.env` files, generated artifacts, or vendored binaries.
- Do not chain `git add` and `git commit` with `&&`; run them as separate commands so failures surface.

Commands:

```bash
git status --short
git add path/to/file path/to/other

git commit -m "$(cat <<'EOF'
subject line — imperative, ≤70 chars

Optional body. Explain why, not what — the diff shows what. Wrap at 72.
EOF
)"
```
