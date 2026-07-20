# Infra: secrets

Applies when: handling API keys, tokens, passwords, certs, or any credential.

Do:

- Read secrets from environment variables or a secret store; never hard-code.
- Add `.env`, `.envrc`, `*.pem`, `*.key`, `credentials.json` to `.gitignore` before the first commit.
- Use `.env.example` (committed) to show shape; the real `.env` stays local.
- Redact tokens in logs and error messages. Log the first 4 chars + length if you must reference them.
- Rotate any secret that touches your terminal history, a screenshot, or a PR comment.

Do not:

- Do not commit secrets, even briefly. Reverting doesn't unship them from history.
- Do not paste secrets into PR descriptions, issue comments, or commit messages.
- Do not include secrets in test fixtures. Use fakes.
- Do not log a full secret to debug a parsing issue. Log the length and shape.

Commands:

```bash
# Check before commit
git diff --cached | grep -iE 'api[_-]?key|secret|token|password|aws_|bearer' | head

# If a secret slipped in, rotate first, then clean history
git log --all --full-history -- path/to/leaked  # to see how widespread
# (rotate the credential at the provider before cleaning history)
```
