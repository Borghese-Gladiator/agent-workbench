# Go: setup

Applies when: setting up a Go project locally; about to install or upgrade Go itself.

Do:

- Use Go modules (`go.mod` at the module root). Pin the `go` directive to the version CI uses.
- Install Go via the platform package manager or `goenv`; never overwrite the system Go arbitrarily.
- Run `go env GOROOT GOPATH` to confirm you're using the version you expect.
- Prefer repo-local scripts (`bin/build`, `Makefile`) for orchestration.
- For multi-module repos, use a Go workspace (`go.work`) instead of replace directives.

Do not:

- Do not commit `go.work.sum` if the team has agreed it's local-only (check `.gitignore`).
- Do not check in vendored deps unless the repo uses `vendor/` deliberately.
- Do not edit `go.mod` by hand for version bumps; use `go get`.
- Do not assume `$GOPATH/bin` is on `PATH`; check before suggesting `go install`.

Commands:

```bash
go version
go env GOROOT GOPATH

# Detect module + Go version
head go.mod

# Workspace inspection
cat go.work 2>/dev/null
ls Makefile bin/ 2>/dev/null
```
