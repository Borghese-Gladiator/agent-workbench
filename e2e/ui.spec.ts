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

test("Retry runs the stack again from the failed task, and the run view follows it", async ({ page }) => {
  writeFileSync(join(WORK, "fix-footer"), "");
  await page.goto(`/#/task/${T2}`);
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Retried. The run starts again.")).toBeVisible();
  await nav(page, "Runs").click();
  const newest = page.getByRole("table").first().getByRole("row").nth(1);
  await expect(newest).toContainText("running");
  await expect(newest).toContainText(/\d+ min/);
  await shot(page, "10-running");
  await expect(newest).toContainText("stopped", { timeout: 150_000 });
  await expect(newest).toContainText(/C3/);
  await expect(newest.getByRole("link", { name: "Broken" })).toBeVisible();
  await shot(page, "11-stopped-again");

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
  await page.goto(`/#/task/${T3}`);
  await expect(h1(page)).toContainText("Broken");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Drop" }).click();
  await expect(page).toHaveURL(/#\/stacks$/);
  await expect(row(page, "Scoreboard")).toBeVisible();
  await expect(row(page, "Footer")).toContainText("done");
  await expect(row(page, "Broken")).toHaveCount(0);
  await expect(page.getByText(/version 2/)).toBeVisible();
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
