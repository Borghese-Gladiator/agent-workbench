---
title: Add a unit test for the hello subcommand
motivation: Manual QA covered the happy path; pin it with a real test.
suggested_scope: One bats or shell test; no behavior change.
category: tech_debt
---

The hello subcommand is currently smoke-tested by hand; a unit test would
catch regressions.
