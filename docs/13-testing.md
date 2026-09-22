# 13 · Testing strategy

> *"You write tests unprompted. Your pull requests arrive with them."*
> and
> *"You notice when the agent … wrote a test that asserts nothing, or 'fixed' a failing test by
> deleting the assertion."*

Both halves matter. Writing tests is table stakes; **knowing which tests are worthless** is the
part being screened for.

## Three kinds, and when each is right

| Kind | Tests | Speed | Example here |
|---|---|---|---|
| **Unit** | a pure function, no I/O | milliseconds | `computeFreeSlots` — `tests/slots.test.ts` |
| **Integration** | your code against a **real** Postgres | ~1s | booking twice → `CONFLICT`; two at once → exactly one wins |
| **Contract / end-to-end** | a whole path as the caller experiences it | seconds | a genuinely signed Stripe webhook; a real MCP client over in-memory transport; Playwright in a browser |

The split is not about purity, it's about what each can catch. A unit test can prove your slot
arithmetic handles a 90-minute service at closing time. It can never prove your exclusion
constraint fires. Only a real database can do that, so the rule in `CLAUDE.md` is blunt:
**don't mock Drizzle.**

## How the real-database setup works

```ts
// vitest.config.ts
env: { ...testEnv, DATABASE_URL: databaseUrl },   // .env.test → a SEPARATE database
globalSetup: ['./tests/global-setup.ts'],         // migrate once, with the real migration files
setupFiles: ['./tests/setup.ts'],                 // TRUNCATE before every test
fileParallelism: false,                           // one shared DB: files must not interleave
include: ['tests/**/*.test.ts'],
exclude: ['**/node_modules/**', 'e2e/**', '.next/**'],
```

Four decisions worth defending:

**A separate database, not a separate schema.** `clinicdesk_test` is created by
`docker/init-test-db.sql`. `tests/setup.ts` runs `TRUNCATE … CASCADE` before every test, which
would be catastrophic against the development database. A wrong `DATABASE_URL` should be
impossible, not merely unlikely — so the config reads `.env.test`, and only an explicit shell
override can change it.

**Migrate with the production migration files.** `tests/global-setup.ts` calls the same
`migrate()` over the same `drizzle/` folder that a deploy uses. A test schema built any other way
(`push`, a hand-written fixture SQL) tests a database that does not exist anywhere else — and
would not have the exclusion constraint, which is the single most important thing to test.

**`fileParallelism: false`.** Every file shares one database. Run two files at once and one
file's `TRUNCATE` wipes the other's rows mid-test. The symptom is a suite that passes alone and
fails in CI — the worst kind of failure to chase. (The cost: the suite is slower. Worth it. The
alternative is a database per worker, which is what you'd build if the suite grew.)

**`include` is explicit.** Vitest 5's default `include` didn't match `tests/*.test.ts` here and
the run reported *"No test files found"* — while exiting **1**, fortunately. Had it exited 0, CI
would have been green with zero tests running. Name your test paths explicitly; "no tests" and
"all tests pass" must never look alike.

## Assert behaviour, not existence

Here is the test an AI writes when it wants to be finished:

```ts
// Everything about this is wrong.
it('books an appointment', async () => {
  const db = { insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue([{}]) }) }) };
  const result = await bookAppointment(db as any, input);
  expect(result).toBeDefined();
});
```

1. It mocks the database, so **no SQL ever runs** — the constraint, the types, the column names
   are all untested.
2. `as any` defeats the type system at the exact boundary it exists to protect.
3. `toBeDefined()` passes for literally any non-undefined value, including a completely wrong
   booking.
4. It asserts no business rule at all.

Delete the entire body of `bookAppointment` and replace it with `return {}` — this test still
passes. That is the definition of a decorative test.

Compare with the real one:

```ts
it('confirms immediately when the service has no deposit', async () => {
  const svc = await seedService();
  const { appointment } = await bookAppointment(db, { serviceId: svc.id, startsAt: futureLocal(10), ...alice });
  expect(appointment.status).toBe('confirmed');
  expect(appointment.endsAt.getTime() - appointment.startsAt.getTime()).toBe(60 * 60_000);
});
```

Exact status. Exact duration. Real row, real Postgres.

### The red flags, as a review checklist

- `toBeDefined()`, `toBeTruthy()`, `not.toThrow()` as the *only* assertion
- `expect(mock).toHaveBeenCalled()` — asserting against your own mock, not against a result
- `as any` / `as unknown as X` anywhere in a test file
- a mocked vendor SDK where a real check was available (`constructEvent`, most of all)
- an expected value that was clearly edited to match whatever the code returned

That last one deserves its own rule, and it is in `CLAUDE.md`: **never delete or weaken an
assertion to make a test pass.** If a test looks wrong, stop and explain why. Read the diff of
test files *separately* from the diff of source files — a green suite after a source change plus
a quietly edited expectation is the most dangerous pattern in AI-assisted work.

## The mutation check: the only proof a test works

A test you have never seen fail is a test you don't know works. So break the code on purpose:

```
1. Replace the bookable-time check with `const bookable = true;`
2. pnpm test
   → FAIL  tests/bookings.test.ts > refuses times outside opening hours (e.g. an AI inventing 3am)
     AssertionError: promise resolved "{ appointment: … }" instead of rejecting
3. Revert.
```

Done once during this build, on the guard that matters most. Two minutes, and now the claim
"these tests catch regressions" is evidence instead of a hope. Do it every time an agent hands
you a test file.

## What we stub, and why that is not hypocrisy

We never mock the database. We *do* replace `globalThis.fetch` in `tests/google-oauth.test.ts`.
The difference is whose correctness is under test:

- **Our SQL, our constraints, our schema** → must be real, because they are what we are testing.
- **Google's token endpoint** → cannot be real in CI (it would need live credentials, a network,
  and a deliberately expired token). What we're testing is *our reaction* to its responses:
  a missing `refresh_token`, an `invalid_grant`, a 429.

