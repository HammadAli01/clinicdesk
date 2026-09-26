# ClinicDesk

Booking backend for a clinic's AI receptionist. Three callers share one service layer:
the web UI (tRPC), an AI agent (MCP server), and Stripe (webhooks).

Stack: Next.js 16 App Router · TypeScript strict · Drizzle + Postgres · tRPC v11 ·
Zod 4 · Vitest · Stripe · Google Calendar OAuth · MCP TypeScript SDK · pnpm.

## Commands
- `pnpm typecheck` · `pnpm test` · `pnpm lint`. Run all three before you say a task is done, and show the output.
- `pnpm db:up` starts Postgres in Docker. Tests need it running.
- `pnpm db:generate --name=<what_changed>` after any change to `src/server/db/schema.ts`.
- `pnpm db:migrate` applies migrations. Ask before running it.
- `pnpm db:seed` adds the demo services and, if `SEED_ADMIN_EMAIL` + `SEED_ADMIN_PASSWORD` are set, the first staff login. Idempotent.
- `pnpm dev` runs the app at http://localhost:3000.
- `npx @modelcontextprotocol/inspector npx tsx --env-file=.env.local mcp/server.ts` opens the MCP Inspector.

## Branches, CI and deploys
- Flow: `feature/*` → squash-merged PR into `development` → "Promote" workflows → `staging` → `main`.
  Open PRs against `development` only. Never push or open PRs to `staging`/`main`; promotion fast-forwards them.
- CI = `.github/workflows/_ci-checks.yml`: [typecheck ∥ lint] → Vitest → production build + Playwright.
  Keep `scripts/promote.sh` in sync with its `quality` job.
- Vercel deploys each branch. `scripts/vercel-build.sh` runs `db:migrate` before `next build`, so every
  migration must be backward compatible with the code still serving traffic (expand/contract).
- Serverless has no long-running process: scheduled work is an HTTP route (`/api/cron/*`, Bearer `CRON_SECRET`)
  called by `.github/workflows/sweep-holds.yml`. `pnpm jobs` (node-cron) is for local use.
- New env var? Add it to `src/env.ts`, the placeholder `env:` blocks in `_ci-checks.yml` and `promote-*.yml`,
  `scripts/ci-write-env.sh`, and each Vercel project.
- The project needs Node 22. Vitest won't start on Node 20.10.

## Where things live
- `src/server/services/*`: ALL business rules. Plain async functions, deps passed as the first arg (`db`, `stripe`).
- `src/server/trpc/*`, `mcp/create-server.ts`, `src/app/api/*`: thin adapters only.
  Parse input → call ONE service → map errors. No business logic here.
- `src/server/db/schema.ts`: tables. `drizzle/`: generated migrations (committed).
- `src/server/errors.ts`: `DomainError` for expected failures. Services never throw `TRPCError`.
- `src/trpc/client.tsx`: client hooks. Client files import only `type AppRouter`, never server values.
- Examples to copy: the router in `src/server/trpc/routers/bookings.ts`, the service in `src/server/services/bookings.ts`, the tests in `tests/bookings.test.ts`.

## Hard rules
- TypeScript strict. No `any`, no `as` casts (one documented exception in `src/server/db/index.ts`),
  no `!` in production code, no `@ts-ignore`. Don't make a field optional to silence an error.
  Handle the undefined case instead.
- Zod at every boundary: env, tRPC input, MCP tool input, webhook fields, third-party responses.
- Never edit a committed migration in `drizzle/`. Write a new one. Never run `drizzle-kit push`.
- Double-booking is prevented by the exclusion constraint in `drizzle/0001_*` (error `23P01`).
  Don't replace it with a check-then-insert in app code.
- State changes use conditional updates (`WHERE status = 'pending_payment'`) so they're idempotent.
- Times: store UTC `timestamptz`. The clinic is Asia/Karachi (UTC+5). Use helpers in `services/slots.ts`.
- Money in integer cents.

## Tests
- Every service change ships with a test in `tests/` against the real test DB (`.env.test`). Don't mock Drizzle.
- Assert behaviour (values, DB state, status codes), not `toBeDefined()`.
- NEVER delete or weaken an assertion to make a test pass. If you think a test is wrong,
  stop and explain why.
- **Only ONE session runs `pnpm test` at a time.** Every test truncates the shared
  `clinicdesk_test` database, so two concurrent runs (two agents, or an agent and a reviewer)
  wipe each other's rows and produce false failures that look like impossible application bugs:
  a row vanishing between its own INSERT and a later query in the same test, or a duplicate-key
  error on a table you just truncated. If you need a concurrent run, create your own database and
  point `DATABASE_URL` at it — `vitest.config.ts` and `tests/global-setup.ts` both prefer a shell
  `DATABASE_URL` over `.env.test` for exactly this. Logged three times in `AI_LOG.md`.
- On this machine a native PostgreSQL 17 service owns port 5432, so the container is also
  published on **5433**. Run the suite as:
  `$env:DATABASE_URL="postgres://clinic:clinic@localhost:5433/clinicdesk_test"; pnpm test`
- `pnpm` fails under Git Bash here (`node: line 1: This: command not found`, a broken global npm
  `node` shim). Use PowerShell, or `cmd.exe /c "pnpm ..."`.

## Library versions (agents get these wrong)
- tRPC v11 with `@trpc/tanstack-react-query`: `useQuery(trpc.x.queryOptions())`, NOT `trpc.x.useQuery()`.
  `transformer: superjson` goes on the link, not on `createTRPCClient`.
- Zod 4: `z.url()`, `z.uuid()`, `z.iso.date()`, `z.flattenError()`.
- MCP SDK: `server.registerTool(name, config, handler)`. Check `node_modules/@modelcontextprotocol/sdk` types
  before using any other method.
- If you're unsure an API exists, read its type definitions in `node_modules` first. Don't guess.

## Integrations: things that have bitten us
- Stripe webhook: `await req.text()` then `constructEvent`. Never parse JSON before verifying.
  Return 500 only when you WANT Stripe to retry. Ignored event types return 200.
- Google OAuth: refresh responses may omit `refresh_token`, so keep the old one. `invalid_grant` means disconnect, don't retry.
- MCP stdio server: never write to stdout (`console.log`). Use `console.error`.

## How to work with me
- For anything touching more than 2–3 files, propose a short plan first and wait for my OK.
- Keep diffs under ~300 lines. If a task is bigger, split it and say how.
- End every task with: what changed, the test names, the command output, and anything you were unsure about.
- When I correct the same mistake twice, suggest a line to add to this file.
