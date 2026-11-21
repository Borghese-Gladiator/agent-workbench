import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const WORK = process.env.AWB_E2E_WORK!;
const [T1, T2, T3] = [process.env.AWB_T1!, process.env.AWB_T2!, process.env.AWB_T3!];
const shot = (page: Page, name: string) => page.screenshot({ path: join(WORK, "screens", `${name}.png`), fullPage: true });
const row = (page: Page, text: string) => page.getByRole("row").filter({ hasText: text });
const h1 = (page: Page) => page.getByRole("heading", { level: 1 });
const nav = (page: Page, name: string) => page.getByRole("navigation", { name: "Main" }).getByRole("link", { name });

test.describe.configure({ mode: "serial" });

test("Overview shows the summary, the failed task once, and no sessions table", async ({ page }) => {
  await page.goto("/");
  await expect(h1(page)).toHaveText("Overview");
  const summary = page.getByRole("group", { name: "Summary" });
  await expect(summary).toContainText("Needs attention");
  await expect(summary).toContainText("Total cost");
  const attention = page.getByRole("heading", { name: "Needs attention" }).locator("xpath=following-sibling::table[1]");
  await expect(attention.getByRole("link", { name: "Footer" })).toHaveAttribute("href", `#/task/${T2}`);
  await expect(attention).toContainText(/the gate failed at \w+: C2/);
  await expect(page.getByText(/the gate failed at \w+: C2/)).toHaveCount(1);
  await expect(page.getByRole("columnheader", { name: "Tokens in / out" })).toHaveCount(0);
  await expect(page.locator("aside .foot")).toContainText("Today 2.70 USD");
  await shot(page, "1-overview");
});

test("Overview shows relative dates with the full date in a tooltip, and the PR text links to the PR", async ({ page }) => {
  await page.goto("/");
  const recent = page.getByRole("table", { name: "Recent activity" });
  const stamp = recent.locator("time").first();
  await expect(stamp).toHaveText(/^(Just now|\d+ min ago|\d+ h ago)$/);
  expect(await stamp.getAttribute("title")).toMatch(/\d{4}/);
  const pr = recent.getByRole("link", { name: "Open PR 1" });
  await expect(pr).toHaveText("PR #1");
  await expect(pr).toHaveAttribute("href", "https://github.com/example/demo/pull/1");
  await expect(pr).toHaveAttribute("target", "_blank");
  await recent.getByRole("link", { name: "Scoreboard" }).click();
  await expect(page).toHaveURL(new RegExp(`#/task/${T1}$`));
  await page.goto("/");
  await recent.getByRole("row").filter({ hasText: "Scoreboard" }).getByRole("cell").nth(3).click();
  await expect(page).toHaveURL(new RegExp(`#/task/${T1}$`));
  await page.goto("/");
  const widths = await page.locator("main table.list").evaluateAll((ts) => ts.map((t) => t.querySelector("td")!.getBoundingClientRect().width));
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(2);
  await shot(page, "1a-overview-dates");
});

test("the sidebar groups the pages, and each page has its own heading", async ({ page }) => {
  await page.goto("/");
  for (const [link, heading] of [["Tasks", "Tasks"], ["Stacks", "Stacks"], ["Runs", "Runs"], ["Reviews", "Reviews"], ["Verification", "Verification"], ["Logs", "Logs"], ["Usage", "Usage"], ["Settings", "Settings"], ["Overview", "Overview"]]) {
    await nav(page, link).click();
    await expect(h1(page)).toHaveText(heading);
    await expect(nav(page, link)).toHaveAttribute("aria-current", "page");
  }
});

