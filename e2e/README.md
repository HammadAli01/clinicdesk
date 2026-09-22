# e2e/ -- browser automation

Two different jobs live under this repo's "browser automation" umbrella; only the first one has
code in this folder.

1. **`booking.spec.ts`** -- Playwright driving a real Chromium against the real booking flow.
   This is "Job 1: testing your own app in a real browser."
2. **`vendor-session.example.ts`** -- a commented, non-executing reference for "Job 2: driving
   someone else's app because they gave you no API" (the connector-platform pattern). It is not a
   test, is excluded from the Playwright run, and must never run in CI.

## Install (one-time)

```bash
pnpm add -D @playwright/test
pnpm exec playwright install chromium   # ~130 MB download
```

## Run

```bash
pnpm test:e2e        # headless, once
pnpm test:e2e:ui     # the time-travel debugger -- open this first when a test fails
```

`playwright.config.ts` starts `pnpm dev` on port 3000 for you (`reuseExistingServer: !CI`, so if
you already have `pnpm dev` running locally it reuses that server instead of starting a second
one). The suite needs a reachable Postgres -- see "Known gap" below if `pnpm dev` can't connect.

## What this covers that the Vitest suite (`tests/`) cannot

`tests/bookings.test.ts` calls `bookAppointment(db, …)` directly against a real test database.
That proves the business rules. It cannot prove that any of the following actually works, because
none of it exists in that path:

- the tRPC client is wired to the React provider at all;
- `superjson` survives the network round trip, so a slot's `Date` is still a `Date` in the browser
  and not an ISO string the component forgot to parse;
- the slot buttons render the clinic's Asia/Karachi time, not the browser's local timezone;
- a 409 from a slot someone else just took actually reaches a visible `error-message`, and not
  just an unhandled promise rejection in the console;
- clicking "Book appointment" once produces exactly one booking, end to end, through real HTTP.

Every one of those is a **wiring** failure: invisible to a unit test that skips the network, and
immediately visible to a browser that doesn't.

## Why these are excluded from `pnpm test`

`vitest.config.ts` already excludes `e2e/**`. Two different runners, two different jobs:

- Vitest's `tests/setup.ts` truncates the tables before every test. Playwright's tests run against
  a live `pnpm dev` server that other tests (and a human) may be using at the same time --
  truncating out from under it would corrupt whatever else is mid-request.
- Playwright needs a running server and a browser binary; Vitest needs neither. Bundling them into
  one `pnpm test` run would make the fast unit/integration loop slow and flaky for a reason that
  has nothing to do with the code being tested.

Run them separately: `pnpm test` for business rules, `pnpm test:e2e` for "does the real thing
actually work in a real browser."

## Design choices worth knowing about

- **`data-testid` selectors, not text/role selectors**, for the elements that exist specifically
  for automation (`service-select`, `slot-button`, `submit-button`, `success-message`, etc). Team
  UI defined this exact list before `BookingForm.tsx` was written, so the test and the markup were
  designed together. The landing-page test is the one place this suite uses `getByRole` instead,
  because those two links are plain content, not automation hooks.
- **No `waitForTimeout` anywhere.** Every assertion is a web-first assertion (`expect(locator)...`)
  that retries until it passes or times out. A fixed sleep is either too short (flaky) or too long
  (slow), often both depending on the machine.
- **Every date is computed relative to `now`**, never a hardcoded calendar date, and each test
  that needs a specific day uses its own offset from today so tests never contend for the same
  slot and can run in any order or in parallel.
- **The conflict test is the one that matters most.** It opens two browser contexts, has both load
  the same free slot, books it from the first, and asserts the second sees the "just taken" error.
  That is the entire point of testing this in a browser instead of a unit test: it proves the 409
  the server sends actually reaches something a patient can read.

## Known gap in this environment

On this machine a native PostgreSQL service already occupies port 5432, so `docker-compose.yml`
publishes the project's Postgres container on 5433 instead. `.env.local` (owned by another team)
still points at 5432. If `pnpm dev` can't reach the database, `pnpm test:e2e` will fail at the
`services-error-message` / `slots-error-message` states rather than the happy path -- that is an
environment/config issue outside this folder's ownership, not a bug in these specs. See the
top-level task report for whether the suite actually ran here.
