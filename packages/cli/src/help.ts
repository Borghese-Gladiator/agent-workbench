export const HELP: Record<string, string> = {
  ui: `usage: awb ui [--no-open]

Start the daemon and print the UI address. Open the UI in a browser.

  --no-open   Print the address. Do not open a browser.`,
  doctor: `usage: awb doctor

Check the setup. Exit with code 1 if a check fails.`,
  daemon: `usage: awb daemon start|stop [--when-idle]|status

  start    Start the daemon. Print its pid and port.
  stop     Stop the daemon.
           --when-idle  Wait until no run, proof or ship is active, then stop.
  status   Print the pid and port. Exit with code 1 if the daemon is not running.`,
  stack: `usage: awb stack set [--json] < stack.json
       awb stack show <stack id> [--json]

  set    Read a stack as JSON on standard input. Send it to the daemon.
  show   Show the tasks and the runs of one stack.

  --json   Print the result as JSON.`,
  stacks: `usage: awb stacks [--json]

List the stacks with their ids, their last run and their task states.

  --json   Print the result as JSON.`,
  limit: `usage: awb limit [n] [--json]

Show or set the number of stacks that run at the same time. The daemon keeps the value in AWB_HOME/config.json.
The value is from 1 to 5. A lower limit never stops a run. It refuses new runs until fewer are left.

  --json   Print the result as JSON.`,
  cleanup: `usage: awb cleanup

Stop the app servers that an earlier proof left running.`,
  prove: `usage: awb prove [--json] [--rewrite a,b]

Run the proof checks.

  --rewrite a,b   Rewrite the listed items.
  --json          Print the result as JSON.`,
  ship: `usage: awb ship [--json]

Ship the work.

  --json   Print the result as JSON.`,
  run: `usage: awb run <stack id | task id> [--json] [--wait] [--retries N]
       awb run --all-stopped [--retries N] [--json]

Start a run for a stack or a task.
With --all-stopped, start again every run that a daemon restart stopped, from its first waiting task.
The setting AWB_AUTORESUME=1 does this when the daemon starts.

  --wait        Wait for the run to end.
  --retries N   Set the number of retries.
  --json        Print the result as JSON.`,
  retry: `usage: awb retry <stack id | task id> [--json] [--wait] [--retries N]

Retry a failed stack or task.

  --wait        Wait for the run to end.
  --retries N   Set the number of retries.
  --json        Print the result as JSON.`,
  stop: `usage: awb stop <stack id | task id> [--after-task] [--json]

Stop a stack or a task.

  --after-task   Let the current task end. Start no next task. The run ends with the reason "stopped by you".
  --json   Print the result as JSON.`,
  show: `usage: awb show <stack id | task id> [--json]

Show the details of a stack or a task.

  --json   Print the result as JSON.`,
  tasks: `usage: awb tasks [--repo R] [--status S] [--since T] [--json]

List tasks.

  --repo R     Show only tasks for this repository.
  --status S   Show only tasks with this status.
  --since T    Show only tasks that start after this time.
  --json       Print the result as JSON.`,
  cost: `usage: awb cost [--since T] [--repo R] [--json]

Show the cost of the runs.

  --since T   Set the start of the period. The default is 7d.
  --repo R    Show only this repository.
  --json      Print the result as JSON.`,
  logs: `usage: awb logs [--since T] [--limit N] [--task ID] [--run ID] [--session ID]
                [--level L] [--source S] [--follow|-f] [--json]

Show log lines.

  --since T        Set the start of the period. The default is 1d.
  --limit N        Show at most N lines. The default is 200.
  --task ID        Show only this task.
  --run ID         Show only this run.
  --session ID     Show only this session.
  --level L        Show only this level.
  --source S       Show only this source.
  --follow, -f     Wait for new lines.
  --json           Print the result as JSON.`,
  task: `usage: awb task rm <id...> [--json]

  rm   Delete the listed tasks.

  --json   Print the result as JSON.`,
  schedule: `usage: awb schedule [status|runs|run <job>|output <run id>] [--limit N] [--json]

Show and start scheduled jobs.

  status          Show each job, its next start, and its last run. This is the default.
  runs            List the newest runs.
  run <job>       Start a job now.
  output <run id> Print the output of a run.
  --limit N       Set the number of runs to list. The default is 20.
  --json          Print the result as JSON.`,
  logging: `usage: awb logging up|down

Start or stop the Loki, Alloy and Grafana stack. It reads the logs of AWB_HOME.

  up     Start the stack. This needs Docker.
  down   Stop the stack.`,
  sessions: `usage: awb sessions [--json]

List sessions.

  --json   Print the result as JSON.`,
  wt: `usage: awb wt [pick] [filter] [--root DIR] [--json]

List worktrees.

  pick         Choose a worktree. Print its path.
  filter       Show only worktrees that match this text.
  --root DIR   Set the worktree folder. The default is AWB_WORKTREES.
  --json       Print the result as JSON.`,
};

export const helpFor = (cmd: string | undefined) => (cmd ? HELP[cmd] : undefined);

export const helpIndex = () =>
  `usage: awb <command> [options]
       awb [claude options]

Commands:
${Object.entries(HELP)
  .map(([name, text]) => `  ${name.padEnd(9)}${text.split("\n")[2]}`)
  .join("\n")}

Run "awb <command> --help" for the options of one command.
If the first word is not a command, awb starts a claude session.`;
