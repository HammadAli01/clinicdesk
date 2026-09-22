# 15 · Interview questions, mapped

Each row: what the job description asks for → the file that proves it → what to say. Read the
question, answer out loud from memory, *then* check. If you cannot explain a file without opening
it, you are not finished reading it.

## The job description, line by line

| They ask for | Proof in this repo |
|---|---|
| 3+ years professional TypeScript | *(not this project — use your real work)* |
| Shipped a React app real people used | *(not this project — use your real work. Say so.)* |
| Server-side TS including the database layer | `src/server/services/*`, `src/server/db/*` |
| Written your own migrations with an ORM | `drizzle/0000`–`0003`, including a hand-written `--custom` one |
| Zod at every boundary | `src/env.ts`, tRPC `.input()`, MCP `inputSchema`, `TokenResponse`, `SessionMetadata` |
| OAuth2 end to end incl. refresh, expiry | `src/server/integrations/google.ts` + `tests/google-oauth.test.ts` |
| Webhooks incl. retries, replay | `src/app/api/webhooks/stripe/route.ts` + `tests/stripe-webhook.test.ts` |
| Tests, unprompted | 9 test files, real Postgres, mutation-verified |
| Multi-tenant isolation *(nice to have)* | **not built** — described honestly in chapter 06 |
| Background jobs and queues *(nice to have)* | `src/server/jobs/*` — node-cron + BullMQ, one handler set |
| Stripe billing *(nice to have)* | `services/checkout.ts`, deposits, idempotency keys |
| Playwright *(nice to have)* | `e2e/`, plus the private-API connector pattern in chapter 11 |
| Written an MCP server *(nice to have)* | `mcp/create-server.ts` + `tests/mcp.test.ts` |
| Desktop packaging *(nice to have)* | `desktop/` + chapter 12 |
| Daily AI-agent use **with an opinion about where it fails** | `AI_LOG.md`, `CLAUDE.md`, `.claude/skills/`, chapter 14 |

> **Be honest about what this is.** It is a portfolio project, not production software with real
> patients. Say that before they ask. For "shipped and maintained a React application real people
> used", point at your real work. What this proves is backend depth and the discipline to build
> the hard parts properly — and it covers their "written an MCP server" nice-to-have outright.

---

## Backend basics

**Walk me through what happens when a patient books an appointment.**
> Client calls the tRPC mutation → the Next route handler → context identifies the caller → Zod
> validates the input → the procedure's middleware checks authorization → the service checks
> business rules (does the service exist, is the time bookable) → Drizzle builds the INSERT →
> Postgres enforces the exclusion constraint → a `DomainError` maps to 409, a bug to a logged 500
> → React Query invalidates the slot list. If there's a deposit, the service also creates a Stripe
> Checkout session with an idempotency key, and releases the hold if Stripe fails.

**Why validate on the server if the form already validates?**
> The client is under the user's control — anyone can send any request. And in this project the
> same service is called by an AI agent and by a webhook, neither of which has a form at all.
> Frontend validation is UX; server validation is correctness.

**Authentication vs authorization — give me a bug.**
> AuthN is who you are; AuthZ is what you may do to *which record*. The classic bug is
> `cancel(appointmentId)` that checks you're logged in but not that the appointment is yours, so
> changing the id cancels a stranger's booking. My cancel requires the id **and** the booking's
> phone number, both inside one conditional UPDATE, and returns the same error for either
> mismatch so you can't probe which ids exist.

**How do you prevent double-booking?** *(chapter 04)*
> It's a race, so application checks can't do it — two requests can both see the slot free before
> either commits, and a transaction doesn't help at READ COMMITTED. I use a Postgres exclusion
> constraint on `tstzrange(starts_at, ends_at, '[)')` with `&&`, partial on `status <> 'cancelled'`,
> added in a custom migration. The service catches `23P01` and returns 409. There's a test that
> fires two bookings with `Promise.allSettled` and asserts exactly one wins.

