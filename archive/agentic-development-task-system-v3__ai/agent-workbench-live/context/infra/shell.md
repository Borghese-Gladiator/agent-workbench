# Infra: shell

Applies when: writing or modifying a `.sh` script, or composing a multi-step shell command.

Do:

- Open every script with `#!/usr/bin/env bash` and `set -euo pipefail`.
- Quote every variable expansion: `"$var"`, not `$var`. Same for arrays: `"${arr[@]}"`.
- Use `mktemp` for temp files; `trap ... EXIT` to clean them up.
- Guard destructive deletes with an explicit check: confirm path is non-empty and not `/`.
- Prefer `printf` to `echo` for anything beyond a single literal string.

Do not:

- Do not parse `ls` output. Use a loop or `find -print0` / `xargs -0`.
- Do not chain risky commands with `&&` when a failure in the first should stop the script — `set -e` plus separate lines is clearer.
- Do not write `rm -rf "$var"/` without checking `"$var"` is non-empty.
- Do not interpolate untrusted input into shell strings without sanitizing.

Commands:

```bash
#!/usr/bin/env bash
set -euo pipefail

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

target="${1:-}"
[[ -n "$target" ]] || { echo "missing arg" >&2; exit 2; }

# Guarded delete
[[ "$target" != "/" && -n "$target" ]] && rm -rf -- "$target"
```
