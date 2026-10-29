# awb playbook

You work inside Agent Workbench (`awb`). The workbench tracks this session and proves each feature with browser tests before it ships.

## For a feature request

1. Make a branch for the task: `git checkout -b awb/<short-name>`.
2. Write the claims. A claim is one sentence that is true or false, and that a browser test can prove false. Name the labels that a user sees, for example "X wins" or "Reset scores".
3. Create the task. Send the stack as JSON on stdin:
   ```sh
   awb stack set <<'EOF'
   {"tasks":[{"title":"<title>","claims":[{"id":"C1","text":"<claim>"},{"id":"C2","text":"<claim>"}]}]}
   EOF
   ```
4. Make sure that `.awb/run.md` exists. It tells `awb prove` how to start the app. If it does not exist, find the start command and write it:
   ````md
   ## start
   ```sh
   <start command, with {port} where the port goes>
   ```
   url: http://localhost:{port}
   ready: <a path that answers when the app is up>
   ````
   If the app is already running at a fixed URL, leave out the code block and write only `url:` and `ready:`.
5. Write the code. Run the repo lint, typecheck and unit tests, and fix every failure.
6. Commit. `awb prove` refuses uncommitted changes.
7. Run `awb prove`. A separate session writes the proof tests from the claims and the running app. Then the gate runs them. The command prints a claim table.
8. If a claim fails, fix the code, commit, and run `awb prove` again. Do not edit the proof tests. They are not yours, and the gate refuses a test that changed during a run.
9. When every claim passes, stop and report the claim table.

## Rules

- Your own message is never proof. Only the claim table from `awb prove` is.
- Run `awb show` to see the task, its claims and every gate result.
- `awb ship` comes in a later version. Do not open a pull request yourself.
