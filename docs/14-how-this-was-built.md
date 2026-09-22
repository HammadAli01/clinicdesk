# 14 · How the agent teams built this

> *"We run several coding agents in parallel across git worktrees… We expect you to produce the
> output of a small team. We also expect you to be more rigorous than a team, because generated
> code fails in quieter ways than hand-written code does."*

This chapter is the record of doing exactly that: which team built what, what I kept for myself,
every decision taken without asking, and — most usefully — **what went wrong with running agents
in parallel.**

## The team structure

Work was split into waves. Everything inside a wave ran **concurrently**; each wave depended on
the one before. Each team owned a **disjoint set of files**, which is the only thing that makes
parallelism safe.

| Wave | Teams (parallel) | Files owned | Outcome |
|---|---|---|---|
| **0** | *lead* | branch, deps, `drizzle.config.ts`, `vitest.config.ts`, `docker-compose.yml` | ✅ |
| **1** | **Data** | `db/schema.ts`, `db/index.ts`, `db/seed.ts`, `drizzle/0000–0002`, `tests/global-setup.ts`, `tests/setup.ts` | ✅ |
| | **Domain-Pure** | `errors.ts`, `services/slots.ts`, `tests/slots.test.ts` | ✅ 4 tests |
| **2** | **Bookings** | `services/bookings.ts`, `tests/bookings.test.ts` | ✅ 7 tests |
| | **Google** | `integrations/google.ts`, both OAuth routes, `services/calendar.ts`, `tests/google-oauth.test.ts` | ✅ 6 tests |
| **3** | **Webhook** | `webhooks/stripe-handler.ts`, the webhook route, `verify-hmac.ts`, 2 test files | ✅ 10 tests |
| | **API** | `trpc/init.ts`, routers, the tRPC route, `tests/trpc.test.ts` | ✅ 7 tests |
| | **MCP** | `mcp/create-server.ts`, `mcp/server.ts`, `tests/mcp.test.ts` | ✅ |
| | **Jobs** | `services/holds.ts`, `jobs/*`, `tests/holds.test.ts` | ✅ |
| **4** | **UI** | `trpc/client.tsx`, `components/BookingForm.tsx`, 3 pages | ✅ |
| | **Desktop** | `desktop/*` | ✅ |
| | **Automation** | `playwright.config.ts`, `e2e/*` | ✅ |
| **5** | **Reviewer**, **Security** | read-only audit of the whole diff | ✅ |

## What I kept for myself, and why

The rule from the build guide: **hand off work where a mistake is loud and cheap; keep work where
a mistake is quiet and expensive.**

| Kept by the lead | Why |
|---|---|
| `src/server/stripe.ts`, `services/checkout.ts` | Money. A mistake here charges a patient twice or loses a payment, and neither shows up in a type error. |
| The `services.name` unique constraint + migration `0003` | A schema decision with a data-loss dimension. Also: reading the generated SQL is the whole point. |
| `vitest.config.ts` | It decides which database the suite talks to. Getting it wrong means `TRUNCATE` against the dev database. |
| Running `pnpm db:migrate` and the whole test suite | Verification is not delegable. If I did not watch it go green, I do not get to say it is green. |
| The mutation test | See below — an agent will not break its own code on purpose. |
| Every chapter of this guide | The explanation has to be mine, or I cannot defend it. |

| Handed to a team | Why |
|---|---|
| The schema, from a spec | Loud failure: `pnpm db:generate` and `typecheck` catch mistakes immediately. |
| Services following an existing pattern | There was already `slots.ts`/`bookings.ts` to copy; the tests catch deviation. |
| The tRPC layer, the MCP tools, the UI | Boilerplate-shaped with one right answer, and fully covered by typecheck + tests. |
| First drafts of tests | Then I broke the code to see them fail. A test I haven't seen fail is a hope, not a test. |
| The Electron shell and the e2e specs | Additive, isolated, and they cannot break the existing app. |

## Decisions taken without asking

You said not to ask, so here is the ledger instead.

1. **Docs are a folder, not one file.** Fifteen chapters of a single 5,000-line markdown file is
   unreadable. `docs/README.md` is the index.
2. **A fourth migration (`0003_unique_service_name`)** that the build guide does not have. Team
   Data flagged that `db:seed` inserts duplicates on a second run because `.onConflictDoNothing()`
   has no unique constraint to conflict on. Fixing it demonstrates adding a constraint to an
   existing table — and what `CREATE INDEX` costs under load.
3. **Vitest reads `.env.test` with `processEnv: {}`**, not the guide's side-effecting `config()`.
   dotenv v18 changed its API; the guide was written against v16. A test run now *cannot* leak the
   test DB URL into the dev process.
4. **A shell `DATABASE_URL` overrides `.env.test`** in both `vitest.config.ts` and
   `tests/global-setup.ts`. Needed here to work around the port collision below, and it is what
   CI wants anyway.
5. **`docker-compose.yml` publishes 5432 *and* 5433.** A natively installed PostgreSQL 17 Windows
   service owns 5432 on this machine, so `localhost:5432` never reached the container. Publishing
   a second port fixed it without touching your `.env` files or stopping a system service.
6. **`docker/init-test-db.sql`** creates `clinicdesk_test` automatically on first volume creation,
   so a fresh clone is one `pnpm db:up` away from a working test suite.
7. **Background jobs ship with two runners.** node-cron by default (zero infrastructure), BullMQ +
   Redis behind an optional `REDIS_URL`, sharing one set of handlers. Redis is in
   `docker-compose.yml` behind a `queue` profile, off by default. Reasoning in chapter 10.
8. **Electron is scaffolded but `electron` is not installed.** It is a ~100 MB dev dependency that
   would slow every `pnpm install` to support a demo. `desktop/README.md` has the one command.
