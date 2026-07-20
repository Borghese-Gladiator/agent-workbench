# Build — Hello command

## What changed

Added a `hello` case to `bin/cli` that prints `hello, world`.

## Files changed

- `bin/cli`

## Documentation touched

- (none — this is a tiny addition; no doc updates required)

## Acceptance criteria coverage

| AC    | Status  | Notes                                  |
|-------|---------|----------------------------------------|
| AC-1  | covered | Manual run exited 0.                   |
| AC-2  | covered | Stdout matched `hello, world` exactly. |
