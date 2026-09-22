# 03 · Migrations, comfortably

The job description says: *"Written your own database migrations with an ORM, confidently."*
Confidence here is not about remembering commands. It is about knowing what each command does to
a database that other people are currently using.

## The loop

```
edit src/server/db/schema.ts
        ↓
pnpm db:generate --name=what_changed      writes drizzle/NNNN_what_changed.sql + a meta snapshot
        ↓
READ THE GENERATED SQL                    ← the step everyone skips, and the only one that matters
        ↓
git add drizzle/                          migrations are history; they get committed
        ↓
pnpm db:migrate                           applies pending files, records them in __drizzle_migrations
```

| Command | What it does | When |
|---|---|---|
| `drizzle-kit generate` | Diffs `schema.ts` against the last snapshot, writes a new `.sql`. **Does not touch the database.** | after every schema edit |
| `drizzle-kit generate --custom` | Writes an *empty* migration for SQL you hand-write | constraints, extensions, backfills — anything the schema DSL can't express |
| `drizzle-kit migrate` | Applies pending files in order, tracked in the `drizzle.__drizzle_migrations` table | locally, in `tests/global-setup.ts`, and in deploy |
| `drizzle-kit push` | Shoves the DB into whatever shape `schema.ts` says, **with no migration file** | throwaway prototypes only. Never on a shared database. Banned in `CLAUDE.md`. |
| `drizzle-kit studio` | Browser UI over your data | debugging, and for forcing a token to expire by hand |

## Our four migrations, and why each exists

| File | Kind | Teaches |
|---|---|---|
| `0000_init.sql` | generated | the baseline: four tables, an enum, a foreign key, three indexes |
| `0001_no_overlapping_appointments.sql` | **`--custom`, hand-written** | a guarantee the ORM's DSL cannot express: `CREATE EXTENSION btree_gist`, an `EXCLUDE USING gist` constraint, a `CHECK` |
| `0002_appointment_notes.sql` | generated | the everyday additive change: `ADD COLUMN "notes" text` — nullable, so existing rows are fine |
| `0003_unique_service_name.sql` | generated, annotated | adding a **constraint to a table that already exists**, and what that costs under load |

