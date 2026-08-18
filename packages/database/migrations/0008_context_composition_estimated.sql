-- TASK-109: context_composition buckets carry a provenance flag. `estimated` is 1 when the buckets
-- are a chars/4 heuristic (no provider usage to reconcile against) and 0 once they've been scaled to
-- sum to the invocation's measured input tokens. Existing rows predate reconciliation, so 1 is the
-- correct default for them.
ALTER TABLE context_composition ADD COLUMN estimated INTEGER NOT NULL DEFAULT 1;
