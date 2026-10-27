"""Live task board package.

Stdlib-only modules (`source`, `snapshot`) read runs/ and produce frozen
snapshots. The Textual app (`app`) renders them; it is imported lazily by
`cmd_board` so the rest of the CLI stays stdlib-only.
"""