test("Tasks lists every task and filters by text and by status", async ({ page }) => {
  await page.goto("/#/tasks");
  await expect(row(page, "Scoreboard")).toBeVisible();
  await expect(row(page, "Footer")).toBeVisible();
  await expect(row(page, "Broken")).toBeVisible();
  await page.getByRole("searchbox", { name: "Search tasks" }).fill("foot");
  await expect(row(page, "Scoreboard")).toHaveCount(0);
  await expect(row(page, "Footer")).toBeVisible();
  await page.getByRole("searchbox", { name: "Search tasks" }).fill("");
  await page.getByRole("group", { name: "Status" }).getByRole("button", { name: "Failed" }).click();
  await expect(row(page, "Footer")).toBeVisible();
  await expect(row(page, "Scoreboard")).toHaveCount(0);
  await shot(page, "2-tasks");
});

test("Tasks sorts by task, status, repository and cost, and a second click reverses it", async ({ page }) => {
  await page.goto("/#/tasks");
  const names = () => page.locator("main tbody tr").evaluateAll((rs) => rs.map((r) => r.querySelector("a")!.textContent));
  const head = (name: string) => page.getByRole("columnheader", { name: new RegExp("^" + name) });
  await head("Task").getByRole("button").click();
  await expect(head("Task")).toHaveAttribute("aria-sort", "ascending");
  expect(await names()).toEqual(["Broken", "Footer", "Scoreboard"]);
  await head("Task").getByRole("button").click();
  await expect(head("Task")).toHaveAttribute("aria-sort", "descending");
  expect(await names()).toEqual(["Scoreboard", "Footer", "Broken"]);
  await head("Status").getByRole("button").click();
  await expect(head("Status")).toHaveAttribute("aria-sort", "ascending");
  expect(await names()).toEqual(["Footer", "Broken", "Scoreboard"]);
  await head("USD").getByRole("button").click();
  await expect(head("USD")).toHaveAttribute("aria-sort", "descending");
  await expect(head("Status")).toHaveAttribute("aria-sort", "none");
  expect((await names())[2]).toBe("Broken");
  await head("USD").getByRole("button").click();
  await expect(head("USD")).toHaveAttribute("aria-sort", "ascending");
  expect((await names())[0]).toBe("Broken");
  await head("Repository").getByRole("button").click();
  await expect(head("Repository")).toHaveAttribute("aria-sort", "ascending");
  await shot(page, "2a-tasks-sorted");
});

test("Stacks edits a task in a modal, keeps PR numbers on one line, and archives a stack", async ({ page }) => {
  await page.goto("/#/stacks");
  const lineHeight = (loc: import("@playwright/test").Locator) => loc.evaluate((e) => e.getBoundingClientRect().height);
  const prCell = row(page, "Scoreboard").locator("td.pr");
  expect(await lineHeight(prCell.getByRole("link"))).toBeLessThan(30);
  await expect(row(page, "Broken").getByRole("button", { name: /^Edit/ })).toBeVisible();
  await expect(page.getByText("Edit title and claims")).toHaveCount(0);

  await row(page, "Broken").getByRole("button", { name: /^Edit/ }).click();
  const dlg = page.getByRole("dialog", { name: "Edit task" });
  await expect(dlg).toBeVisible();
  await dlg.getByLabel("Title").fill("Broken renamed");
  await shot(page, "3a-edit-modal");
  await page.keyboard.press("Escape");
  await expect(dlg).toBeHidden();
  await expect(row(page, "Broken renamed")).toHaveCount(0);

  await row(page, "Broken").getByRole("button", { name: /^Edit/ }).click();
  await dlg.getByLabel("Title").fill("Broken renamed");
  await dlg.getByRole("button", { name: "Save" }).click();
  await expect(dlg).toBeHidden();
  await expect(row(page, "Broken renamed")).toBeVisible();
  const t3 = await (await page.request.get(`/api/tasks/${T3}`)).json();
  expect(t3.title).toBe("Broken renamed");

  await page.getByRole("button", { name: /^Archive stack/ }).click();
  await expect(page.getByText("Every stack is archived.")).toBeVisible();
  await expect(row(page, "Scoreboard")).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Every stack is archived.")).toBeVisible();
  const archived = page.getByText(/^Archived \(1\)$/);
  await archived.click();
  await expect(row(page, "Scoreboard")).toBeVisible();
  expect((await page.request.get(`/api/tasks/${T1}`)).status()).toBe(200);
  await shot(page, "3b-archived");
  await page.getByRole("button", { name: /^Restore stack/ }).click();
  await expect(page.getByText("Every stack is archived.")).toHaveCount(0);
  await expect(row(page, "Scoreboard")).toBeVisible();

  await row(page, "Broken renamed").getByRole("button", { name: /^Edit/ }).click();
  await dlg.getByLabel("Title").fill("Broken");
  await dlg.getByRole("button", { name: "Save" }).click();
  await expect(dlg).toBeHidden();
  await expect(row(page, "Broken")).toBeVisible();
});

