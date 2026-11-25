# Plan: a repo is an argument, not a property of the session

## Brief

Today `awb` binds a session to one repo. It reads the repo from the current directory, and it stops when the directory is not in a git repo.

The new rule: each `awb` command takes the repo it works on. A session can start in any directory, for example `~/Klaviyo/Repos`. The session picks the repo for each task. The daemon already stores the repo for each stack and task, so it does not change.

Use case: the user gives a Sentry issue. The session finds the repo (`app`, `k-repo`, or `fender`), proves the fix there, and opens a draft PR in that repo.

## Changes

1. `packages/cli/src/main.ts`
   - Add the global flag `-C <dir>`, as in `git -C`. Remove it from `rest` at start, so `positional()` does not read it.
   - `here()` calls `gitInfo` on the `-C` directory, or on the current directory when the flag is absent. Then `stack set`, `prove`, `ship`, `run`, and `show` work from any directory.
   - `launch()`: when `gitInfo` fails, do not stop. Start the session with the current directory as scope. Set `repo` and `worktree` to the directory and `branch` to an empty string.
2. `packages/cli/src/launch.ts`
   - `gitInfo` stays. Add `scopeInfo(cwd)`, which returns `gitInfo` or the scope fallback.
   - `systemPrompt`: when the session has no repo, add a list of the files in `$AWB_HOME/repos/*.md` instead of one "Rules for this repo" section. The playbook tells the session to read the file for the repo it picks.
   - `awbSettings`: add the session directory to `additionalDirectories`, so Claude can edit repos below it.
3. `packages/daemon/src/server.ts`
   - Let `branch` be an empty string in `POST /api/sessions`. The check at line 69 rejects it today.
4. `packages/cli/playbook.md`
   - Add the section "Work in more than one repo". It tells the session to:
     - pick the repo from the task, or from the Sentry stack trace paths;
     - make a worktree with the `worktrees` plugin skill;
     - run every `awb` command as `awb -C <worktree> <command>`;
     - read `$AWB_HOME/repos/<repo>.md` and `<repo>.run.md` for that repo.
5. `packages/cli/src/help.ts`: document `-C`.
6. `packages/cli/plugin/skills/fix` and `triage`: remove the one-repo assumption, if the skills have one. Add the Sentry-to-repo step.
7. Per-repo setup, by hand, outside the code: `~/.awb/repos/{app,k-repo,fender}.run.md` with a `## test` section, and the rules file for each repo.

Not changed: the daemon store, the runner, the gate, `prove`, `ship`.

## Tests

### Unit

- `launch.test.ts`: `scopeInfo` returns the repo in a git directory and the fallback in a plain directory.
- `launch.test.ts`: `systemPrompt` for a session with no repo lists the rules files and has no "Rules for this repo" section.
- `launch.test.ts`: `awbSettings` has the session directory in `additionalDirectories`.
- A new `packages/cli/test/cflag.test.ts`: `-C <dir>` is removed from the argument list, and the next argument is not read as a positional value.
- `store.test.ts`: `register` accepts an empty branch.

Run: `node --test packages/cli/test packages/daemon/test`

### Manual (backend: Python script)

A script `scratch/multirepo_check.py` does these steps in two temporary git repos below one parent directory:

1. Start the daemon with a temporary `AWB_HOME`.
2. From the parent directory, run `awb -C repo_a stack set` and `awb -C repo_b stack set` with one claim each.
3. Run `awb tasks --json` and assert that the two tasks have two different `repo` values.
4. Run `awb -C repo_a show` and assert that it returns the task of `repo_a` only.
5. Start `awb` in the parent directory with `AWB_CLAUDE=/bin/true`. Assert exit code 0 and one session with an empty branch.

Then one real run by hand: start `awb` in `~/Klaviyo/Repos`, give it one Sentry issue URL for `fender`, and check that a draft PR opens in `fender`.
