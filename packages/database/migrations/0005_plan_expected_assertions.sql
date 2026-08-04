-- TASK-42: the planner emits expected per-claim QA assertions (the specific state transition to
-- observe). Persist them on the claim-coverage row so the exercise gate can check that an
-- assertion actually exercises each behavioral claim. Additive column; existing rows keep '[]'.
ALTER TABLE plan_claim_coverage ADD COLUMN expected_assertions_json TEXT NOT NULL DEFAULT '[]';
