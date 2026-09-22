# 11 · Browser automation

Browser automation shows up twice in the job description, and they are two very different jobs:

> *"Browser automation at production quality (Playwright), or reverse-engineering a private API"*
> and
> *"Integration-as-a-service — integrations with vendors who have no public API, where we
> reconstruct the interface ourselves."*

**Job 1: testing your own app in a real browser.** Does the booking flow actually work, in
Chromium, with real network calls and a real database?

**Job 2: driving someone else's app because they gave you no API.** A vendor has a web portal and
no integration story, so the browser *is* the API. This is the connector platform.

They use the same tool and almost none of the same engineering.

## Job 1 — end-to-end testing the real thing

`e2e/booking.spec.ts` drives a real Chromium against a real Next.js server against a real
Postgres. No mocks anywhere in the stack.

```ts
// playwright.config.ts (shape)
export default defineConfig({
  testDir: './e2e',
  webServer: {
    command: 'pnpm dev',                  // Playwright starts the app…
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI, // …unless you already have one running
  },
  use: { baseURL: 'http://localhost:3000', trace: 'on-first-retry' },
});
```

### What it covers that Vitest cannot

The integration tests call `bookAppointment(db, …)` directly. That proves the rules. It does not
prove:

- the tRPC client is wired to the provider at all;
- `superjson` survives the round trip, so a `Date` is still a `Date` in the browser;
- the slot buttons render the clinic's timezone, not the viewer's;
- the 409 from a taken slot actually reaches a visible error message;
- clicking submit twice doesn't book twice.

Every one of those is a **wiring** failure, invisible to a unit test and instantly visible to a
browser. That is the whole value proposition of end-to-end: it tests the seams, not the parts.

### Why `data-testid` and not text selectors

```ts
await page.getByTestId('service-select').selectOption({ label: 'Consultation' });
await page.getByTestId('slot-button').first().click();
await page.getByTestId('submit-button').click();
await expect(page.getByTestId('success-message')).toBeVisible();
```

A selector like `page.getByText('Book appointment')` breaks when someone rewords a button, and
worse, it *silently matches the wrong element* when a second "Book" appears on the page. A
`data-testid` is an explicit contract: this element exists for automation, renaming it is a
deliberate act. Team UI was asked for the exact list up front for this reason — the test and the
markup were designed together rather than the test being retrofitted around whatever the DOM
happened to look like.

(Playwright's own guidance prefers user-facing roles — `getByRole('button', { name: … })` — and
for a public product that's right, because it tests accessibility at the same time. For a
portfolio project being demoed and rewritten, stable ids cost less churn. Both are defensible;
know which you chose and why.)

### Production-quality means the boring parts

Anyone can record a click script. What makes browser automation survive contact with reality:

| Problem | Amateur | Production |
|---|---|---|
| Timing | `waitForTimeout(3000)` | web-first assertions (`await expect(x).toBeVisible()`) that retry until a deadline |
| Flakiness | rerun until green | `trace: 'on-first-retry'` — then **read the trace** and fix the cause |
| Test data | reuse whatever's in the DB | each test creates what it needs; dates are relative to now, never hardcoded |
| Parallel runs | tests collide | independent data per test, or a worker-scoped fixture |
| Debugging CI | "works locally" | trace viewer, screenshot + video on failure, retained artifacts |
| Auth | log in through the UI every test | authenticate once, reuse `storageState` |

`waitForTimeout` deserves its own sentence: **every `waitForTimeout` in a suite is a bug you
haven't found yet.** It is either too short (flaky) or too long (slow), and usually both on
different machines. Playwright's assertions already retry; that is what auto-waiting is.

### Running it

```bash
pnpm add -D @playwright/test && pnpm exec playwright install chromium   # one-time, ~130 MB
pnpm test:e2e
pnpm test:e2e:ui        # the time-travel debugger; genuinely worth using
```