test("a big stack with long names keeps PR numbers, costs, indexes and branches on one line", async ({ page }) => {
  const repo = "/Users/dev/lm-expense-chatbot-pwa";
  const names = ["Delete the old service worker", "Category to merchant drill-down", "Explore summary cards", "Trips tables and CRUD API", "Trips list page", "Trip suggestions", "Trip review screen", "Trip summary page", "Trip filter and dimension in Explore", "Keep trip links across Plaid sync"];
  const tasks = Array.from({ length: 19 }, (_, i) => {
    const title = i < names.length ? names[i] : "Follow up task number " + i;
    const status = i < 7 ? "waiting" : i === 7 ? "done" : i === 8 ? "failed" : "waiting";
    return {
      id: "task-" + i, stack_id: "big", position: i, title, status, repo, base: "awb/todo-stack", folder: "/x", worktree: null,
      branch: "awb/" + title.toLowerCase().replace(/[^a-z]+/g, "-") + "-8f2c1d",
      pr_number: i < 8 ? 38 + i : null, pr_url: i < 8 ? "https://github.com/example/demo/pull/" + (38 + i) : null,
      created_at: new Date(Date.now() - i * 3600_000).toISOString(), last_gate_at: i < 9 ? new Date(Date.now() - i * 3600_000).toISOString() : null,
      fail_reason: i === 8 ? "the gate failed at 701ae78b5d: C1 no test (test writer: success, 6 turns); C2 not passed (session: timeout after 45 min)" : null,
      failed_claims: i === 8 ? ["C1", "C2"] : [], claims: [{ id: "C1", text: "It works." }],
    };
  });
  const cost = { total_usd: 58.52, session_usd: 50, writer_usd: 8.52, by_day: {}, by_repo: {}, unpriced_sessions: 0, by_task: tasks.map((t, i) => ({ task_id: t.id, title: t.title, usd: i === 8 ? 21.73 : 1.11 + i })) };
  const json = (body: unknown) => (route: import("@playwright/test").Route) => (route.request().method() === "GET" ? route.fulfill({ json: body }) : route.continue());
  await page.route("**/api/stacks", json([{ id: "big", version: 1, repo, base: "awb/todo-stack", tasks }]));
  await page.route("**/api/tasks", json(tasks));
  await page.route(/\/api\/cost/, json(cost));
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.goto("/#/stacks");
  await expect(row(page, "Delete the old service worker")).toBeVisible();
  const oneLine = async (sel: string) => {
    const cells = await page.locator(sel).evaluateAll((els) =>
      els.map((e) => {
        const walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
        const tops = new Set<number>();
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (!(n.textContent ?? "").trim()) continue;
          const r = document.createRange();
          r.selectNodeContents(n);
          for (const q of r.getClientRects()) if (q.width > 0) tops.add(Math.round(q.top / 6));
        }
        return [tops.size, (e.textContent ?? "").trim().slice(0, 40)] as const;
      }),
    );
    const filled = cells.filter(([, text]) => text);
    expect(filled.length, sel).toBeGreaterThan(0);
    for (const [lines, text] of filled) expect(lines, `${sel} wraps onto a second line: "${text}"`).toBe(1);
  };
  await oneLine("td.pr a");
  await oneLine("tbody tr td:first-child");
  await oneLine("td.num:not(:has(.note))");
  await oneLine("td.end > button");
  const apart = await page.locator("td .nowrap").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  for (const h of apart) expect(h, "branch and Copy on one line").toBeLessThan(30);
  await expect(page.getByText("costly failure")).toBeVisible();
  await shot(page, "3c-big-stack");

  await page.goto("/#/tasks");
  await expect(row(page, "Delete the old service worker")).toBeVisible();
  await oneLine("td.num");
  await oneLine("td.nowrap");
  await shot(page, "2b-big-tasks");

  await page.goto("/");
  await expect(page.getByRole("table", { name: "Recent activity" })).toBeVisible();
  await oneLine("table.list td.pr a");
  await oneLine("table.list td.when time");
  await shot(page, "1b-big-overview");
});

