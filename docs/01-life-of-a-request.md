# 01 · The life of one request

This chapter is the backbone of every "walk me through…" answer you will ever give about this
project. Learn the sequence; everything else in the guide hangs off it.

## A patient clicks "Book 10:30"

```
 1. Browser          React calls trpc.bookings.book.mutationOptions()
                     → POST /api/trpc/bookings.book   body: {"json":{...}}
                     ↓
 2. Route handler    src/app/api/trpc/[trpc]/route.ts — a Next.js Route Handler.
                     Runs on the server. Node runtime, not edge.
                     ↓
 3. Context          createTRPCContext({ headers }) reads cookies and builds
                     ctx = { db, stripe, isAdmin }. "Who is calling?" answered ONCE.
                     ↓
 4. Input validation Zod parses the body. Bad phone number → stops here, 400,
                     with field-level errors the form can render.
                     ↓
 5. Authorization    Middleware on the procedure. publicProcedure lets anyone
                     through; adminProcedure throws UNAUTHORIZED if !ctx.isAdmin.
                     ↓
 6. Business rules   bookWithDeposit() → bookAppointment():
                       does the service exist?         → NOT_FOUND
                       is the time actually bookable?  → BAD_REQUEST
                       (opening hours, step grid, not in the past)
                     ↓
 7. ORM              db.insert(appointments).values(...).returning()
                     Drizzle builds a parameterised INSERT. No string concatenation,
                     so no SQL injection.
                     ↓
 8. Database         Postgres evaluates the exclusion constraint. If another
                     non-cancelled appointment overlaps this time range, the INSERT
                     is refused with SQLSTATE 23P01. This is the ONLY check that
                     holds when two requests arrive in the same millisecond.
                     ↓
 9. Error mapping    pgErrorCode(e) === "23P01"
                       → throw new DomainError("CONFLICT", "That time was just taken")
                     tRPC middleware turns DomainError.code into a tRPC code → HTTP 409.
                     Anything else stays a 500 and is logged with its cause.
                     ↓
10. Client           React Query receives the result, invalidates the slot list,
                     re-fetches, and the taken slot disappears from the UI.
```

Steps 6–8 are the interesting ones, and they are interesting for a reason that is easy to miss:
**step 6 and step 8 are not redundant.**

- Step 6 rejects *nonsense* (3 a.m., a past date, a 45-minute offset that isn't on the grid).
  It produces a good error message and it stops garbage before it reaches the database.
- Step 8 rejects *conflicts*. It is the only thing that works under concurrency, because two
  requests can both pass step 6 at the same instant.

If you delete step 6, an AI receptionist will happily book 03:00. If you delete step 8, two
patients get the same slot roughly once a week and you find out from an angry phone call.

## The same rules, four different doors

Now re-read that list and notice how little of it is about HTTP.

Steps 1–5 and 9–10 are *adapter* work. Steps 6–8 are the *service* and the *database*. When the
AI receptionist books instead of the browser, only the adapter changes:

| | Web UI | AI agent | Stripe | Cron |
|---|---|---|---|---|
| **1. transport** | HTTP/JSON | JSON-RPC over stdio | HTTP/JSON | a timer tick |
| **3. who is calling** | cookie → `isAdmin` | process mode → `customer`/`staff` | HMAC signature | trusted, in-process |
| **4. validation** | Zod in `.input()` | Zod in `inputSchema` | `constructEvent` + Zod on fields | none needed |
| **6–8. rules** | **`services/bookings.ts`** | **`services/bookings.ts`** | **`services/bookings.ts`** | **`services/holds.ts`** |
| **9. errors** | `DomainError` → HTTP 409 | `DomainError` → `isError` text the model can act on | failure → HTTP 500 so Stripe retries | failure → log + retry next tick |

That middle row never changes. That is the whole design.

## Where code is allowed to live

| Layer | Its job | It must NOT | In this repo |
|---|---|---|---|
| **Adapter** | Parse input, identify the caller, call **one** service, map errors to the caller's language | Contain business rules | `src/server/trpc/*`, `mcp/*`, `src/app/api/*`, `src/server/jobs/*` |
| **Service** | Business rules, orchestration, transactions | Know about HTTP, cookies, React, or MCP | `src/server/services/*` |
| **Data access** | Build and run SQL | Decide business rules | `src/server/db/*` (Drizzle) |
| **Database** | Store data; enforce guarantees that must never be violated | — | Postgres: unique, FK, CHECK, EXCLUDE |

Two practical tests you can apply to any diff:

1. **Could I call this function from a cron job with no HTTP request in sight?** If a service
   needs `req`, `cookies()`, or a `Response`, it is not a service.
2. **If I add a fifth caller tomorrow (SMS, a voice webhook, an admin CLI), how much of this do
   I rewrite?** Should be: the adapter only.

## Expected failures vs bugs

This distinction runs through the whole codebase and it is worth a paragraph of its own.

```ts
// src/server/errors.ts
export class DomainError extends Error {
  readonly code: "NOT_FOUND" | "CONFLICT" | "BAD_REQUEST" | "FORBIDDEN";
}
```

A `DomainError` means *the system worked correctly and the answer is no*. The slot is taken.
The phone number doesn't match. Those are not incidents; they are outcomes. They carry a
message that is safe to show a patient — or, in the MCP case, safe to read aloud to a caller.

Anything else — a `TypeError`, a dropped connection, a bug — is an incident. It becomes a 500,
the real cause gets logged (in production: Sentry, which AgentZap uses), and the caller gets a
generic message. You never leak a stack trace to a patient, and you never hide a real bug behind
a friendly message.

Services throw `DomainError`. **Services never throw `TRPCError`** — that would tie the business
rules to one of the four doors. The mapping happens in the adapter:

```ts
// tRPC middleware — src/server/trpc/init.ts
if (!result.ok && result.error.cause instanceof DomainError) {
  throw new TRPCError({ code: cause.code, message: cause.message, cause });
}
```

```ts
// MCP — mcp/create-server.ts
if (e instanceof DomainError) return fail(`${e.code}: ${e.message}`); // isError: true
```

Same error object. Two translations. That is what an adapter is for.

## HTTP status codes you will actually return

| Code | Meaning | In ClinicDesk |
|---|---|---|
| 200 | OK | slots returned; webhook accepted (including deliberately ignored event types) |
| 400 | Bad input | invalid phone; bad webhook signature; OAuth `state` mismatch |
| 401 | Not authenticated | admin page without the admin cookie |
| 403 | Authenticated, not allowed | staff of clinic A reading clinic B (multi-tenant; not built here) |
| 404 | Not found | unknown `serviceId`; a cancel where id+phone don't match |
| 409 | Conflict with current state | slot already taken (`23P01`) |
| 429 | Rate limited | what *Google* returns to us — we back off and retry |
| 500 | Our failure | webhook handler threw; **this is how you ask Stripe to retry** |

The only entry there that people get wrong in practice is 500. On a public webhook endpoint, a
status code is not a status report — it is an *instruction to the sender*. Returning 500 means
"try me again". Returning 200 means "done, forget it". Chapter 08 goes into what happens when
you get that backwards.