Playwright is excluded from the Vitest run (`exclude: ['e2e/**']` in `vitest.config.ts`) because
they are different runners with different setup — a Playwright spec loading `tests/setup.ts` would
try to `TRUNCATE` the database out from under the running app.

## Job 2 — the vendor with no public API

This is the connector platform, and it is a genuinely different discipline. You are not testing;
you are **building an integration on top of an interface nobody promised you.**

### Step 1: look for the API before you automate the browser

Almost every "no API" portal has a JSON API — it just isn't documented, because it exists for the
vendor's own frontend. Open DevTools → Network, do the thing by hand, and watch:

```
POST /internal/api/v2/appointments      {"date":"2026-10-02","serviceId":41}
  Cookie: session=…
  X-CSRF-Token: …
```

There it is. Now you can call it with `fetch` — no browser, no rendering, 100× faster and
dramatically more stable. **The browser is the fallback, not the goal.** Reaching for Playwright
first is the most common mistake in this work.

What you are reconstructing: the auth mechanism (session cookie? bearer? CSRF token?), the exact
request shape, the pagination, and the error format. Then you write Zod schemas for the responses
— because an undocumented API changes without notice, and you want a clear parse failure with a
field name, not `undefined is not a function` three layers deeper.

### Step 2: when you truly must drive the browser

Some portals are server-rendered forms, or wrap everything in a token your code can't mint. Then
the browser *is* the client, and the engineering is about **sessions**:

```ts
// 1. Log in once, keep the session.
const context = await browser.newContext({ storageState: 'vendor-session.json' });

// 2. Detect that it has expired — do NOT assume it's alive.
if (await page.getByTestId('login-form').isVisible().catch(() => false)) {
  await reauthenticate(page);
  await context.storageState({ path: 'vendor-session.json' });
}
```

> *"vendor sessions that expire at 3am"* — the job description's words. The pattern is exactly
> the OAuth refresh pattern from chapter 07 wearing different clothes: **detect the expired
> credential, renew it once, retry the operation once, and give up loudly rather than looping.**
> The same single-flight concern applies too: five concurrent jobs must not each try to log in,
> or the vendor locks the account for suspicious activity.

The rest of what makes a connector survive:

- **Never scrape on the request path.** A user clicking "sync" should enqueue a job (chapter 10),
  not wait 40 seconds for a browser to boot. Browsers are slow and fail often; queues are built
  for exactly that.
- **One browser, many jobs.** Launching Chromium per task is enormously expensive. Keep a pool.
- **Idempotency, again.** A scrape that retries must not create the same record twice. Same tools
  as chapter 04: a natural key from the vendor's own id, `onConflictDoNothing`.
- **Detect layout changes loudly.** When a selector stops matching, fail with "vendor changed
  their DOM" — not with `undefined`. A canary job that runs hourly and screenshots on failure is
  how you find out before the customer does.
- **Rate limit yourself.** You are a guest. Behave like their own frontend: sequential, paced,
  with a real user agent.
- **Store credentials encrypted**, scoped per tenant, and never log them. You are holding another
  business's password — which is a bigger responsibility than holding your own.
- **Respect the boundary.** Automating a portal on behalf of a customer who has authorised it,
  within the vendor's terms, is legitimate integration work. Credential-stuffing, circumventing
  access controls, or scraping data the customer has no right to is not. That distinction is
  worth stating in an interview, unprompted — it shows you know where the line is.

### The honest comparison

| | Private JSON API | Browser automation |
|---|---|---|
| Speed | ~100 ms | ~5–30 s |
| Stability | breaks on API change | breaks on **any** layout change |
| Resources | a `fetch` | a whole Chromium |
| Debuggability | a request you can replay with `curl` | a trace you have to watch |
| Effort to build | an afternoon of DevTools | days, and it never stops needing maintenance |

Which is why the order is always: **documented API → undocumented API → browser.** Never skip a
step because the browser is more fun.