test("Stacks shows the state and the USD of each task, and the stack cost", async ({ page }) => {
  await page.goto("/#/stacks");
  await expect(row(page, "Scoreboard").locator("td.num")).toHaveText("1.35");
  await expect(row(page, "Footer").locator("td.num")).toHaveText("1.35");
  await expect(row(page, "Broken").locator("td.num")).toHaveText("");
  await expect(row(page, "Footer")).toContainText("failed");
  await expect(row(page, "Broken")).toContainText("blocked");
  await expect(page.getByText(/^Stack cost/)).toContainText("USD");
  await shot(page, "3-stacks");
});

test("Runs shows the stopped run, and the quiet and lost sessions", async ({ page }) => {
  await page.goto("/#/runs");
  await expect(page.getByRole("heading", { name: "Run history" })).toBeVisible();
  const history = row(page, "stopped");
  await expect(history).toContainText(/the gate failed at \w+: C2/);
  await expect(history.getByRole("link", { name: "Footer" })).toHaveAttribute("href", `#/task/${T2}`);
  await expect(history).toContainText(/\d+ min/);
  await expect(row(page, "lost-branch").getByRole("cell").first()).toHaveText("lostIts awb process is gone");
  await expect(row(page, "quiet-branch").getByRole("cell").first()).toHaveText("quietNo event in the quiet time");
  const color = (sel: string) => page.locator(sel).first().evaluate((e) => getComputedStyle(e).color);
  expect(await color(".chip.bad")).not.toBe(await color(".chip.dim"));
  await expect(page.getByRole("columnheader", { name: "USD" })).toBeVisible();
  for (const branch of ["awb/scoreboard", "awb/footer"]) await expect(row(page, branch).locator("td.num")).toHaveText("0.60");
  await page.getByRole("group", { name: "Session state" }).getByRole("button", { name: /^Lost/ }).click();
  await expect(row(page, "quiet-branch")).toHaveCount(0);
  await shot(page, "4-runs");
});

test("Reviews groups the open PR, and links to its changes", async ({ page }) => {
  await page.goto("/#/reviews");
  const pr = row(page, "Scoreboard");
  await expect(pr.getByRole("link", { name: "#1" })).toHaveAttribute("href", "https://github.com/example/demo/pull/1");
  await expect(pr).toContainText("Verified");
  await expect(row(page, "Footer")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /^Ready to review \(1\)$/ })).toBeVisible();
  await expect(page.getByText(/It does not show that a person reviewed it/)).toBeVisible();
  await pr.getByRole("link", { name: "Changes" }).click();
  await expect(page).toHaveURL(new RegExp(`#/task/${T1}/changes$`));
  await page.goto("/#/reviews");
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(row(page, "Scoreboard")).toBeVisible();
  await shot(page, "5-reviews");
});

