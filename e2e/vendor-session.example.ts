// e2e/vendor-session.example.ts
//
// ============================================================================
// REFERENCE ONLY -- DOES NOT RUN. This entire file is a comment on purpose.
// ============================================================================
//
// Why it is safe to leave in the repo:
//   - The filename ends in `.example.ts`, not `.spec.ts` / `.test.ts`, so
//     Playwright's default testMatch pattern never picks it up. It is not
//     listed in playwright.config.ts. `pnpm test:e2e` will not run it, and
//     it never runs in CI.
//   - Every line below is a `//` comment, so there is no executable code for
//     `tsc`, `eslint`, or a stray `import` to trip over, and nothing here
//     ever opens a real network connection.
//   - "vendor.example.invalid" is not a real host (`.invalid` is the TLD
//     reserved by RFC 2606 for exactly this: examples that must never
//     resolve).
//
// ClinicDesk itself has no "vendor with no public API" integration -- there
// is nothing in this codebase that needs this pattern today. This file
// exists purely to document Job 2 -- "driving someone else's app because
// they gave you no API" -- for whoever
// builds the first real connector, so they start from a shape that has
// already thought about sessions, not a blank page.
//
// ----------------------------------------------------------------------
// The pattern, in order (see the chapter for the full reasoning):
//
//   1. Look for a private JSON API before automating a browser at all
//      (DevTools -> Network, watch the vendor's own frontend talk to its
//      backend). The browser is the fallback when a portal is truly
//      server-rendered or wraps everything in a token you cannot mint --
//      never the first move. There is nothing to demonstrate in Playwright
//      for that half of the story; it is a `fetch` call, not a browser.
//
//   2. When you must drive the browser, the engineering is about *sessions*:
//      reuse a saved one (`storageState`), detect that it has expired by
//      looking for evidence (never assume saved cookies are still good),
//      re-authenticate exactly once, retry the operation once, and save the
//      refreshed state. This is the OAuth-refresh pattern from chapter 07
//      wearing different clothes.
//
//   3. Never do this on a user's request path -- enqueue a job (chapter 10).
//      A browser is slow and fails often; a queue is built for exactly that.
// ----------------------------------------------------------------------
//
// Key term: a "vendor session" = the logged-in state a vendor's website gives
// a browser after a successful login -- usually session cookies (+ sometimes
// localStorage tokens). Playwright can save that state to a JSON file
// (`context.storageState({ path })`) and load it into a fresh browser later
// (`browser.newContext({ storageState: path })`), so a job starts already
// logged in instead of typing the password every run. That file is as
// powerful as the password itself -- treat it as a secret.
// Line-by-line walkthrough: docs/16-private-apis-and-vendor-sessions.md.
// ----------------------------------------------------------------------
//
// NOTE: `playwright` (the library) is not a direct dependency of this repo;
// only `@playwright/test` (the test runner) is. A real connector would
// `pnpm add playwright` -- the runner is for tests, the library is for
// automation that runs as part of the product.
// import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
//
// const VENDOR_URL = "https://vendor.example.invalid/portal"; // never a real host
// // A real multi-tenant connector keeps one session PER customer, stored
// // encrypted in the DB (or a secret store), not one file on disk.
// const SESSION_PATH = "vendor-session.json"; // storageState -- gitignored, encrypted at rest
//
// /**
//  * One browser, reused across many jobs. Launching Chromium per task is
//  * enormously expensive; a real connector keeps this behind a small pool,
//  * not a module-level singleton like this sketch.
//  */
// let sharedBrowser: Browser | undefined;
// async function getBrowser(): Promise<Browser> {
//   // `??=` launches only if there is no browser yet. headless: no visible
//   // window -- required on a server, which has no screen.
//   sharedBrowser ??= await chromium.launch({ headless: true });
//   return sharedBrowser;
// }
//
// /**
//  * Load the saved session if one exists. A missing file just means "never
//  * logged in yet" -- not an error, just a context that will hit the login
//  * form on first navigation, exactly like an expired session does.
//  */
// async function contextWithSavedSession(browser: Browser): Promise<BrowserContext> {
//   const hasSavedSession = await fileExists(SESSION_PATH);
//   // A new context = a clean "incognito profile". Passing storageState
//   // pre-loads the saved cookies/localStorage into it.
//   return browser.newContext(hasSavedSession ? { storageState: SESSION_PATH } : {});
// }
//
// /**
//  * Detect an expired session by looking for evidence on the page, never by
//  * assuming the saved cookies are still good. Vendor sessions expire at
//  * 3am for reasons that have nothing to do with your code.
//  */
// async function sessionExpired(page: Page): Promise<boolean> {
//   await page.goto(VENDOR_URL);
//   // If the portal shows its login form, our cookies are dead.
//   // isVisible() checks ONCE, right now (it does not auto-wait like
//   // expect(...).toBeVisible()). `.catch(() => false)` turns any error
//   // into "not visible". Note: a real vendor's page won't have OUR
//   // data-testid attributes -- in practice you'd use something like
//   // page.getByRole("button", { name: "Log in" }) or check the URL.
//   return page
//     .getByTestId("login-form")
//     .isVisible()
//     .catch(() => false);
// }
//
// /**
//  * Re-authenticate exactly once. A real implementation wraps this call in
//  * a per-tenant lock (a Postgres advisory lock, or a BullMQ/Redis lock) --
//  * five concurrent jobs hitting an expired session must not each try to
//  * log in, or the vendor reads that as credential stuffing and locks the
//  * account. That single-flight guard is intentionally not shown here; this
//  * file is about the session lifecycle, not the locking primitive.
//  */
// async function reauthenticate(
//   page: Page,
//   credentials: { username: string; password: string },
// ): Promise<void> {
//   // getByLabel finds an input by its visible <label> text -- sturdier than
//   // CSS like "#user_login_v2", which vendors rename freely. If the vendor
//   // adds 2FA/CAPTCHA here, unattended login stops working: detect it and
//   // alert a human rather than trying to defeat it.
//   await page.getByLabel("Username").fill(credentials.username);
//   await page.getByLabel("Password").fill(credentials.password);
//   await page.getByRole("button", { name: "Log in" }).click();
//   await page.getByTestId("portal-home").waitFor(); // proof login actually succeeded, not a guess
// }
//
// /**
//  * One connector job: reuse the session, detect expiry, refresh at most
//  * once, retry the operation at most once, then give up loudly. It never
//  * loops -- a second failure right after a fresh login means something
//  * real is wrong (a layout change, a vendor outage, a revoked credential),
//  * and looping would just get the account banned for suspicious activity.
//  */
// async function runConnectorJob(credentials: { username: string; password: string }): Promise<void> {
//   const browser = await getBrowser();
//   const context = await contextWithSavedSession(browser);
//   const page = await context.newPage();
//   // Production addition: record a trace so a 3am failure can be replayed
//   // step by step in `npx playwright show-trace trace.zip`:
//   //   await context.tracing.start({ screenshots: true, snapshots: true });
//   //   ...and in `finally`: await context.tracing.stop({ path: "trace.zip" });
//
//   try {
//     if (await sessionExpired(page)) {
//       await reauthenticate(page, credentials); // exactly once -- no retry loop
//       await context.storageState({ path: SESSION_PATH }); // save the refreshed state
//     }
//
//     await doTheActualScrapeOrSubmission(page);
//   } catch (err) {
//     // Fail loudly and specifically. "vendor changed their DOM" is a useful
//     // alert to page someone on; `undefined is not a function` three layers
//     // down is not. A canary job that runs this hourly and screenshots on
//     // failure is how you find a layout change before a customer does.
//     throw new Error(`Connector job failed -- vendor portal may have changed shape: ${String(err)}`);
//   } finally {
//     // Always close the context (success OR failure) or tabs leak memory
//     // until the shared browser falls over.
//     await context.close();
//   }
// }
//
// async function doTheActualScrapeOrSubmission(page: Page): Promise<void> {
//   // ...vendor-specific steps go here. Two things matter beyond this file:
//   //   - Idempotency: a retried scrape must not create the same record
//   //     twice. Use the vendor's own id as a natural key and
//   //     `onConflictDoNothing`, same as any other webhook-shaped write.
//   //   - Rate limiting: you are a guest. Behave like the vendor's own
//   //     frontend -- sequential, paced, a real user agent -- not a scraper
//   //     hammering their infrastructure.
//   //   - Validation: whatever you read off the page (text, a table row, a
//   //     JSON response caught via page.waitForResponse) is untrusted
//   //     third-party input. Zod-parse it before it reaches the database.
// }
//
// async function fileExists(path: string): Promise<boolean> {
//   const fs = await import("node:fs/promises");
//   return fs
//     .access(path)
//     .then(() => true)
//     .catch(() => false);
// }
