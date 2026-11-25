# Plan: keep the last pass of a test claim (slice 2, with coverage lists)

## Brief

Slice 1 asked the test writer to list the files that each claim depends on. A writer can miss a file, and a missed file gives a false pass.
This slice replaces the writer list with a measured list.
The proof run sets `NODE_V8_COVERAGE`. Node writes each file that a test process loaded. The list is a fact and not a guess.

A test claim keeps its last pass when all of these hold:

- `passes.json` has a pass for the claim, with a sha, a hash and a non-empty file list.
- The hash of the test file did not change.
- `git diff --name-only <sha>..HEAD` can run.
- `claimsAffected` finds no change in the list. A file that the list misses, a lock file or a config file runs the claim.

`awb prove --all` ignores every kept pass. A rewrite changes the test hash, so the claim runs.

## Changes

1. `packages/daemon/src/claim-files.ts`: `coverageFiles` reads the V8 output. It maps each test file to its claim and lists the repo files that the process loaded. `keptClaims` uses the list that is saved with the pass.
2. `packages/daemon/src/prove.ts`: set `NODE_V8_COVERAGE` for the head run. Save `claim-files.json`. Save the list with each pass in `passes.json`.
3. `packages/daemon/src/writer.ts`: remove the `.files` request from the test writer prompt.
4. `packages/daemon/src/gate.ts`, `task-routes.ts`, `packages/cli`: a kept row and the `--all` flag, as in the first commit of this slice.

## Known limit

Only Node tests give a list. A Python test, or a test that runs in a child process that does not inherit the environment, gives no list.
A claim with no list is never kept, so it runs on every `prove`. The result is a full run, not a false pass.

## Not in this slice

- Browser claims. They always run.
- Carried tasks. They still rerun.
- The base run cache.
- A list for Python tests (for example `coverage.py`).

## Tests

### Unit

- `coverageFiles` lists the files that each test loaded, through an import chain, and skips `node_modules`, `node:` URLs and files outside the repo.
- `coverageFiles` gives nothing for no coverage, or for a file that is not JSON.
- `keptClaims` keeps a claim only when its test and its files did not change. It runs a claim with no recorded files.

### Integration

- `prove` run three times: the list holds the loaded file, an unlisted change runs the claim, no change keeps it, and `--all` runs it.
- `prove` after a change to a loaded file runs the claim, and the gate fails on broken code.

### Manual

Backend. Run a python test script:

1. Run `awb prove` on a task with two test claims. Check that `passes.json` lists the loaded files for both claims.
2. Change a file that only C1 loads. Commit it. Run `awb prove`. Check that C2 reads "kept from <sha>" and that C1 ran.
3. Run `awb prove --all`. Check that no claim reads "kept".
