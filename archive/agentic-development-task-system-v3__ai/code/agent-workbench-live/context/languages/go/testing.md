# Go: testing

Applies when: writing, running, or modifying Go tests.

Do:

- Run via `go test ./...` from the module root; package-scoped during development (`go test ./pkg/foo`).
- Use table tests for variations on the same logic (slice of cases + `t.Run(tc.name, ...)`).
- Co-locate tests with code: `foo.go` and `foo_test.go` in the same package.
- Use `t.Helper()` inside assertion helpers so failures point at the call site.
- Use `t.Parallel()` for I/O-bound tests when their setup is independent.

Do not:

- Do not use package globals as test state. Pass state through the test function.
- Do not skip a flaky test with `t.Skip`; fix it or remove it.
- Do not mock the standard library; isolate via interfaces at module boundaries.
- Do not rely on test ordering. Each test must pass in isolation.

Commands:

```bash
go test ./...
go test ./pkg/foo

# Race detector for concurrent code
go test -race ./...

# Coverage
go test -cover ./...
go test -coverprofile=cover.out ./... && go tool cover -func=cover.out
```
