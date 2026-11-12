import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "ui.spec.ts",
  timeout: 180_000,
  workers: 1,
  reporter: [["list"]],
  outputDir: `${process.env.AWB_E2E_WORK}/ui-results`,
  use: { baseURL: process.env.AWB_URL, video: "on", trace: "retain-on-failure" },
});
