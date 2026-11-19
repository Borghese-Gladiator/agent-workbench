# TODO

## Flaky unit test

One unit test fails in some runs of `npm test`. It passes when the same code runs again.

### What we know

- The failure shows `code: 'ERR_ASSERTION'` and `operator: 'throws'`.
- It failed in 2 of about 9 runs on 2026-11-19.
- The two failures happened when another suite ran at about the same time: first the browser suite, then a second `npm test` that started right after it.
- The next 4 runs passed in a row (266 tests). The code did not change between a failing run and a passing run.
- The pre-commit hook runs `npm test`. A failure in the hook stops the commit. A second commit attempt passed.

### What we do not know

- The name of the failing test. The output was not saved in either failing run.
- The cause. One guess is a port clash: some tests start a real daemon, and the browser suite starts one as well. We did not test this guess.

### Next steps

1. Run `npm test` many times, one run at a time, and save the output of each run to a file. Look for a run with `fail` above 0, and find the test name in that file.
2. Run `npm test` while `npm run e2e` runs. If the failure appears often, the cause is shared ports or shared state.
3. When the test is known, fix its cause. Do not add a retry.
4. Until then, if the pre-commit hook fails on a test that your change did not touch, run the commit again.
