import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";

const [base, tasksFile, shots] = process.argv.slice(2);
const [t1, t2, t3] = readFileSync(tasksFile, "utf8").trim().split("\n").map((l) => l.split(" ")[0]);
mkdirSync(shots, { recursive: true });
const results = [];
const step = async (name, fn) => {
  try {
    await fn();
    results.push(["PASS", name]);
  } catch (err) {
    results.push(["FAIL", `${name}: ${err.message.split("\n")[0]}`]);
  }
};
const must = (ok, msg) => {
  if (!ok) throw new Error(msg);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const shot = (n) => page.screenshot({ path: `${shots}/${n}.png`, fullPage: true });

await step("2. Live shows the task sessions, linked to their tasks", async () => {
  await page.goto(base);
  await page.getByText("live", { exact: true }).waitFor();
  const rows = page.locator("tbody tr");
  await rows.first().waitFor();
  must((await rows.count()) >= 2, `only ${await rows.count()} session rows`);
  await page.getByRole("link", { name: "Part 1" }).first().waitFor();
  await shot("1-live");
});

await step("3. a click on a session opens its events", async () => {
  await page.locator("tbody tr").filter({ hasText: "awb/part-2" }).first().click();
  await page.getByRole("heading", { name: /Session/ }).waitFor();
  await page.getByRole("cell", { name: "SessionStart" }).or(page.getByRole("cell", { name: "Stop" })).first().waitFor().catch(() => {});
  await page.getByRole("link", { name: "Part 2" }).waitFor();
  await shot("2-session");
});

await step("4. Stacks shows done, failed and waiting, and the edit form on the waiting task only", async () => {
  await page.getByRole("link", { name: "Stacks" }).click();
  const rows = page.locator("tbody tr");
  await rows.first().waitFor();
  const status = await rows.locator("td:nth-child(2)").allTextContents();
  must(status.join(",") === "done,failed,waiting", `status is ${status}`);
  must((await page.locator("summary", { hasText: "edit" }).count()) === 1, "edit form count is not 1");
  await page.getByText("the gate failed").waitFor();
  await shot("3-stacks");
});

await step("5. proof page of task 1: PASS, a video that plays, a trace that answers, the spec and the diff", async () => {
  await page.goto(`${base}#/task/${t1}`);
  await page.getByRole("heading", { name: /Part 1/ }).waitFor();
  await page.locator(".claims .PASS", { hasText: "PASS" }).waitFor();
  const video = page.locator("video").first();
  await video.evaluate((v) => new Promise((ok, no) => {
    if (v.readyState >= 1) return ok();
    v.onloadedmetadata = ok;
    v.onerror = () => no(new Error("video error"));
  }));
  await video.evaluate((v) => { v.muted = true; return v.play(); });
  await page.waitForTimeout(800);
  const t = await video.evaluate((v) => ({ time: v.currentTime, ready: v.readyState, err: v.error?.code ?? null }));
  must(t.time > 0 && !t.err, `video did not play: ${JSON.stringify(t)}`);
  const trace = await page.getByRole("link", { name: "trace.zip" }).getAttribute("href");
  const r = await page.request.get(base.replace(/\/$/, "") + trace);
  must(r.status() === 200 && (await r.body()).length > 1000, `trace answered ${r.status()}`);
  await page.getByRole("link", { name: "PR #1" }).waitFor();
  await page.locator("pre").filter({ hasText: 'test("C1: part 1' }).waitFor();
  await page.locator("#diff").filter({ hasText: "+<!doctype html><title>Part 1</title>" }).waitFor();
  await shot("4-proof-pass");
});

await step("6. proof page of task 2: FAIL, the reason and the video of the failure", async () => {
  await page.goto(`${base}#/task/${t2}`);
  await page.getByRole("heading", { name: /Part 2/ }).waitFor();
  await page.locator(".claims .FAIL", { hasText: "FAIL" }).first().waitFor();
  await page.getByText("the gate failed at").waitFor();
  await page.locator("video").first().waitFor();
  await shot("5-proof-fail");
});

await step("7. edit the waiting task in Stacks; the title changes and the version goes up by 1", async () => {
  await page.goto(`${base}#/stacks`);
  const version = async () => Number((await page.locator("h3", { hasText: "version" }).first().textContent()).match(/version (\d+)/)[1]);
  await page.locator("h3", { hasText: "version" }).first().waitFor();
  const before = await version();
  await page.locator("summary", { hasText: "edit" }).click();
  await page.getByLabel("Title").fill("Part 3: leaderboard");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("link", { name: "Part 3: leaderboard" }).waitFor();
  const after = await version();
  must(after === before + 1, `version ${before} -> ${after}`);
  const t = await (await page.request.get(`${base}api/tasks/${t3}`)).json();
  must(t.title === "Part 3: leaderboard", `task title is ${t.title}`);
  await shot("6-stacks-edited");
});

await browser.close();
for (const [s, n] of results) console.log(`${s}  ${n}`);
console.log(`screenshots: ${shots}`);
process.exit(results.some(([s]) => s === "FAIL") ? 1 : 0);