Migration 0001 is the one to show someone. It is the moment where you stop describing data and
start enforcing a business invariant, and Drizzle's TypeScript DSL has no way to say it:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_no_overlap"
  EXCLUDE USING gist (tstzrange("starts_at", "ends_at", '[)') WITH &&)
  WHERE ("status" <> 'cancelled');

ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_ends_after_starts" CHECK ("ends_at" > "starts_at");
```

`btree_gist` is enabled because a GiST index natively handles ranges but not plain equality. The
moment you add multi-tenancy you will want `EXCLUDE USING gist (clinic_id WITH =, tstzrange(…) WITH &&)`
— mixing an equality column with a range column — and that needs the extension. Enabling it now
costs nothing.

## Rules that keep production alive

**1. Commit `drizzle/`, including `meta/`.** The `.sql` files are the history and the snapshots
are how `generate` knows what changed. Deleting a snapshot makes the next generate produce a
nonsense diff.

**2. Never edit a migration that has already run anywhere shared.** Drizzle records a hash of
each applied file. Editing a file that has run makes the next `migrate` disagree with reality,
and in the worst case re-run a statement. The fix for a bad migration is always a *new*
migration. This repo enforces it mechanically — `.claude/hooks/protect-files.mjs` blocks any
edit to a file under `drizzle/` that git already tracks.

**3. Read the generated SQL, every time.** Rename a column and drizzle-kit asks whether you meant
a rename or a drop-and-create. Answer wrong and you delete a column full of data. There is no
undo, and the diff looks perfectly innocent in a pull request.

**4. Breaking changes take three deploys — "expand, migrate, contract".**
To make `notes` required:
- deploy 1: add it nullable (already done in 0002);
- deploy 2: backfill existing rows, and make the app always write it;
- deploy 3: `SET NOT NULL`.

To rename `customer_phone` → `phone`:
- add `phone`, write to **both** columns, backfill in batches, switch reads to `phone`, stop
  writing `customer_phone`, and drop it a release later.

Why the ceremony? Because during a rollout the *old* code is still serving traffic against the
*new* schema. Every migration must be compatible with the version of the code that is currently
running, not just the one you are about to deploy.

**5. `ADD COLUMN … NOT NULL` with no default fails on a table with rows.** Postgres cannot invent
values for the rows that already exist. Add nullable, backfill, then constrain.

**6. Watch what a migration locks.** `CREATE INDEX` takes a `SHARE` lock: writes block until the
index is built. On an empty table that is instant; on ten million rows it is an outage, and the
answer is `CREATE INDEX CONCURRENTLY` in a migration of its own (it cannot run inside a
transaction block). `ALTER TABLE … ADD CONSTRAINT` with a validation scan is the same story —
`NOT VALID` followed by `VALIDATE CONSTRAINT` lets you split the lock.

**7. `push` is for prototypes.** It leaves no file, so staging and production drift apart with no
record of how. Both `CLAUDE.md` and `.claude/settings.json` ban it here.

## Two failures we actually hit building this

Both are in `AI_LOG.md`. They are worth reading before you write your next migration.

### `drizzle-kit migrate` swallowed a connection error

The first run failed with a spinner and a bare `exit code 1` — no message. The natural
assumption is "my SQL is wrong". It wasn't:

1. Applied each `drizzle/*.sql` by hand to a throwaway database with
   `psql -v ON_ERROR_STOP=1`. All four applied cleanly → the SQL was fine.
2. Ran the same migration through **drizzle-orm's** `migrate()` (the function
   `tests/global-setup.ts` uses) instead of drizzle-kit's CLI. That printed the real error:
   `28P01 password authentication failed for user "clinic"`.
3. Root cause: a natively installed **PostgreSQL 17 Windows service** already owned host port
   5432, so `localhost:5432` never reached the Docker container at all. Fix: publish a second
   port (`5433:5432`) from the container, and let a shell `DATABASE_URL` override `.env.test`.

The transferable lesson is step 2: **when a tool hides an error, re-run the same operation
through a layer that doesn't.** That is a debugging move you can describe in an interview.

### A code comment broke a migration

While annotating `0003`, I wrote a sentence that happened to contain the exact marker Drizzle
writes between statements in a generated file. The migrator split the file *inside my comment*
and sent the leftover fragment to Postgres → `42601 syntax error`.

Generated files can have in-band signalling. Prose inside them is not inert.

## Prisma, because one of their products uses it

Gracero is on Prisma. The concepts are identical; only the spelling changes.

| Concept | Drizzle | Prisma |
|---|---|---|
| Schema | `schema.ts` (plain TypeScript) | `schema.prisma` (its own DSL) |
| Create a migration | `drizzle-kit generate` | `prisma migrate dev --name x` |
| Apply in production | `drizzle-kit migrate` | `prisma migrate deploy` |
| Prototype sync | `drizzle-kit push` | `prisma db push` |
| Hand-written SQL | `generate --custom` | `migrate dev --create-only`, then edit |
| Load relations | `db.query.appointments.findMany({ with: { service: true } })` | `prisma.appointment.findMany({ include: { service: true } })` |
| Transaction | `db.transaction(async (tx) => …)` | `prisma.$transaction(async (tx) => …)` |
| Raw SQL | `` sql`…` `` | `prisma.$queryRaw` |
| Row types | `typeof appointments.$inferSelect` | generated client types |

The same `appointments` table in Prisma:

```prisma
model Appointment {
  id            String            @id @default(uuid()) @db.Uuid
  serviceId     String            @map("service_id") @db.Uuid
  service       Service           @relation(fields: [serviceId], references: [id], onDelete: Restrict)
  customerName  String            @map("customer_name")
  customerPhone String            @map("customer_phone")
  startsAt      DateTime          @map("starts_at") @db.Timestamptz
  endsAt        DateTime          @map("ends_at")   @db.Timestamptz
  status        AppointmentStatus @default(pending_payment)

  @@index([startsAt])
  @@map("appointments")
}
```

Note what Prisma *also* cannot express: the exclusion constraint. In Prisma you would write it in
a `--create-only` migration by hand, exactly as we did here. The interesting parts of a schema
tend to live outside the ORM's DSL in either tool.

**The honest comparison to give:** Drizzle is closer to SQL — plain TypeScript, no codegen step,
and the query you read is the query that runs. Prisma has a nicer high-level API and better
tooling but hides more, and its generated client is another build artifact to keep in sync.
The discipline is identical in both: generate, read the SQL, commit, apply migrations before the
new code serves traffic, never edit what has already run.