9. **`.mcp.json` added to `.gitignore`** — it contains a GitHub PAT in plaintext. It was never
   committed. **You should still revoke and regenerate that token.**
10. **`strict`/`verbose` turned off in `drizzle.config.ts`** while debugging a silent
    `drizzle-kit migrate` failure. They turned out not to be the cause, but they do try to open an
    interactive prompt that dies in a non-TTY shell (CI, an agent's shell), so they stayed off.
11. **Only the lead runs the test suite.** Forced by the incident below.

## What actually went wrong with parallel agents

This is the part worth reading twice, because it is the part nobody writes down.

### 1. Agents running the test suite concurrently corrupted the shared database

Two teams ran `pnpm test` at the same time against the one `clinicdesk_test` database. The
symptoms looked like application bugs and were deeply confusing:

- a `services` row vanishing between its own `INSERT` and a later query **in the same test**;
- foreign-key violations against a service id that had just been inserted;
- `mcp.test.ts` failing with "Expected at least one service";
- everything passing on an isolated re-run.

The cause: `tests/setup.ts` runs `TRUNCATE … CASCADE` before every test. `fileParallelism: false`
serialises files **inside one Vitest process** — it has no idea a second process exists. One
agent's `TRUNCATE` landed mid-flight in another agent's test.

**What made this recoverable is that the agents reported the symptom honestly instead of
"fixing" their tests to match.** A row disappearing mid-test is not something application code can
do; only another connection can. Two independent agents reached the same diagnosis, one of them
by checking `pg_stat_activity` for other live connections. Had either instead adjusted an
assertion to make the red go away, the bug would have been laundered into the codebase.

The fixes, in order of preference:
- **A database per worktree** — `clinicdesk_test_<branch>`, which is what the build guide's
  parallel-agent section recommends and what I would do for a longer run.
- **Only the lead runs the suite** — what I switched to, since agents can still prove their work
  with `typecheck` + `lint` and a scoped single-file run.

### 2. Two teams needed the same not-yet-written file

Both the tRPC router and the MCP server call `bookWithDeposit` from `services/checkout.ts`. Had
I launched them in the same wave as the team writing it, both would have failed `typecheck` on a
missing import and might have "helpfully" created their own version.

I wrote `checkout.ts` myself instead. That unblocked three teams at once *and* kept the money
path in my hands — the dependency graph and the "what do I not delegate" question turned out to
have the same answer.

The general rule: **parallelise across the dependency graph, not across the file list.** Draw the
graph first; the waves fall out of it.

### 3. The environment fought back, twice

- `pnpm` through Git Bash fails on this machine with `node: line 1: This: command not found` — a
  stray global npm `node` shim containing the text *"This file intentionally left blank"*. Every
  agent hit it and each worked around it independently (PowerShell, `cmd /c`). Once I knew, I put
  the workaround in every subsequent agent brief. **An environment quirk discovered once should be
  written into the next brief, not rediscovered by each agent.** That is the same principle as
  `AGENTS.md`, applied at the hour scale instead of the month scale.
- The port-5432 collision, diagnosed only by running the migration through a layer that doesn't
  swallow errors (chapter 03).

## Where the agents were right and I was wrong

Worth recording, because the failure mode of "review everything" is assuming the reviewer is
always right.

- **Team Domain-Pure refused a cast I had specified.** The build guide's `pgErrorCode` does
  `const err = e as { code?: unknown; cause?: { code?: unknown } }`. The agent pointed out this
  violates `CLAUDE.md`'s no-`as` rule and narrowed `unknown` with `typeof`/`in` instead — same
  behaviour, no cast. It was right and the guide was sloppy.
- **Team Webhook added Zod validation I had not asked for.** The Stripe SDK types
  `session.metadata` as `Record<string, string> | null`; the agent parsed it with
  `z.object({ appointmentId: z.uuid() })` rather than trusting the SDK, and made the
  *completed* path throw on a missing id while the *expired* path skips. That asymmetry is
  exactly right: a paid session you can't match is a lost payment; an expired one has nothing to
  release.
- **Team UI hit a lint rule I didn't know about.** `eslint-config-next`'s React Compiler rules
  reject `window.location.href = …` inside a callback; it used `window.location.assign()` instead.

## Where I had to correct the work

- One bug in `drizzle/0003` was **mine**: an explanatory comment containing Drizzle's
  statement-splitting marker cut the migration in half (chapter 03).
- `vitest.config.ts` needed an explicit `include`. Vitest 5's default didn't match
  `tests/*.test.ts` and reported *"No test files found"* — while exiting 1, thankfully. Had it
  exited 0, CI would have been green with zero tests running. **"No tests" and "all tests pass"
  must never look alike.**
- The mutation test was mine to run. No agent breaks its own code on purpose; that is a job for
  whoever is accountable for the result.

## The protocol, if you do this again

1. **Draw the dependency graph before the file list.** Waves come from the graph.
2. **One owner per file, stated explicitly in the brief.** "Do not create or edit any file outside
   this list" appeared in every brief and was respected every time.
3. **Give each agent the exact reference material** — here, line ranges of the build guide — plus
   the *installed* library versions and an instruction to check `node_modules` before using an
   API. Most "the AI invented an API" failures are really "the AI used the version it was trained
   on".
4. **Tell them what not to run.** Especially anything touching shared state.
5. **Ask for a structured report:** files, test names, deviations forced by versions, and
   *"anything you were unsure about"*. That last field caught the seed-duplication bug, the
   plaintext PAT, and the DB contention — none of which I asked about.
6. **The lead verifies.** Read every diff, run the suite yourself, and break the code on purpose
   at least once.
7. **Write the environment quirks into the next brief immediately.** Context that outlives the
   agent is the entire point.