**What is idempotency and where did you need it?** *(chapter 04)*
> Doing it twice equals doing it once. I needed it for webhooks (Stripe delivers at-least-once),
> for outbound calls I might retry (an idempotency key on Checkout creation), for the calendar
> sync (I choose the Google event id, so a retry gets a 409 instead of a duplicate), and for the
> sweeper job. The tools are unique keys, insert-on-conflict, and conditional updates like
> `WHERE status = 'pending_payment'` — which also makes out-of-order delivery safe.

**Time zones?**
> Everything is `timestamptz` in UTC. I convert at the edges: opening hours are computed in
> Asia/Karachi (UTC+5, no DST, so a fixed offset is safe), and display uses `Intl.DateTimeFormat`
> with an explicit `timeZone`. For a zone with DST I'd use a real library rather than an offset
> constant — that's a bug waiting in `CLINIC.utcOffsetMinutes` if this ever ships outside Pakistan.

---

## ORM and migrations *(chapter 03)*

**Your migration workflow?**
> Edit `schema.ts`, `drizzle-kit generate`, **read the SQL**, commit it, then `drizzle-kit migrate`
> locally, in the test global-setup, and in the deploy. Hand-written SQL like the exclusion
> constraint goes in a `--custom` migration. Never edit an applied migration; never `push` on a
> shared database. Both bans are in `CLAUDE.md` and one is enforced by a pre-tool-use hook.

**Rename a column on a busy production table?**
> Expand and contract across several deploys: add the new column, write to both, backfill in
> batches, switch reads, stop writing the old one, drop it a release later. A direct rename breaks
> the old code still serving traffic during the rollout, and drizzle-kit may generate it as
> drop + add, which loses the data.

**Add a NOT NULL column to a table with rows?**
> Nullable first, backfill, then `SET NOT NULL` in a later migration. Postgres can't invent values
> for existing rows.

**Drizzle vs Prisma?**
> Same concepts, different spelling — there's a translation table in chapter 03. Drizzle is closer
> to SQL: plain TypeScript, no codegen, the query you read is the query that runs. Prisma has a
> nicer high-level API and better tooling but hides more and adds a generated client to keep in
> sync. Notably neither can express the exclusion constraint, so in both you'd hand-write that
> migration. I'd follow whichever the repo uses.

**How do you test database code?**
> Against a real Postgres test database, migrated with the same migration files production uses,
> truncated before each test. Mocking the ORM can't catch wrong SQL or a constraint that doesn't
> fire — the exact bugs that matter. Pure logic like slot arithmetic gets fast unit tests.

---

## tRPC and TypeScript *(chapter 05)*

**Why tRPC, and when would you not use it?**
> End-to-end types in one TypeScript repo with no codegen — the client imports only the router's
> type. I wouldn't use it for a public API consumed by other languages, and vendors can't use it
> at all, which is why the Stripe webhook and both OAuth routes are plain route handlers.

**How do errors flow from service to UI?**
> Services throw `DomainError` with a code. A middleware maps it to a `TRPCError` — the codes were
> chosen as a subset of tRPC's so the mapping is the identity function. The error formatter adds
> flattened Zod errors for forms. Anything else stays a 500 with a generic message, logged with
> its cause in `onError`.

**What does strict mode buy you?**
> It catches null/undefined access and implicit anys, and `noUncheckedIndexedAccess` makes
> `array[0]` possibly-undefined — which is where agents reach for `!` and hide the not-found case.
> For unknown data I type it `unknown` and parse with Zod, which gives a real type after runtime
> validation instead of a cast that asserts something I haven't checked.

---

## OAuth and webhooks *(chapters 07, 08)*

