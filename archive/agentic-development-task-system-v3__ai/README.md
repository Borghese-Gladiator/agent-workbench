# Agentic Development Task System V2
When implementing features with Agent Harnesses, I encountered these issues:
- multiple sessions for same task
- no artifacts what decisions were made and why
- copy-pasting prompts to redo context about an issue
- manual QA to validate AI generated code
- first draft implementations were utterly terrible and required significant reworking and hand holding.

This project was built to address these:
- audit trail - exact reasons for changes
- auto QA - stage specific for E2E testing
- opinionated development workflow
  - See [docs/lifecycle.md](docs/lifecycle.md)

Architecture shape at a glance: see [architecture.md § Classification](architecture.md#classification).

See [docs/README.md](docs/README.md) for more info


## Goals
- easy to prototype new repos
- easy to edit legacy repos
- easy to update agent workbench logic
- easy to view logs and understand what went wrong in implementation
