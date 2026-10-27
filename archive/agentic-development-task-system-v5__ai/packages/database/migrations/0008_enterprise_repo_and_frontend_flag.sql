-- isEnterpriseRepo: auto-classified at registration from canonicalPath against configured
-- enterpriseRepoRoots (see WorkbenchConfig). Enterprise repos skip snapshot-time discovery
-- steps that are pointless for them (command discovery, the frontend heuristic below).
ALTER TABLE repositories ADD COLUMN is_enterprise_repo INTEGER NOT NULL DEFAULT 0;

-- hasExistingFrontend: computed once per snapshot from unit-kind detection (kind = 'web').
-- Lets the planner decide whether a from-scratch UI slice should be pointed at the
-- `build-ui` skill without re-scanning the repo at plan time.
ALTER TABLE repository_snapshots ADD COLUMN has_existing_frontend INTEGER NOT NULL DEFAULT 0;
