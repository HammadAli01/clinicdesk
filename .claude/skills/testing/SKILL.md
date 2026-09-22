---
name: testing
description: How to write and run ClinicDesk tests with Vitest against the real Postgres test database — unit, integration, webhook and MCP tests. Use when adding a feature, fixing a bug, or when tests fail.
---

# Testing in ClinicDesk

## Setup facts
- Runner: Vitest (`pnpm test`, or `pnpm exec vitest run tests/<file>.test.ts` for one file).
- DB: real Postgres `clinicdesk_test` from `.env.test`. `tests/global-setup.ts` runs migrations;
  `tests/setup.ts` truncates tables before EACH test. Needs `pnpm db:up`.
- Files run one at a time (`fileParallelism: false`) because they share one DB.

## Pick the right kind
| Code | Test type | Example file |
|---|---|---|
| Pure function (no I/O) | Unit | `tests/slots.test.ts` |
| Service touching the DB | Integration, real DB | `tests/bookings.test.ts` |
| Route handler (webhook) | Call the exported `POST` with a real `Request` | `tests/stripe-webhook.test.ts` |
| MCP tool | In-memory MCP client | `tests/mcp.test.ts` |

## Every new behaviour gets
1. The happy path, with assertions on real values and DB state.
2. At least one failure path (`rejects.toMatchObject({ code: "CONFLICT" })`, 400 status, `isError: true`).
3. If relevant: a duplicate/retry case (run it twice, assert one effect) and a concurrency case
   (`Promise.allSettled` of two calls, assert exactly one succeeds).

## Rules
- Don't mock Drizzle or Postgres. Mock only what we can't run locally, and say so in a comment.
- For Stripe webhooks, sign real payloads with `stripe.webhooks.generateTestHeaderString`.
  Never mock `constructEvent`.
- Use future dates relative to `Date.now()` so tests don't expire.
- Assertions must fail if the behaviour breaks. `toBeDefined()` alone is not a test.
- `!` is acceptable in tests only.

## Prove the test works (mutation check)
After writing a test, break the code it covers on purpose (flip a condition, remove a WHERE clause),
run the test, confirm it FAILS, then restore the code. Mention that you did this in your report.

## When a test fails
1. Read the failure and decide: is the code wrong, or the test?
2. If the code is wrong, fix the code.
3. If you believe the test is wrong, STOP. Explain why to the user. Never change expected values
   or delete assertions just to make it pass.
