# 00 · Orientation

## What ClinicDesk is

A clinic has a phone. Today a human answers it. Tomorrow an AI receptionist does. Whoever
answers needs the same four abilities:

1. Tell the caller what the clinic offers.
2. Find genuinely free times — not times that *look* free.
3. Take the booking, and take a deposit for expensive treatments.
4. Put it in the clinic's Google Calendar so the staff see it.

ClinicDesk is the backend for exactly that. It exists to be **demonstrated**, so every part of it
is a part the job description asks about: Postgres with a real ORM, migrations you wrote
yourself, tRPC, OAuth2 with token refresh, Stripe webhooks with replay protection, an MCP
server, background jobs, browser automation, and tests that fail when you break the code.

## The one idea

Three callers. One service layer.

| Caller | Speaks | Enters through | Never contains rules |
|---|---|---|---|
| The web UI | tRPC over HTTP | `src/server/trpc/routers/*` | ✔ |
| The AI receptionist | MCP over stdio | `mcp/create-server.ts` | ✔ |
| Stripe | signed HTTP POST | `src/app/api/webhooks/stripe/route.ts` | ✔ |
| The clock | a cron tick | `src/server/jobs/*` | ✔ |

All four call the same functions in `src/server/services/*`. That is why the AI cannot book a
3 a.m. appointment even if it hallucinates one: the *rule* that 3 a.m. is not bookable lives in
`bookAppointment()`, not in the prompt, not in the form, not in the tool description.

This is what "full vertical slice" means in the job post, and it is the first thing to say when
someone asks you to walk them through the project.

## Folder map

```
clinicdesk/
├── AGENTS.md                 instructions every coding agent reads (Codex/Cursor read this)
├── CLAUDE.md                 the same rules for Claude Code
├── AI_LOG.md                 every mistake an agent made, and the rule that stops a repeat
├── docker-compose.yml        Postgres 16 (+ optional Redis for BullMQ)
├── drizzle.config.ts         tells drizzle-kit where the schema and the migrations live
├── drizzle/                  GENERATED SQL migrations — committed, never edited
├── vitest.config.ts          test runner; points at .env.test so tests can't touch dev data
├── playwright.config.ts      browser automation
├── desktop/                  Electron shell (chapter 12)
├── mcp/
│   ├── create-server.ts      builds the MCP server from deps — testable, no I/O at import
│   └── server.ts             stdio entry point an AI host launches as a subprocess
├── src/
│   ├── env.ts                process.env parsed by Zod once, at boot
│   ├── app/                  Next.js App Router: pages + route handlers
│   │   ├── book/             public booking page
│   │   ├── admin/            staff page
│   │   └── api/
│   │       ├── trpc/[trpc]/  the single tRPC endpoint
│   │       ├── oauth/google/ start + callback
│   │       └── webhooks/stripe/
│   ├── components/           React components
│   ├── trpc/client.tsx       the browser-side tRPC client and provider
│   └── server/               server-only. Never imported by a "use client" file.
│       ├── db/               schema.ts · index.ts · seed.ts
│       ├── errors.ts         DomainError — expected failures, not bugs
│       ├── stripe.ts         the Stripe SDK instance
│       ├── integrations/     google.ts — OAuth exchange, refresh, fetch wrapper
│       ├── services/         ALL BUSINESS RULES: slots · bookings · checkout · calendar · holds
│       ├── jobs/             cron/queue adapters that call those services
│       ├── webhooks/         stripe-handler.ts — pure event → service mapping
│       └── trpc/             init.ts · routers/*
└── tests/                    real Postgres, no mocked ORM
```

Two directories deserve special attention because they are where people put things in the
wrong place:

- **`src/server/services/`** — if a rule can be broken by a caller, the rule belongs here.
- **`src/app/api/`** and **`src/server/trpc/`** — adapters. If you find yourself writing `if` on
  business state in one of these, it is in the wrong file.

## Running it

```bash
pnpm install
pnpm db:up                 # Postgres 16 in Docker, data kept in a named volume
pnpm db:migrate            # applies drizzle/*.sql in order
pnpm db:seed               # three services to book
pnpm dev                   # http://localhost:3000/book
```

Tests need a second database (`clinicdesk_test`) which `docker-compose.yml` creates on first
boot; `tests/global-setup.ts` migrates it with the *same* migration files production uses.

```bash
pnpm typecheck && pnpm test && pnpm lint
```

For the AI receptionist:

```bash
pnpm mcp:inspect           # MCP Inspector — call your tools by hand, no model involved
```

## Environment

`src/env.ts` parses `process.env` with Zod **once, at import time**, and exports a typed `env`
object. Nothing else in the codebase reads `process.env` directly.

```ts
export const env = EnvSchema.parse(process.env);
```

That one line is the first boundary in the system. A missing `STRIPE_WEBHOOK_SECRET` crashes the
process on boot with a readable message, instead of silently failing on the first real payment
at 3 a.m. — which is exactly the failure mode the job description calls "the parts that break".

| Variable | Used by | If it's wrong |
|---|---|---|
| `DATABASE_URL` | Drizzle, drizzle-kit, tests | nothing works, loudly |
| `APP_URL` | Stripe success/cancel URLs, Google redirect URI | OAuth redirect mismatch, dead checkout links |
| `ADMIN_TOKEN` | the admin cookie guard | staff pages open to everyone |
| `GOOGLE_CLIENT_ID` / `_SECRET` | the OAuth token exchange | `invalid_client` at the callback |
| `STRIPE_SECRET_KEY` | checkout sessions | no payment links |
| `STRIPE_WEBHOOK_SECRET` | signature verification | every real webhook returns 400 |

> **Be honest about what this is.** This is a portfolio project, not production software with
> real patients. Say that plainly in an interview. What it *does* prove is that you can build a
> vertical slice with the hard parts included — and the hard parts here are real.
