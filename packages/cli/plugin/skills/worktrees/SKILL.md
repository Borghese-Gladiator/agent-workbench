---
name: worktrees
description: Use when you create, enter, resume or remove a git worktree for any repo. Puts each worktree in ~/LOCAL_worktrees/<repo>/<branch>, runs the setup, and checks that tools use the worktree source and not the main checkout.
---

# Worktrees

Say at the start: "Using the worktrees skill to make an isolated workspace."

## Where a worktree goes

`~/LOCAL_worktrees/<repo name>/<branch, with / changed to ->`

Examples:
- `~/Klaviyo/Repos/app`, branch `awb/sentry-prod-1a2b` → `~/LOCAL_worktrees/app/awb-sentry-prod-1a2b`
- `~/GitHub/agent-workbench`, branch `fix/x` → `~/LOCAL_worktrees/agent-workbench/fix-x`

The folder is outside every repo, so no repo needs a `.gitignore` entry. Never put a worktree inside the repo: it adds files to `git status` and to the IDE file watchers.

The daemon keeps its own task worktrees in `$AWB_HOME/worktrees/`. Do not touch them. This skill is for the worktrees that you make in the chat.

## Make or resume a worktree

1. Find the repo root. It is the parent of the `.git` folder that this command prints:
   ```sh
   git rev-parse --path-format=absolute --git-common-dir
   ```
   The repo name is the last part of the repo root path.
2. If the target path exists, go to step 4. The same steps resume a worktree.
3. Make the worktree. Run `git fetch origin` first. Then use the first case that applies:
   - The branch exists locally: `git worktree add <path> <branch>`
   - The branch exists only on origin: `git worktree add --track -b <branch> <path> origin/<branch>`
   - The branch is new: `git worktree add --no-track -b <branch> <path> origin/HEAD`. The first push needs `git push -u origin <branch>`.
4. Enter it with `EnterWorktree({path: "<path>"})`. Do not use `cd`: the shell goes back to the launch folder after a `cd` outside it, and later commands then run in the wrong repo. If you are in a worktree already, run `ExitWorktree({action: "keep"})` first.
5. Run the setup:
   - If `.awb/run.md` has a `## setup` block, run it.
   - Else, find it from the repo: `package-lock.json` → `npm ci`; `yarn.lock` → `yarn install`; `pnpm-lock.yaml` → `pnpm install`; a Python repo → its documented install (for `app`, see the gotchas).
6. Check and report:
   ```sh
   pwd
   git branch --show-current
   git log --oneline -3
   ```
   Report the path and the branch name. They are different when the branch has a `/`.

## Check that tools use the worktree source

Some repos have entry points with absolute paths to the main checkout. Then a test in the worktree runs the code of the main checkout. Before you trust a test result in a worktree, print the file of the module under test:

```sh
python -c "import <module>; print(<module>.__file__)"
```

The path must be in the worktree. If it is in the main checkout, fix the command (for example, set `PYTHONPATH=<worktree>/src` and run `python -m pytest` with the venv Python, not the wrapper script). Do not continue with a wrong path.

## Remove a worktree

Run these from the main repo, not from the worktree:

```sh
git worktree remove <path>
git worktree prune
git worktree list
```

`git worktree remove` refuses when the worktree has changes. Do not add `--force` unless the user asks.

## Gotchas

- **`app` (`~/Klaviyo/Repos/app`).** `bin/pytest` uses the venv and `src` of the main checkout. It also stops with "WRONG SOURCE TREE" when `import app` resolves to another tree. Use the import check above, and run the venv Python with `PYTHONPATH=<worktree>/src`.
- **direnv.** A new Bash call does not keep the env of the call before it. Run `direnv allow .` once. Then run `direnv export bash` and put the values that you need (`VIRTUAL_ENV`, `PATH`) before each command.
- **fender.** Load direnv first, as above. Then run `yarn install`.
- **Wrong folder.** Before each git command that changes state, run `pwd` and `git branch --show-current`.
- **A WorktreeCreate hook.** Your settings can have a hook that moves `EnterWorktree({name})` worktrees. This skill uses `git worktree add` and `EnterWorktree({path})`, so the hook does not apply.