Stubbing the vendor lets us construct responses that are hard to produce on demand. That is a
legitimate seam; mocking your own persistence layer is not. There is a comment in the test file
saying exactly this, so the next reader doesn't have to guess.

And the limit of stubbing is stated in the job description itself: *"Passing mock tests proves
the code is shaped right, not that the vendor accepts it."* Which is why the webhook tests sign
payloads with `stripe.webhooks.generateTestHeaderString` rather than mocking `constructEvent` —
and why the last verification step is always the real thing: `stripe listen`, a real Google
account, the MCP Inspector, a real browser.

## The suite

| File | Kind | Covers |
|---|---|---|
| `tests/slots.test.ts` | unit | opening hours, back-to-back vs overlap, past slots, a duration that doesn't divide the day |
| `tests/bookings.test.ts` | integration | deposit vs no-deposit, `CONFLICT`, **concurrent booking**, 3 a.m. rejection, cancel authorization, `confirmPayment` idempotency |
| `tests/google-oauth.test.ts` | integration + stubbed vendor | refresh without rotation, rotation, `invalid_grant` disconnect, single-flight, no-network-when-valid, 429 backoff |
| `tests/stripe-webhook.test.ts` | contract | real signatures, duplicate delivery, wrong secret, missing header, ignored types, **out-of-order expiry** |
| `tests/verify-hmac.test.ts` | unit | constant-time compare, and the length-mismatch crash |
| `tests/trpc.test.ts` | integration | procedures via `createCallerFactory`, guard behaviour, `DomainError` → tRPC code |
| `tests/holds.test.ts` | integration | the sweeper releases only what it should — **especially not confirmed bookings** |
| `tests/mcp.test.ts` | contract | a real MCP client over in-memory transport; tool visibility per mode; `isError` results |
| `e2e/booking.spec.ts` | end-to-end | a real browser against a real server (chapter 11) |

## Running it

```bash
pnpm test                 # whole suite
pnpm test:watch           # while working
pnpm exec vitest run tests/bookings.test.ts    # one file
```

On this machine a native PostgreSQL 17 service occupies port 5432, so the container is also
published on 5433 and the suite is run with an explicit override:

```powershell
$env:DATABASE_URL="postgres://clinic:clinic@localhost:5433/clinicdesk_test"; pnpm test
```

Both `vitest.config.ts` and `tests/global-setup.ts` prefer a shell `DATABASE_URL` over
`.env.test` precisely so this is possible without editing a committed file — the same mechanism
CI uses to point the suite at its own throwaway database.