test("Verification lists the latest gate of each task and opens its evidence", async ({ page }) => {
  await page.goto("/#/verification");
  await expect(row(page, "Footer")).toContainText("Failed");
  await expect(row(page, "Footer")).toContainText("C2");
  await expect(row(page, "Scoreboard")).toContainText("Passed");
  await row(page, "Footer").getByRole("link", { name: "Evidence" }).click();
  await expect(page).toHaveURL(new RegExp(`#/task/${T2}/verification$`));
  await expect(page.getByRole("heading", { name: "Gate history" })).toBeVisible();
  await shot(page, "6-verification");
});

test("the failed task shows one failure message, the tabs, and the actions", async ({ page }) => {
  await page.goto(`/#/task/${T2}`);
  await expect(h1(page)).toContainText("Footer");
  await expect(page.getByRole("alert")).toContainText(/the gate failed at \w+: C2 not passed/);
  await expect(page.getByText(/the gate failed at \w+: C2 not passed/)).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Drop" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Summary" })).toContainText("Claims passed");
  await expect(page.getByRole("link", { name: "Tasks", exact: true }).first()).toBeVisible();
  await expect(page.getByText("success, 3 turns", { exact: true })).toHaveClass("PASS");
  await page.getByRole("tab", { name: "Overview" }).click();
  await expect(page.getByRole("heading", { name: "Claims" })).toBeVisible();
  await shot(page, "7-task-overview");
  await page.getByRole("tab", { name: "Attempts" }).click();
  await expect(page).toHaveURL(new RegExp(`#/task/${T2}/attempts$`));
  await expect(page.getByRole("columnheader", { name: "Gate" })).toBeVisible();
});

test("the task logs tab shows events, the raw log, the setup log and the writer log", async ({ page }) => {
  await page.goto(`/#/task/${T2}/logs`);
  const main = page.locator("main");
  await expect(main).toContainText("runner.session.start");
  await expect(main).toContainText("prove.gate");
  await expect(main).toContainText("runner.task.failed");
  await main.getByText("runner.task.failed").first().click();
  await expect(main.getByRole("term").first()).toBeVisible();
  await main.getByText("Raw log").click();
  await expect(main.locator("pre").first()).toContainText("runner.task.failed");
  await main.getByText("Setup log").click();
  await expect(main).toContainText("setup: nothing to install");
  const writer = main.getByRole("link", { name: "Test writer log" });
  const res = await page.request.get((await writer.getAttribute("href"))!);
  expect(res.headers()["content-type"]).toContain("text/plain");
  expect(await res.text()).toContain('"subtype":"success"');
  await shot(page, "8-task-logs");
  await page.getByRole("tab", { name: "Changes" }).click();
  await expect(page.locator("#diff")).toHaveText("no diff");
});

test("Rewrite test, in Verification, removes the test of a claim and runs the real proof again", async ({ page }) => {
  await page.goto(`/#/task/${T2}/verification`);
  await expect(page.getByRole("checkbox", { name: "C1" })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "C2" })).toBeChecked();
  await page.getByRole("button", { name: "Rewrite test" }).click();
  const out = page.getByLabel("Rewrite output");
  await expect(out).toContainText("removed for a rewrite: c2.spec.ts", { timeout: 60_000 });
  await expect(out).toContainText("test writer: C2");
  await expect(out).toContainText("proof run: playwright test");
  await expect(out).toContainText(/FAIL\n.*C2/s, { timeout: 120_000 });
  await shot(page, "9-rewrite");
  const t = await (await page.request.get(`/api/tasks/${T2}`)).json();
  expect(t.status).toBe("failed");
  expect(t.attempts.length).toBe(2);
  expect(t.attempts[1].gates[0].result.rows.map((r: any) => r.status)).toEqual(["PASS", "FAIL"]);
});

