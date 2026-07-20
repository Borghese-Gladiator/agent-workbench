# @awb/repository-map

## Purpose

Builds a structured map of a repository's units, top-level symbols, and
shallow import/dependency edges, using tree-sitter.

## Responsibilities

- `buildRepositoryMap(rootDir, headSha, cache?)` — the single public entry
  point; returns `{ units, symbols, unitDependencies, importGraph, cacheKey }`.
- `symbols.ts` — top-level function/class/interface/type/const extraction
  for TypeScript and Python source files.
- `imports.ts` — shallow, same-repository-tree import/require edge
  extraction (direct imports only, no transitive resolution).
- `cache.ts` — pure `cacheKey()` construction (repository SHA + per-file
  content hash + tool version + grammar version) and a pluggable
  `RepositoryMapCache` interface (in-memory implementation included; the
  daemon wires a real filesystem-backed cache under
  `~/.agentic-workbench/cache/repositories/`).

## Does NOT

- Use native `tree-sitter` bindings — they fail to compile against Node 24's
  C++20 V8 headers on this machine (`binding.gyp` hardcodes `-std=c++17`).
  Uses `web-tree-sitter` (WASM) + `tree-sitter-wasms` (prebuilt grammars)
  instead. Revisit if/when the native package fixes this upstream.
- Build a full call graph or resolve types — flat per-file symbol extraction
  is deliberately the ceiling for this MVP (product spec: "does not need to
  be a full call-graph or type-resolution system").
- Persist anything — callers decide whether/how to cache or store the map.

## Dependencies

`@awb/domain`, `web-tree-sitter`, `tree-sitter-wasms`.
