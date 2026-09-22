# 02 · Database and Drizzle

## What an ORM is, in frontend terms

A database stores **tables**: columns are fields, rows are records. You talk to it in SQL. An
ORM lets you describe those tables in TypeScript and write queries as function calls, so you get
autocomplete and compile errors instead of typos discovered at runtime.

Drizzle in particular is a *thin* ORM: the queries you write look like the SQL they become.
That is a feature. When a query is slow you can read it; when something is impossible in the
query builder you drop to `sql\`…\`` without leaving the type system.

Three words you need to keep straight:

| Word | What it is | Where it lives |
|---|---|---|
| **Schema** | a TypeScript description of your tables | `src/server/db/schema.ts` |
| **Migration** | a SQL file that moves the real database from one version to the next | `drizzle/*.sql` |
| **Snapshot** | Drizzle's record of what the schema looked like at each migration, used to diff | `drizzle/meta/*.json` |

The schema is what your *code* believes. The migrations are what the *database* has actually
been told. Keeping those two in sync is the entire discipline of chapter 03.

## Our four tables

```
services ──┐
           │ 1:N (ON DELETE RESTRICT)
appointments
oauth_accounts     (one row per provider — Google)
webhook_events     (one row per Stripe event id)
```

### Every decision, and the reason you will be asked for

| Decision | Why |
|---|---|
| **UUID primary keys** (`uuid().primaryKey().defaultRandom()`) | Sequential integers leak business volume and are guessable. UUIDs are safe to put in a URL, a Stripe `metadata` field, or a tool result handed to a language model. |
| **Money in integer cents** (`priceCents`, `depositCents`) | Floating point cannot represent 0.1 exactly — `0.1 + 0.2 !== 0.3`. Stripe's API is in cents for the same reason. Do the arithmetic in integers and divide only when displaying. |
| **`timestamptz` everywhere** | Stores an absolute instant, not a wall-clock reading. `timestamp` (without zone) is a string with delusions of grandeur: it does not record which zone it meant. |
| **`ON DELETE restrict` on `service_id`** | Deleting a service that has appointments would silently destroy booking history. `restrict` makes the delete fail instead. `cascade` would have been the dangerous default. |
| **A status enum, not booleans** | `isPaid` + `isCancelled` can be `true`/`true`, which means nothing. One `status` column has exactly three legal values and Postgres enforces it. |
| **`source` column** (`web` / `ai_agent` / `staff`) | You will be asked "how many bookings did the AI actually take?" on day one. It also makes the demo visible: the admin list shows *confirmed via ai_agent*. |
| **Index on `starts_at`** | Every slot lookup filters by a time window. Without it Postgres scans the whole table. |
| **Index on `customer_phone`** | Cancellation looks up by phone; so does "have I spoken to this caller before?". |
| **`webhook_events.id` = Stripe's event id (text PK)** | Duplicate deliveries collide on the primary key. Idempotency for free, enforced by the database rather than by remembering to check. |
| **`unique(provider)` on `oauth_accounts`** | One clinic, one Google connection. It also turns "save tokens" into a single `INSERT … ON CONFLICT DO UPDATE` instead of a read-then-branch. |
| **`unique(name)` on `services`** (migration 0003) | Two services called "HydraFacial" is a data-entry bug — and without it, `.onConflictDoNothing()` in the seed has nothing to conflict on, so running the seed twice silently gives you six services. |

### The one line that does the real work

```sql
-- drizzle/0001_no_overlapping_appointments.sql
ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_no_overlap"
  EXCLUDE USING gist (tstzrange("starts_at", "ends_at", '[)') WITH &&)
  WHERE ("status" <> 'cancelled');
```

Read it as a sentence: *no two non-cancelled appointments may have overlapping `[start, end)`
ranges.* `&&` is Postgres's "ranges overlap" operator; `'[)'` makes the start inclusive and the
end exclusive, so 10:00–11:00 and 11:00–12:00 are back-to-back, not overlapping.

Chapter 04 is entirely about why this is a database constraint and not an `if` in TypeScript.

## Querying: the two styles

Drizzle gives you two APIs and it is worth knowing when to reach for each.

**The builder** — looks like SQL, gives exact control over what is selected:

```ts
const [svc] = await db.select().from(services).where(eq(services.id, id)).limit(1);
// svc is Service | undefined, because of noUncheckedIndexedAccess. Handle it:
if (!svc) throw new DomainError('NOT_FOUND', 'That service does not exist');
```

**The query API** — best when you want relations loaded for you:

```ts
const upcoming = await db.query.appointments.findMany({
  where: and(gte(appointments.startsAt, new Date()), ne(appointments.status, 'cancelled')),
  orderBy: [asc(appointments.startsAt)],
  with: { service: { columns: { name: true } } }, // a JOIN, written for you
  limit: 100,
});
```