test("Retry runs only the failed task, and the run view follows it", async ({ page }) => {
  writeFileSync(join(WORK, "fix-footer"), "");
  await page.goto(`/#/task/${T2}`);
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Retried. The run starts again.")).toBeVisible();
  await nav(page, "Runs").click();
  const newest = page.getByRole("table").first().getByRole("row").nth(1);
  await expect(newest).toContainText("running");
  await expect(newest).toContainText(/\d+ min/);
  await shot(page, "10-running");
  await expect(newest).toContainText("done", { timeout: 150_000 });
  await shot(page, "11-run-done");
  await page.goto("/#/stacks");
  await expect(row(page, "Broken")).toContainText("waiting");

  await page.goto("/#/reviews");
  await expect(row(page, "Footer").getByRole("link", { name: "#2" })).toBeVisible();
  await expect(row(page, "Footer")).toContainText("Verified");

  await page.goto(`/#/task/${T2}/changes`);
  await expect(h1(page)).toContainText("Footer");
  await expect(page.getByRole("heading", { level: 1 }).getByText("done", { exact: true })).toBeVisible();
  const diff = await page.locator("#diff").textContent();
  expect(diff).toContain("+<footer>Footer</footer>");
  expect(diff).not.toContain('+<p id="score">');
});

test("Drop removes the failed task from its stack", async ({ page }) => {
  expect((await page.request.post("/api/run", { data: { id: T3 } })).status()).toBe(202);
  await expect.poll(async () => (await (await page.request.get(`/api/tasks/${T3}`)).json()).status, { timeout: 150_000 }).toBe("failed");
  const version = async () => (await (await page.request.get("/api/stacks")).json())[0].version as number;
  const before = await version();
  await page.goto(`/#/task/${T3}`);
  await expect(h1(page)).toContainText("Broken");
  await expect(page.getByRole("alert")).toContainText(/C3/);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Drop" }).click();
  await expect(page).toHaveURL(/#\/stacks$/);
  await expect(row(page, "Scoreboard")).toBeVisible();
  await expect(row(page, "Footer")).toContainText("done");
  await expect(row(page, "Broken")).toHaveCount(0);
  expect(await version()).toBe(before + 1);
  await expect(page.getByText(new RegExp("version " + (before + 1)))).toBeVisible();
  expect((await page.request.get(`/api/tasks/${T3}`)).status()).toBe(404);
  await shot(page, "12-dropped");
});

test("a task that is not failed has no action buttons", async ({ page }) => {
  await page.goto(`/#/task/${T1}`);
  await expect(h1(page)).toContainText("Scoreboard");
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Drop" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Open draft PR #1/ })).toBeVisible();
});

test("Logs filters, searches, expands an entry, and the task page links to its logs", async ({ page }) => {
  await page.goto("/#/logs");
  const events = page.getByLabel("Log events");
  await expect(events).toContainText("daemon.start");
  await page.getByLabel("Level").selectOption("error");
  await expect(events).not.toContainText("daemon.start");
  await expect(events).toContainText("runner.task.failed");
  await page.getByLabel("Level").selectOption("info");
  await page.getByRole("searchbox", { name: "Search logs" }).fill("daemon.start");
  await expect(events).toContainText("daemon.start");
  await expect(events).not.toContainText("runner.task.failed");
  await events.getByText("daemon.start").first().click();
  await expect(events.getByRole("term").first()).toBeVisible();
  await page.getByRole("searchbox", { name: "Search logs" }).fill("");
  await page.getByRole("group", { name: "Log view" }).getByRole("button", { name: "Raw" }).click();
  await expect(page.getByLabel("Log lines")).toContainText("daemon.start");
  await page.getByRole("group", { name: "Log view" }).getByRole("button", { name: "Timeline" }).click();
  await expect(page.getByLabel("Timeline")).toContainText("Task failed");
  await expect(page.getByLabel("Timeline")).not.toContainText("daemon.start");
  await shot(page, "13-logs-timeline");

  await page.goto(`/#/task/${T1}/logs`);
  await page.getByRole("link", { name: "All logs of this task" }).click();
  await expect(page).toHaveURL(new RegExp(`#/logs/${T1}$`));
  await expect(page.getByLabel("Task", { exact: true })).toHaveValue(T1);
  await page.getByRole("group", { name: "Log view" }).getByRole("button", { name: "Raw" }).click();
  const pre = page.getByLabel("Log lines");
  await expect(pre).toContainText("runner.session.start");
  await expect(pre).toContainText("ship.pr");
  const ids = await pre.evaluate((el) => [...el.textContent!.matchAll(/task=(\w+)/g)].map((m) => m[1]));
  expect(ids.length).toBeGreaterThan(0);
  expect(ids.every((id) => T1.startsWith(id))).toBe(true);
  await expect(nav(page, "Logs")).toHaveAttribute("aria-current", "page");
  await shot(page, "14-logs-task");
});

test("Schedule opens from the sidebar with the shared page layout", async ({ page }) => {
  await page.goto("/");
  await nav(page, "Schedule").click();
  await expect(h1(page)).toHaveText("Schedule");
  await expect(nav(page, "Schedule")).toHaveAttribute("aria-current", "page");
  await expect(page.getByText(/starts each job once a day/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
  await shot(page, "15a-schedule");
});

test("Usage shows the cost for a range and by repository and task", async ({ page }) => {
  await page.goto("/#/usage");
  await expect(page.getByRole("group", { name: "Summary" })).toContainText("Total");
  await expect(page.getByRole("table", { name: "By task" })).toContainText("Footer");
  await page.getByRole("group", { name: "Range" }).getByRole("button", { name: "All" }).click();
  await expect(page.getByRole("table", { name: "By repository" })).toContainText("repo");
  await shot(page, "15-usage");
});

test("the old route names open the new pages", async ({ page }) => {
  for (const [route, heading] of [["#/prs", "Reviews"], ["#/live", "Overview"], ["#/reviews", "Reviews"], ["#/overview", "Overview"]]) {
    await page.goto("/" + route);
    await expect(h1(page)).toHaveText(heading);
  }
});

test("Settings sets the theme and the density, and they survive a reload", async ({ page }) => {
  await page.goto("/#/settings");
  const bg = () => page.locator("body").evaluate((e) => getComputedStyle(e).backgroundColor);
  await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Light" }).click();
  const light = await bg();
  await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const dark = await bg();
  expect(dark).not.toBe(light);
  await shot(page, "16-settings-dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await bg()).toBe(dark);
  await expect(page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
  await page.goto("/#/tasks");
  const cell = () => page.locator("td").first().evaluate((e) => e.getBoundingClientRect().height);
  const tall = await cell();
  await page.goto("/#/settings");
  await page.getByRole("group", { name: "Density" }).getByRole("button", { name: "Compact" }).click();
  await page.goto("/#/tasks");
  expect(await cell()).toBeLessThan(tall);
  await shot(page, "17-dark-compact");
  await page.goto("/#/settings");
  await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "System" }).click();
  await page.getByRole("group", { name: "Density" }).getByRole("button", { name: "Comfortable" }).click();
});

test("the pages do not scroll sideways at phone width, and the menu opens the sidebar", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  for (const route of ["/#/", "/#/tasks", "/#/stacks", "/#/runs", "/#/reviews", "/#/verification", "/#/usage", "/#/settings", `/#/task/${T2}`]) {
    await page.goto(route);
    await expect(h1(page)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const inner = await page.locator("main").evaluate((m) => [m.scrollWidth, m.clientWidth]);
    expect(inner[0], `${route} scrolls sideways inside main`).toBeLessThanOrEqual(inner[1]);
    await shot(page, "18-phone-" + route.replace(/[^a-z0-9]+/gi, "-"));
  }
  await page.getByRole("button", { name: "Menu" }).click();
  await expect(nav(page, "Tasks")).toBeVisible();
  await shot(page, "18-phone");
});
