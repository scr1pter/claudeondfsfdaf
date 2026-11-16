import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.e2e.ts",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: "line",
  use: { trace: "off", screenshot: "off", video: "off" },
})
