# Run file for awb itself

## setup
```sh
npm ci
```

## seed
The daemon has two stacks. The first is in repo /tmp/seed-repo with two tasks. "Seed done task" is done, and its gate passed. "Seed failed task" is failed: its gate has C1 PASS and C2 FAIL. The second is in repo /tmp/seed-repo-2 with one task, "Seed waiting task", that has status waiting. That stack has no failed task. The third is in repo /tmp/seed-repo-3 with two tasks: "Seed merged task" has status merged and "Seed closed task" has status closed. One ended session on branch awb/seed-done has Bash and Edit tool events and a cost of 0.42 USD.
```sh
node --disable-warning=ExperimentalWarning e2e/seed.ts {seed}
```
key: e2e/seed.ts packages/daemon/src/store.ts packages/daemon/src/stacks.ts

## start
```sh
AWB_HOME={seed} AWB_PORT={port} AWB_NOTIFY=0 AWB_SYNC_MS=3600000 exec node --disable-warning=ExperimentalWarning packages/daemon/src/main.ts
```
url: http://127.0.0.1:{port}
ready: /health

## test
```sh
node --test --disable-warning=ExperimentalWarning --test-reporter=junit --test-reporter-destination={report} {tests}
```
