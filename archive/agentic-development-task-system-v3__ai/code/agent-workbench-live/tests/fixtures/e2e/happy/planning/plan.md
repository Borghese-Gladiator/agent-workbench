# Plan — Hello command

## Current repo understanding

Throwaway repo with a `bin/cli` shell script.

## Proposed changes

Add a new `hello` case to the script's dispatch.

## Files likely to change

- `bin/cli`

## Test plan

Run the command directly and check exit code + stdout.

## Preflight

- repo_path: (filled by CLI evidence)
- base_ref: main
- branch_name: agent/<slug>

OK.

## Decisions & assumptions

### ASM-001
- **Text**: The repo uses Bash, not POSIX sh.
- **Reason**: Existing scripts use `[[ ... ]]`.
- **Impact**: low

### DR-001
- **Decision**: Dispatch via a case statement on the first argument.
- **Rationale**: Matches the existing pattern in `bin/cli`.
- **Alternatives considered**: Argument-parsing library.
- **Why not the alternatives**: Would introduce a dependency.
