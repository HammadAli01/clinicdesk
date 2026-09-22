# 04 · Races, locks and idempotency

Two patients tap "Book 10:30" in the same millisecond. What stops them both getting it?

The honest answer is: **not your TypeScript.** This chapter is about why, and what does.

## The race, precisely

Here is the code an agent writes when you ask it to prevent double-booking, and it is what most
people write by hand too:

```ts
// WRONG. Looks obviously correct. Fails roughly once per busy Tuesday.
const clash = await db.select().from(appointments)
  .where(overlaps(startsAt, endsAt));
if (clash.length > 0) throw new DomainError('CONFLICT', 'Slot taken');
await db.insert(appointments).values({ startsAt, endsAt, ... });
```

Interleave two requests on a timeline:

```
  time ──────────────────────────────────────────────►
  A:  SELECT → 0 rows ─────────────► INSERT ✓
  B:        SELECT → 0 rows ───────────────► INSERT ✓
```

Both `SELECT`s ran before either `INSERT` committed, so both saw an empty slot. There is no
sleep, no unusual load, nothing exotic — just two requests close together. The window is small,
which is exactly what makes it dangerous: it passes every manual test and every CI run, then
happens in production and you cannot reproduce it.

**Wrapping it in a transaction does not help.** A transaction gives you atomicity (all-or-
nothing) and isolation from *uncommitted* data. At Postgres's default `READ COMMITTED` level,
transaction B's `SELECT` simply doesn't see A's uncommitted row, so both still proceed. You would
need `SERIALIZABLE` plus retry-on-serialization-failure logic — more machinery, worse
performance, and still more code than the real answer.

## What actually works

Let the database refuse it:

```sql
-- drizzle/0001_no_overlapping_appointments.sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_no_overlap"
  EXCLUDE USING gist (tstzrange("starts_at", "ends_at", '[)') WITH &&)
  WHERE ("status" <> 'cancelled');
```

An **exclusion constraint** generalises `UNIQUE`. `UNIQUE` says "no two rows where these values
are *equal*". `EXCLUDE` says "no two rows where these values *relate* in this way" — here, where
their time ranges **overlap** (`&&`).

- `tstzrange(starts_at, ends_at, '[)')` builds a range from the two columns. `'[)'` = start
  inclusive, end exclusive, so 10:00–11:00 and 11:00–12:00 are back-to-back, not overlapping.
  Get that bound wrong and every adjacent booking is rejected.
- `WHERE (status <> 'cancelled')` makes it a **partial** constraint: cancelled rows stop blocking
  the slot, so a cancellation genuinely frees the time without deleting history.
- `USING gist` is the index type that can answer "does any existing range overlap this one?"
  quickly. `btree_gist` is enabled because you'll want to mix an equality column in later — for
  multi-tenancy: `EXCLUDE USING gist (clinic_id WITH =, tstzrange(...) WITH &&)`.

Postgres checks this **at insert time, holding the index lock**. There is no window. The second
insert fails with SQLSTATE `23P01`, and the service turns that into a 409:

```ts
try {
  const [row] = await db.insert(appointments).values({...}).returning();
  ...
} catch (e) {
  if (pgErrorCode(e) === '23P01') {
    throw new DomainError('CONFLICT', 'That time was just taken. Please pick another slot.');
  }
  throw e;   // anything else is a real bug — don't swallow it
}
```

This is "optimistic": we attempt the write and translate the failure, rather than asking
permission first. It's less code, it's faster (one round trip, not two), and unlike the check it
is actually correct.

### The test that proves it

```ts
it('lets exactly one of two simultaneous bookings win', async () => {
  const results = await Promise.allSettled([
    bookAppointment(db, { serviceId, startsAt: futureLocal(11), ...alice }),
    bookAppointment(db, { serviceId, startsAt: futureLocal(11), ...bob }),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
});
```

`Promise.allSettled` fires both without either waiting for the other. Exactly one fulfils.
This test **cannot pass against a mocked database** — which is precisely why `CLAUDE.md` forbids
mocking Drizzle.

> **Watch the agent.** Asked to fix double-booking, an agent will write the check-then-insert
> above and describe the problem as solved. It will also sometimes *keep* the constraint but add
> the check in front of it "for a better error message" — which is harmless but pointless; the
> `23P01` path produces the same message and is the one that runs under load.

## But the pre-check is still there — and it is not the race guard

`bookAppointment` does validate the time before inserting:

```ts
const bookable = computeFreeSlots({ ..., busy: [], now: new Date() })
  .some((s) => s.getTime() === input.startsAt.getTime());
if (!bookable) throw new DomainError('BAD_REQUEST', 'That is not a bookable time…');
```

Note `busy: []` — it is deliberately **not** asking "is anyone else booked here?". It only asks
"is this a legal time at all?": inside opening hours, on the 30-minute grid, not in the past.
That is a different question from the race, and it needs a different answer:

| Question | Answered by | Failure mode it prevents |
|---|---|---|
| Is this a legal time? | `computeFreeSlots` in the service | An AI receptionist booking 03:00 |
| Is this time free? | the exclusion constraint in Postgres | Two patients, one slot |

Delete the first and the AI books 3 a.m. Delete the second and you double-book. They are not
redundant, and saying so out loud is a good interview moment.

