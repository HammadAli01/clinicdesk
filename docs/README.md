# ClinicDesk — the guide

This folder is the explanation of the code in this repo. It is written for **you**, the person
who has to defend this project line by line in an interview, not for a stranger browsing GitHub.

Read it in order the first time. After that, use it as a reference.

| # | Chapter | What it answers |
|---|---------|-----------------|
| 00 | [Orientation](./00-orientation.md) | What ClinicDesk is, the one architectural idea, the folder map, how to run it |
| 01 | [The life of one request](./01-life-of-a-request.md) | What actually happens between a click and a row in Postgres; which layer may do what |
| 02 | [Database and Drizzle](./02-database-and-drizzle.md) | The schema and why every column is the way it is; how to query; joins, aggregates, the hard queries |
| 03 | [Migrations, comfortably](./03-migrations.md) | generate → read → commit → migrate; custom SQL; expand/contract; what kills production |
| 04 | [Races, locks and idempotency](./04-races-and-idempotency.md) | Double-booking, the exclusion constraint, conditional updates, transactions, two-system writes |
| 05 | [tRPC, properly understood](./05-trpc.md) | Context, procedures, middleware, routers, the wire format, how types reach the browser |
| 06 | [Routing and route guards](./06-routing-and-guards.md) | Every route in this app, who is allowed in, and how the guard is enforced |
| 07 | [OAuth2, tokens, refresh and expiry](./07-oauth-and-tokens.md) | The Google flow end to end, PKCE, state, refresh, single-flight, `invalid_grant`, retries |
| 08 | [Stripe and webhooks](./08-stripe-and-webhooks.md) | Checkout, deposits, raw-body signatures, replay, duplicate delivery, retries |
| 09 | [MCP: building your own server](./09-mcp.md) | What MCP really is, our tools, how to design tools, stdio traps, testing, going remote |
| 10 | [Background jobs](./10-background-jobs.md) | The unpaid-hold sweeper, node-cron vs BullMQ + Redis, making jobs safe to run twice |
| 11 | [Browser automation](./11-browser-automation.md) | Playwright end-to-end, and the "vendor with no public API" connector pattern |
| 12 | [Shipping this as a desktop app](./12-electron.md) | What Electron changes, what has to move, packaging, and Tauri for comparison |
| 13 | [Testing strategy](./13-testing.md) | Unit vs integration vs contract; how to tell a real test from a decorative one |
| 14 | [How the agent teams built this](./14-how-this-was-built.md) | The parallel-team log, every decision taken on your behalf and why |
| 15 | [Interview questions, mapped](./15-interview-map.md) | Each line of the job description → the file that proves it → the answer to say |

## The 60-second version

ClinicDesk is the booking backend for a clinic's AI receptionist. **Three completely different
callers share one service layer:**

```
   Browser (React) ──► tRPC router ────┐
                                       │
   AI agent ────────► MCP server ──────┼──► src/server/services/*  ──► Drizzle ──► Postgres
                                       │      (ALL business rules)
   Stripe ──────────► webhook route ───┤
                                       │
   Clock ───────────► job runner ──────┘
```

Everything else in this repo follows from that picture. A booking rule is written once, in a
plain async function that takes `db` as its first argument. tRPC, MCP, the Stripe webhook and
the cron job are **adapters**: they parse input, call exactly one service, and translate errors
into whatever their caller understands (an HTTP status, an `isError` tool result, a 500 that
makes Stripe retry).

If you remember one sentence from this entire guide, make it that one.