**Explain the authorization code flow. Why `state` and PKCE?**
> Redirect with client id, scope, redirect URI, `state` and a PKCE challenge; user consents;
> provider redirects back with a code; server checks `state`, then exchanges code + verifier +
> secret for tokens. `state` prevents CSRF — otherwise an attacker completes the flow with their
> own account and links the clinic's calendar to it. PKCE proves the party finishing the flow
> started it, so an intercepted code is useless.

**An integration stopped working at 3am. Logs say `invalid_grant`. What happened?**
> The refresh token is dead: revoked, password changed, rotated and we saved the wrong one, or —
> with Google in Testing mode — it hit the 7-day expiry. Retrying can't fix it. Mark the connection
> disconnected, stop calling, alert the customer to reconnect, and check whether our refresh code
> dropped a rotated token or raced itself. That's exactly what my `refreshAccessToken` does, and
> there's a test asserting the row is deleted rather than retried.

**Most common way an OAuth integration dies silently?**
> Saving `undefined` over the refresh token, because refresh responses usually omit
> `refresh_token`. The conditional spread is one line and there are two tests pinning it. It's also
> where an agent reaches for `as string` to silence the type error — the compiler had caught a
> real bug and the cast threw the catch away.

**How do you make a webhook endpoint safe and reliable?**
> Verify the signature over the **raw** body — `req.text()`, never `req.json()` then re-stringify —
> which also covers replay because Stripe's signature includes a timestamp with a 5-minute
> tolerance. Dedupe by event id with insert-on-conflict, plus a reclaim path for events that failed
> or got stuck in processing when a server died. Handlers are independently idempotent with
> conditional updates, so ordering doesn't matter. Return 500 only when you want a retry, and 200
> for events you ignore — a 500 there gets your endpoint disabled after three days of retries.

**Your mock tests pass. Is the integration done?**
> No. Mocks prove the code is shaped right, not that the vendor accepts it. The canonical example
> is a webhook that parses JSON before verifying: the mocked verifier passes, real Stripe returns
> 400 on every delivery. That's why my webhook tests sign payloads with
> `generateTestHeaderString` instead of mocking `constructEvent`, and why the last step is always
> `stripe listen` with a resend.

---

## MCP *(chapter 09)*

**What is MCP and what did you build?**
> A protocol that lets AI hosts discover and call tools, read resources, and use prompts from a
> server you write. Mine exposes task-shaped tools — list services, find slots, book, cancel —
> over the same service layer as my tRPC API, plus a resource for the upcoming schedule and a
> receptionist prompt. stdio for Claude Desktop and Code, tested with the SDK's in-memory client.

**How do you stop an AI agent doing something harmful through your MCP server?**
> The rules are in the service layer, not the prompt — a prompt is persuadable, a service function
> isn't. A hallucinated 3 a.m. booking is rejected by the same code that rejects a malicious HTTP
> client. Tools are narrow, with no generic SQL tool. Destructive ones need extra proof (the phone
> number) and carry `destructiveHint` so hosts confirm. Staff tools aren't permission-checked, they
> simply aren't registered in customer mode, so the model doesn't know they exist. Errors come back
> as `isError` results so it recovers instead of retrying blindly.

**stdio vs Streamable HTTP?**
> stdio: the host launches your server as a subprocess and speaks JSON-RPC over stdin/stdout.
> Simple, good for dev tools, and the classic bug is *anything* printing to stdout — including
> your package manager's banner, which is why hosts should launch `npx tsx` directly, not
> `pnpm mcp`. Streamable HTTP: the server runs at a URL, which a cloud voice agent needs, and it
> must have authentication, rate limits and audit logging, with the tenant from the token rather
> than a tool argument.

---

## Working with AI agents *(chapter 14, `AI_LOG.md`)*

**How do you give an agent your codebase's conventions?**
> `AGENTS.md` / `CLAUDE.md` with the commands, the architecture rules, an example file to copy,
> and the mistakes already caught. Skills in `.claude/skills/` for recurring multi-step jobs.
> A hook that blocks editing a committed migration, because a rule a tool enforces beats a rule
> you have to remember. And a fast feedback loop the agent runs itself: typecheck, tests, lint.
> Small well-scoped tickets matter more than clever prompting.

