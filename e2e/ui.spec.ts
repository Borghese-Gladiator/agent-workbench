import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const WORK = process.env.AWB_E2E_WORK!;
const [T1, T2, T3] = [process.env.AWB_T1!, process.env.AWB_T2!, process.env.AWB_T3!];
const shot = (page: Page, name: string) => page.screenshot({ path: join(WORK, "screens", `${name}.png`), fullPage: true });
const row = (page: Page, text: string) => page.getByRole("row").filter({ hasText: text });

test.describe.configure({ mode: "serial" });

test("Live shows the stopped run, quiet and lost sessions, the USD column and the cost of today", async ({ page }) => {
  await page.goto("/");
  const run = page.locator(".card").filter({ hasText: "Run" }).first();
  await expect(run).toContainText("stopped");
  await expect(run).toContainText(/the gate failed at \w+: C2/);
  await expect(run.getByRole("link", { name: "Footer" })).toHaveAttribute("href", `#/task/${T2}`);
  await expect(run).toContainText(/ran for \d+ min/);

  await expect(row(page, "lost-branch").getByRole("cell").first()).toHaveText("lostits awb process is gone");
  await expect(row(page, "quiet-branch").getByRole("cell").first()).toHaveText("quietno event in the quiet time");
  const color = (sel: string) => page.locator(sel).first().evaluate((e) => getComputedStyle(e).color);
  const [fail, muted, text] = [await color(".card p.FAIL"), await color("#status"), await color("h2")];
  expect(fail).not.toBe(text);
  expect(muted).not.toBe(text);
  expect(await color("td.lost")).toBe(fail);
  expect(await color("td.quiet")).toBe(muted);

  await expect(page.getByRole("columnheader", { name: "USD" })).toBeVisible();
  for (const branch of ["awb/scoreboard", "awb/footer"]) await expect(row(page, branch).locator("td.num")).toHaveText("0.60");
  await expect(page.locator("#today")).toHaveText("today 2.70 USD");
  await shot(page, "1-live");
});

test("Stacks shows the USD of each task", async ({ page }) => {
  await page.goto("/#/stacks");
  await expect(row(page, "Scoreboard").locator("td.num")).toHaveText("1.35");
  await expect(row(page, "Footer").locator("td.num")).toHaveText("1.35");
  await expect(row(page, "Broken").locator("td.num")).toHaveText("");
  await shot(page, "2-stacks");
});

test("PRs lists the open PR with its gate result and state", async ({ page }) => {
  await page.goto("/#/prs");
  const pr = row(page, "Scoreboard");
  await expect(pr.getByRole("link", { name: "#1" })).toHaveAttribute("href", "https://github.com/example/demo/pull/1");
  await expect(pr).toContainText("open");
  await expect(pr).toContainText("PASS");
  await expect(row(page, "Footer")).toHaveCount(0);
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(row(page, "Scoreboard")).toContainText("open");
  await shot(page, "3-prs");
});

test("the failed task page shows its logs, the setup log and the writer end", async ({ page }) => {
  await page.goto(`/#/task/${T2}`);
  await expect(page.getByRole("heading", { level: 2 })).toHaveText("Footer failed");
  await expect(page.getByText(/^the gate failed at \w+: C2 not passed/)).toBeVisible();
  await expect(page.getByText("success, 3 turns", { exact: true })).toHaveClass("PASS");
  const logs = page.locator("details").filter({ has: page.getByText(/^Logs \(\d+ lines\)$/) });
  await expect(logs).toHaveAttribute("open", "");
  await expect(logs.locator("pre").first()).toContainText("runner.session.start");
  await expect(logs.locator("pre").first()).toContainText("prove.gate");
  await expect(logs.locator("pre").first()).toContainText("runner.task.failed");
  await expect(logs.getByRole("heading", { name: "Setup log" })).toBeVisible();
  await expect(logs).toContainText("setup: nothing to install");
  const writer = logs.getByRole("link", { name: "Test writer log" });
  const res = await page.request.get((await writer.getAttribute("href"))!);
  expect(res.headers()["content-type"]).toContain("text/plain");
  expect(await res.text()).toContain('"subtype":"success"');
  await expect(page.locator("#diff")).toHaveText("no diff");
  await shot(page, "4-task-logs");
});

test("Rewrite test removes the test of a claim and runs the real proof again", async ({ page }) => {
  await page.goto(`/#/task/${T2}`);
  await expect(page.getByRole("checkbox", { name: "C1" })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "C2" })).toBeChecked();
  await page.getByRole("button", { name: "Rewrite test" }).click();
  const out = page.locator("#rewrite-out");
  await expect(out).toContainText("removed for a rewrite: c2.spec.ts", { timeout: 60_000 });
  await expect(out).toContainText("test writer: C2");
  await expect(out).toContainText("proof run: playwright test");
  await expect(out).toContainText(/FAIL\n.*C2/s, { timeout: 120_000 });
  await shot(page, "5-rewrite");
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
  await page.getByRole("link", { name: "Live" }).click();
  const run = page.locator(".card").filter({ hasText: "Run" }).first();
  await expect(run).toContainText("running");
  await expect(run).toContainText(/running for \d+ min/);
  await shot(page, "6-running");
  await expect(run).toContainText("stopped", { timeout: 150_000 });
  await expect(run).toContainText(/C3/);
  await expect(run.getByRole("link", { name: "Broken" })).toBeVisible();
  await shot(page, "7-stopped-again");

  await page.goto("/#/prs");
  await expect(row(page, "Footer").getByRole("link", { name: "#2" })).toBeVisible();
  await expect(row(page, "Footer")).toContainText("PASS");

  await page.goto(`/#/task/${T2}`);
  await expect(page.getByRole("heading", { level: 2 })).toHaveText("Footer done");
  const diff = await page.locator("#diff").textContent();
  expect(diff).toContain("+<footer>Footer</footer>");
  expect(diff).not.toContain('+<p id="score">');
});

test("Drop removes the failed task from its stack", async ({ page }) => {
  await page.goto(`/#/task/${T3}`);
  await expect(page.getByRole("heading", { level: 2 })).toHaveText("Broken failed");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Drop" }).click();
  await expect(page).toHaveURL(/#\/stacks$/);
  await expect(row(page, "Scoreboard")).toBeVisible();
  await expect(row(page, "Footer")).toContainText("done");
  await expect(row(page, "Broken")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 3 })).toContainText("version 2");
  expect((await page.request.get(`/api/tasks/${T3}`)).status()).toBe(404);
  await shot(page, "8-dropped");
});

test("a task that is not failed has no action buttons", async ({ page }) => {
  await page.goto(`/#/task/${T1}`);
  await expect(page.getByRole("heading", { level: 2 })).toHaveText("Scoreboard done");
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Drop" })).toHaveCount(0);
});
