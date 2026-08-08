-- TASK-46: record cache-WRITE tokens, not just cache-read. The SDK reports
-- `cacheCreationInputTokens` per model invocation but the adapter dropped it, so total cached cost
-- was invisible. Additive nullable column; existing rows keep NULL (cache-write unknown for them).
ALTER TABLE model_invocations ADD COLUMN cache_creation_input_tokens INTEGER;
