// End-to-end config for the real booking flow: real Chromium, real Next.js
// server, real Postgres. No mocks. This suite exists alongside (not instead
// of) the Vitest integration tests: it tests the WIRING those cannot see —
// the tRPC client reaching the provider, superjson keeping Dates as Dates,
// the clinic timezone reaching the DOM, and a 409 becoming a visible error.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  // Fail the build if a `.only` was accidentally left in the suite.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [["html", { open: "never" }]],

  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000",
    // Reuse whatever's already running locally; CI always starts fresh so a
    // stale/broken server from a previous run can't silently pass the suite.
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
