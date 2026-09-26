// End-to-end config for the real booking flow: real Chromium, real Next.js
// server, real Postgres. No mocks. This suite exists alongside (not instead
// of) the Vitest integration tests: it tests the WIRING those cannot see —
// the tRPC client reaching the provider, superjson keeping Dates as Dates,
// the clinic timezone reaching the DOM, and a 409 becoming a visible error.
import { defineConfig, devices } from "@playwright/test";
import { config } from "dotenv";

// Next.js reads .env.local by itself, but the TEST RUNNER process doesn't. Load it
// so tests can read e.g. ADMIN_TOKEN. dotenv never overrides variables that are
// already set, so on CI the workflow's env wins (its .env.local holds the same placeholders).
config({ path: ".env.local", quiet: true });

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  // Fail the build if a `.only` was accidentally left in the suite.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // On CI, "github" turns each failure into an annotation on the PR/commit page;
  // the HTML report is still written and uploaded as a CI artifact.
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["html", { open: "never" }]],

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
    // CI tests the production build (what users actually get: minified,
    // no dev overlay, real server rendering). Locally, the dev server is faster.
    command: process.env.CI ? "pnpm build && pnpm start" : "pnpm dev",
    url: "http://localhost:3000",
    // Reuse whatever's already running locally; CI always starts fresh so a
    // stale/broken server from a previous run can't silently pass the suite.
    reuseExistingServer: !process.env.CI,
    timeout: process.env.CI ? 300_000 : 120_000, // CI includes `next build`
  },
});