**Which tasks do you not hand to an agent?**
> Where a mistake is quiet and expensive: the data model and its constraints, authorization, money
> flows, token handling, destructive migrations, and the final live verification. On this project I
> kept the Stripe checkout service, the test configuration that decides which database gets
> truncated, and every test run. I hand off boilerplate, code following an existing pattern, UI
> from a component pattern, and first drafts of tests — which I then try to break.

**How do you review a 600-line AI-generated PR?**
> I don't. I ask for it split, because a diff I can't defend line by line shouldn't land. For each
> slice: check every unfamiliar API actually exists in the installed version, grep for `any`, `as`,
> `!`, new optional fields and `@ts-ignore`, read the **test diff separately**, mutate a line of
> source to confirm a test goes red, read migration SQL, and run it against the real vendor.

**Tell me about a time an agent got something wrong.**
> Use a real row from `AI_LOG.md`. The strongest one from this build isn't even a code bug:
> two agents ran the test suite concurrently against one shared test database, and each one's
> `TRUNCATE` landed inside the other's test. The symptoms looked impossible — a row vanishing
> between its own INSERT and a later query in the same test. What saved it is that both agents
> *reported the symptom* instead of adjusting an assertion to make the red go away. I changed the
> protocol so only I run the suite, and the real fix for parallel work is a database per worktree.
> Never say "the AI wrote it" — it's your code the moment you open the PR.

**How do you run agents in parallel safely?**
> One worktree per agent, its own branch, its own port **and its own test database**. Parallelise
> across the dependency graph, not the file list — I had two teams needing a file that didn't exist
> yet, so I wrote it myself, which also happened to be the file I shouldn't have delegated anyway.
> Expect migration-number collisions: the second branch to merge regenerates after rebasing.

---

## The four-minute demo

1. **The picture.** Three callers, one service layer (chapter 00).
2. **The AI books.** In Claude Desktop: *"HydraFacial tomorrow afternoon for Ayesha, 0300…"* →
   lists services → finds slots → confirms → books → returns a Stripe link.
3. **Pay** with `4242 4242 4242 4242`. The `stripe listen` terminal shows a 200.
4. **Confirmed everywhere.** Admin page shows *confirmed via ai_agent*; the event is in Google
   Calendar.
5. **Break it.** Ask the AI to book the same time → `CONFLICT`, and it offers alternatives.
   Resend the webhook → *"Duplicate, already handled"*.
6. **Prove it.** `pnpm test`: the concurrent-booking test, the duplicate-webhook test, the MCP test.
7. **The tooling.** Open `AI_LOG.md` and `CLAUDE.md`: here's what the agent got wrong, and the rule
   I added so it can't recur.

## The application paragraph

Fill this with your *real* log entries, not the template:

> "I built ClinicDesk, a booking backend for an AI receptionist — Next.js, tRPC, Drizzle/Postgres,
> Stripe, Google Calendar, and an MCP server over the same service layer — driving Claude Code with
> a `CLAUDE.md` I kept updating and a hook that blocks edits to applied migrations. I handed off the
> tRPC and provider boilerplate, the booking form, and first drafts of tests. I kept the schema and
> the double-booking constraint, the Stripe checkout flow, the OAuth refresh logic, and every test
> run, because mistakes there are quiet and costly. The most useful thing that went wrong: two
> agents running the test suite at once silently truncated each other's rows, which surfaced as a
> database row disappearing mid-test. They reported the symptom rather than weakening the
> assertion; I diagnosed the shared-database contention, changed the protocol so only I run the
> suite, and wrote up the worktree-per-agent fix in the repo. I also verified the tests actually
> bite by breaking the booking guard on purpose and watching the right test go red."
