# Run file for awb itself

## setup
```sh
npm ci
```

## start
```sh
AWB_HOME="$(mktemp -d)" AWB_PORT={port} AWB_NOTIFY=0 AWB_SYNC_MS=3600000 exec node --disable-warning=ExperimentalWarning packages/daemon/src/main.ts
```
url: http://127.0.0.1:{port}
ready: /health

## test
```sh
node --test --disable-warning=ExperimentalWarning --test-reporter=junit --test-reporter-destination={report} {tests}
```
