# Go: dependencies

Applies when: adding, removing, or upgrading a Go dependency.

Do:

- Add via `go get <pkg>@<version>` (pin a specific version, don't rely on `latest`).
- Run `go mod tidy` after adds / removes; commit `go.mod` and `go.sum` together.
- Use a major version suffix in the import path for `v2`+ modules (`example.com/foo/v2`).
- Prefer the standard library before reaching for a dependency.
- Review `go.sum` diffs — unexpected transitive bumps can hide breaking changes.

Do not:

- Do not edit `go.sum` by hand. Regenerate it.
- Do not depend on `master` / `main` for production code; pin a tag or commit SHA.
- Do not vendor selectively. If the repo uses `vendor/`, regenerate the whole tree.
- Do not add a dependency for a one-line utility you can write in the standard library.

Commands:

```bash
go get example.com/pkg@v1.4.0
go mod tidy

# Audit
go list -m all | head -20
go mod why example.com/pkg
git diff go.mod go.sum
```
