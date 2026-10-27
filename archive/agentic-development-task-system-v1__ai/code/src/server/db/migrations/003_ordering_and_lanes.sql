-- v0.3.7 — ordering, lanes, batches, single-parent dependencies
--
-- depends_on_id is a SOFT reference — no FK — so bulk-create envelopes can
-- arrive in any order (chokidar does not guarantee emit order matches write
-- order). The ready_to_start derivation in listWorkItems tolerates missing
-- predecessors and recomputes once the row appears.

ALTER TABLE work_items ADD COLUMN lane TEXT;
ALTER TABLE work_items ADD COLUMN batch_id TEXT;
ALTER TABLE work_items ADD COLUMN depends_on_id TEXT;

ALTER TABLE epics ADD COLUMN batch_id TEXT;

CREATE INDEX idx_work_items_batch   ON work_items(batch_id);
CREATE INDEX idx_work_items_lane    ON work_items(lane);
CREATE INDEX idx_work_items_depends ON work_items(depends_on_id);