`db.query.*` only exists because `src/server/db/index.ts` passes the schema into `drizzle()`.
That is what the `{ schema }` argument is for.

> **Watch the agent.** The single most common AI-generated line in a Drizzle codebase is
> `const svc = (await db.select()…)[0]!` or `as Service`. Both silence the "possibly undefined"
> error by *asserting the not-found case cannot happen* — which is exactly the case you need to
> handle. `noUncheckedIndexedAccess` exists to catch this; don't disarm it.

## The queries that matter here

### 1. Overlap (the busy-window query)

Two intervals overlap when **each starts before the other ends**. That is the whole trick:

```ts
await db
  .select({ start: appointments.startsAt, end: appointments.endsAt })
  .from(appointments)
  .where(and(
    ne(appointments.status, 'cancelled'),
    lt(appointments.startsAt, to),   // it starts before our window ends
    gt(appointments.endsAt, from),   // and it ends after our window starts
  ));
```

People reach for four `OR`-ed cases (starts inside, ends inside, contains, contained). Those two
comparisons cover all four. Say that in an interview and it lands.

### 2. The conditional update (idempotency in one statement)

```ts
const rows = await db
  .update(appointments)
  .set({ status: 'confirmed' })
  .where(and(eq(appointments.id, id), eq(appointments.status, 'pending_payment')))
  .returning({ id: appointments.id });

return rows.length > 0; // false = already confirmed or cancelled. Not an error.
```

The `WHERE status = 'pending_payment'` clause is doing two jobs. It makes a second call a no-op,
and it makes the operation safe under **out-of-order** delivery: a `checkout.session.expired`
that arrives after the payment succeeded cannot cancel a confirmed booking, because the row is
no longer `pending_payment`. No locks, no read-then-write, no transaction needed.

### 3. Upsert

```ts
await db.insert(oauthAccounts).values(values).onConflictDoUpdate({
  target: oauthAccounts.provider,   // the UNIQUE column the conflict is detected on
  set: values,
});
```

`onConflictDoNothing()` / `onConflictDoUpdate()` need a real unique constraint to conflict *on*.
No constraint, no conflict, no deduplication — that was the seed bug in migration 0003.

### 4. Transactions

```ts
await db.transaction(async (tx) => {
  await tx.update(appointments).set({ status: 'cancelled' }).where(eq(appointments.id, a));
  await tx.insert(appointments).values(newRow); // throws → the cancel is rolled back too
});
```

Everything inside gets `tx`, not `db`. Passing `db` by accident inside a transaction is a classic
bug: that statement runs on a *different connection*, outside the transaction, and does not roll
back. The type system will not catch it, so look for it in review.

Note what a transaction does **not** give you: it does not stop two concurrent transactions from
both inserting an overlapping appointment. Transactions give atomicity, not mutual exclusion.
For that you need the constraint (chapter 04).

### 5. Raw SQL, still parameterised

```ts
await db.execute(
  sql`SELECT count(*) FROM ${appointments} WHERE ${appointments.startsAt} > now()`,
);
```

Interpolating a table or column reference is safe — Drizzle renders it as an identifier.
Interpolating a *value* becomes a bind parameter, not string concatenation, so this is not an
injection vector. That is the reason to use `sql` rather than building strings yourself.

### 6. Aggregates and grouping, when you need a report

Not used in the app yet, but this is the shape of the question "how many bookings per service
this month, and what revenue?":

```ts
import { count, sum, sql } from 'drizzle-orm';

const report = await db
  .select({
    service: services.name,
    bookings: count(appointments.id),
    cents: sum(appointments.id).mapWith(Number), // placeholder: sum a money column
  })
  .from(appointments)
  .innerJoin(services, eq(appointments.serviceId, services.id))
  .where(gte(appointments.startsAt, startOfMonth))
  .groupBy(services.name)
  .orderBy(desc(count(appointments.id)));
```

Two things to remember: aggregates come back as **strings** from Postgres (`sum` returns
`numeric`), which is why `.mapWith(Number)` exists; and every non-aggregated column in the select
must appear in `groupBy`, or Postgres refuses the query.

## The connection pool, and the one cast in the codebase

```ts
const globalForDb = globalThis as unknown as { pgClient?: ReturnType<typeof postgres> };
const client = globalForDb.pgClient ?? postgres(env.DATABASE_URL, { max: 10 });
if (env.NODE_ENV !== 'production') globalForDb.pgClient = client;
```

In development, Next.js re-evaluates modules on every hot reload. Without this, each reload
opens a fresh pool of 10 connections and after a few minutes Postgres refuses new ones with
"too many clients". Stashing the client on `globalThis` survives module re-evaluation.

This is the **only** `as` in the production codebase, and it is there because `globalThis` is
genuinely untyped. Every other `as` in a diff is a smell worth a comment in review.