*(Verified, not assumed: I replaced `bookable` with `true` and re-ran the suite. The 3 a.m. test
went red with "promise resolved instead of rejecting", then I reverted. A test you haven't seen
fail is a test you don't know works.)*

## Idempotency: doing it twice must equal doing it once

Races are about two things happening at once. Idempotency is about **the same thing happening
twice** — and it is unavoidable, because every reliable network delivers at-least-once:

- Stripe retries a webhook until it gets a 2xx, for up to 3 days.
- Your own `fetch` to Stripe times out, you retry, and the first one had actually succeeded.
- A job runs again after a crash.
- A user double-clicks.

Four techniques, all of them used here:

### 1. Conditional updates — idempotency with no extra state

```ts
export async function confirmPayment(db: Db, appointmentId: string) {
  const rows = await db.update(appointments)
    .set({ status: 'confirmed' })
    .where(and(eq(appointments.id, appointmentId), eq(appointments.status, 'pending_payment')))
    .returning({ id: appointments.id });
  return rows.length > 0;   // false = already confirmed/cancelled. Not an error.
}
```

The second call matches zero rows and changes nothing. No "have I done this?" lookup, no flag
column, no lock — the `WHERE` clause *is* the check, and it is evaluated atomically with the
write.

It also fixes **out-of-order delivery** for free. Stripe does not promise order. If
`checkout.session.expired` arrives *after* the payment succeeded, `releaseUnpaidHold` finds the
row is no longer `pending_payment` and does nothing. A naive `set status = 'cancelled' where id
= …` would cancel a paid booking.

> Tests: *"confirmPayment is idempotent: the first call confirms, the second is a no-op"* and
> *"checkout.session.expired arriving after confirmation does not cancel it"*.

### 2. A unique key on the event — idempotency as a database constraint

```ts
const inserted = await db.insert(webhookEvents)
  .values({ id: event.id, type: event.type, status: 'processing' })
  .onConflictDoNothing()
  .returning({ id: webhookEvents.id });
if (inserted.length > 0) return true;   // we are the first: we own this event
```

`webhook_events.id` **is** Stripe's `evt_…` id, so a duplicate delivery collides on the primary
key. The insert either succeeds (we claim the event) or returns nothing (someone else has it).
One statement, race-safe, no `SELECT` first.

The re-claim path matters as much:

```ts
const reclaimed = await db.update(webhookEvents)
  .set({ status: 'processing', lastAttemptAt: new Date(), attempts: sql`${webhookEvents.attempts} + 1` })
  .where(and(eq(webhookEvents.id, event.id), or(
    eq(webhookEvents.status, 'failed'),
    and(eq(webhookEvents.status, 'processing'), lt(webhookEvents.lastAttemptAt, staleBefore)),
  )))
  .returning({ id: webhookEvents.id });
```

Retry a *failed* event, or one stuck in `processing` for 5+ minutes because the server died
mid-handler. Again a conditional update, so two concurrent retries cannot both win.

Note `attempts: sql\`${webhookEvents.attempts} + 1\`` — incrementing **in SQL**, not
`attempts: row.attempts + 1` in JavaScript. The JS version is a read-modify-write and loses
increments under concurrency. Small detail, same class of bug.

### 3. Idempotency keys on outbound calls

```ts
await stripe.checkout.sessions.create(params, { idempotencyKey: `deposit-${appointment.id}` });
```

If our request times out and we retry, Stripe returns the **same** session instead of creating a
second one. Idempotency is not only something you provide to others — it is something you ask
for when you're the client.

### 4. Choosing the remote id

```ts
const eventId = appt.id.replaceAll('-', '');    // our id, as Google's event id
if (!res.ok && res.status !== 409) throw new Error(...);   // 409 = already exists. Fine.
```

When a vendor lets you supply the id, supplying it turns *create* into *create once*.

## Two-system writes: "what if the second one fails?"

`bookWithDeposit` writes to two systems — our database, then Stripe. That is a distributed
transaction wearing a disguise, and there is no rollback across the boundary:

```ts
const { appointment, service } = await bookAppointment(deps.db, input);   // system 1 ✓
try {
  const session = await deps.stripe.checkout.sessions.create(...);        // system 2 ✗?
  ...
} catch (e) {
  await releaseUnpaidHold(deps.db, appointment.id);   // undo system 1
  throw e;
}
```

Without that `catch`, a Stripe outage leaves the appointment stuck in `pending_payment` forever.
Nobody gets an error, nobody gets charged, and the slot is silently unbookable. You'd find out
weeks later from "why is Tuesday always full?".

And because compensation can itself fail (what if the DB is down too?), there is a **second**
layer: the `release-expired-holds` job sweeps anything still `pending_payment` past its hold
window. Chapter 10.

Whenever you write to two systems, ask three questions:
1. What if the second write fails? → compensate.
2. What if the compensation fails? → a periodic sweeper.
3. What if the second write *succeeded* but the response was lost? → an idempotency key, so the
   retry is free.

## Defence in depth, on purpose

Notice the same guarantee is enforced more than once, deliberately:

| Guarantee | Layer 1 | Layer 2 |
|---|---|---|
| No double booking | exclusion constraint (`23P01`) | — (one layer is enough when it's the database) |
| No double payment processing | `webhook_events` primary key | handlers are conditional updates |
| No duplicate calendar event | our own id → Google 409 | `googleEventId` set on the row, skipped next time |
| No stuck holds | `checkout.session.expired` webhook | the `release-expired-holds` sweeper |

Two layers, because each is imperfect for a *different* reason: the dedupe table can be bypassed
by a bug, and the handler can be bypassed by an event that never arrives. Neither gap is covered
by the other layer's gap.
