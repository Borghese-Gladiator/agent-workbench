# Review

<!--
Adversarial self-review against brief.md + plan.md.
The reviewer is not the builder.
-->

## Decision

<!-- One of: approve, request_changes, block. -->

## Did the implementation satisfy the brief?

## Did it accidentally expand scope?

## Are there fragile assumptions?

## Are there missing tests?

## Are there security / data loss / migration risks?

## What should the human review first?

## Blast radius

<!--
Pass-2 (B4). Read `runs/<id>/stages/5_validating/blast-radius.txt`. The
generator in `lib/validate_context.py` already computed the depth-1/2/3
caller tree from `git diff` + `git grep` during `validate --init`.

Summarize anything notable here. Flag any depth-2/3 file that lives OUTSIDE
the brief's expected scope as a scope-creep risk. The CLI handles depth-1
scope creep automatically (see "Scope creep check" below if it appears);
your job is the deeper reach.
-->

## Findings

### F-001
- **Severity**: blocking | major | minor
- **Where**:
- **Issue**:
- **Suggested fix**:
