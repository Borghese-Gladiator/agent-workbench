# Go: quality

Applies when: about to commit, push, or open a PR with Go changes.

Do:

- Run all four before push: `gofmt -l .`, `go vet ./...`, `go test ./...`, `staticcheck ./...` (if the repo uses it).
- Wrap errors with `%w` so callers can `errors.Is` / `errors.As` upward.
- Keep interfaces small (1–3 methods). Define them at the consumer, not the producer.
- Return errors, don't panic. `panic` is for unrecoverable invariants only.
- Use receiver name consistency within a type (`(c *Client)` everywhere, not mixed).

Do not:

- Do not use mutable package-level globals. They prevent testing and cause data races.
- Do not silence `go vet` findings with `//nolint` blanket annotations.
- Do not catch `_` and discard errors. If you don't care, comment why.
- Do not introduce a third-party logger when `log/slog` will do.

Commands:

```bash
gofmt -l .                    # lists unformatted files; empty = good
gofmt -w .                    # rewrite in place
go vet ./...
go test ./...
staticcheck ./...             # if installed
```
