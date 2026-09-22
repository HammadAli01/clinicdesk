# 08 · Stripe and webhooks

## The two directions

Payments involve traffic both ways, and the two halves have completely different threat models:

```
 OUTBOUND   you → Stripe      create a Checkout session          you control the request
 INBOUND    Stripe → you      "this session was paid"            ANYONE can send you this
```

The outbound half is an ordinary API call with one wrinkle (idempotency keys). The inbound half
is a **public endpoint on the internet that strangers can POST to**, and every line of
`src/app/api/webhooks/stripe/route.ts` exists because of that.

## Outbound: the deposit

Expensive treatments take a deposit. `bookWithDeposit` books the appointment first (so the slot
is held) and then creates a Checkout session:

```ts
const session = await deps.stripe.checkout.sessions.create(
  {
    mode: 'payment',
    line_items: [{ quantity: 1, price_data: {
      currency: 'usd',
      unit_amount: service.depositCents,          // integer cents. Never a float.
      product_data: { name: `Deposit: ${service.name}` },
    }}],
    metadata: { appointmentId: appointment.id },  // the ONLY link back to our row
    success_url: `${env.APP_URL}/book?paid=${appointment.id}`,
    cancel_url: `${env.APP_URL}/book`,
    expires_at: Math.floor(Date.now() / 1000) + 35 * 60,
  },
  { idempotencyKey: `deposit-${appointment.id}` },
);
```

Four things to notice:

**`metadata.appointmentId`** is how the webhook finds the booking later. Stripe knows nothing
about our database; this one field is the entire join key. Put your id in metadata on every
object you create — you will always need it.

**`expires_at`** makes Stripe expire the session in 35 minutes, which fires
`checkout.session.expired` and releases the hold. The slot is held while the patient walks to
get their card, not forever.

**`idempotencyKey`** protects *us*. If our request times out and we retry, Stripe returns the
**same** session rather than creating a second one. Idempotency is something you ask for as a
client, not only something you provide as a server.

**The `catch`** releases the hold if Stripe fails after we inserted — the two-system write from
chapter 04. Without it a Stripe outage silently makes slots unbookable forever.

## Inbound: the five problems, and the defence for each

| Problem | What it means | Our defence |
|---|---|---|
| **Forgery** | anyone can POST `{"type":"checkout.session.completed"}` and get a free appointment | HMAC signature verified against `STRIPE_WEBHOOK_SECRET` |
| **Replay** | an attacker re-sends a genuine request they captured | the signature covers a **timestamp**; Stripe's SDK rejects anything older than 5 minutes |
| **Duplicates** | Stripe delivers *at least once* — the same event will arrive twice | `webhook_events` keyed by event id + idempotent handlers |
| **Retries** | anything that isn't 2xx is retried, with backoff, for up to 3 days | 500 **only** when we want a retry; 200 for everything else |
| **Ordering** | events can arrive out of order | handlers check current state (`WHERE status = 'pending_payment'`), never assume sequence |

## The route, in order

### 1. Raw body, then verify — never the other way round

```ts
const signature = req.headers.get('stripe-signature');
if (!signature) return new Response('Missing signature', { status: 400 });

const rawBody = await req.text();            // ← the exact bytes Stripe sent

let event: Stripe.Event;
try {
  event = stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
} catch {
  return new Response('Invalid signature', { status: 400 });
}
```

The signature is an HMAC over the **exact bytes**. `await req.json()` followed by
`JSON.stringify(body)` re-serialises with different key order and whitespace, so the hash differs
and verification fails — **every single time, against real Stripe**.

> **This is the canonical AI-generated bug in a webhook handler**, and the job description
> describes it almost verbatim: *"Passing mock tests proves the code is shaped right, not that
> the vendor accepts it."* The agent writes `req.json()` → `JSON.stringify` → `constructEvent`,
> and writes a test that **mocks `constructEvent`**. The test is green. The code has never once
> worked. It is caught only by a real event from `stripe listen`.
>
> Which is why `tests/stripe-webhook.test.ts` signs payloads for real with
> `stripe.webhooks.generateTestHeaderString({ payload, secret })` and never mocks the verifier.

In frameworks with a body-parser middleware (Express, Fastify) you must exempt this route from
it, or the middleware consumes the stream and you never see the raw bytes at all. In Next.js
App Router, `req.text()` gives them to you directly — but note `export const runtime = 'nodejs'`:
signature verification needs `node:crypto`, not the edge runtime.

Replay protection comes free with this step: Stripe's signature header includes a timestamp
that is part of the signed payload, and `constructEvent` rejects anything outside a 300-second
tolerance. A captured request is useless five minutes later.

### 2. Claim the event

```ts
const inserted = await db.insert(webhookEvents)
  .values({ id: event.id, type: event.type, status: 'processing' })
  .onConflictDoNothing()
  .returning({ id: webhookEvents.id });
if (inserted.length > 0) return true;        // first to see it — we own it
```

`webhook_events.id` **is** Stripe's `evt_…` id, so a duplicate collides on the primary key. One
statement, atomic, no `SELECT` first.

The re-claim path handles the two cases where a second delivery *should* be processed:

```ts
const staleBefore = new Date(Date.now() - 5 * 60_000);
const reclaimed = await db.update(webhookEvents)
  .set({ status: 'processing', lastAttemptAt: new Date(),
         attempts: sql`${webhookEvents.attempts} + 1` })
  .where(and(eq(webhookEvents.id, event.id), or(
    eq(webhookEvents.status, 'failed'),                                  // it failed: retry it
    and(eq(webhookEvents.status, 'processing'),                          // stuck 5+ min:
        lt(webhookEvents.lastAttemptAt, staleBefore)),                   // we crashed mid-handler
  )))
  .returning({ id: webhookEvents.id });
```

Without the stale-`processing` branch, a server crash mid-handler leaves the row stuck forever
and every retry is rejected as a duplicate — the payment is lost silently. The 5-minute window
is the bet that a handler taking longer than that has died.

`attempts: sql\`… + 1\`` increments **in SQL**. `attempts: row.attempts + 1` in JavaScript is a
read-modify-write that loses counts under concurrency.

A duplicate returns **200 with "Duplicate, already handled"** — not an error. We *did* handle it;
Stripe should stop asking.

### 3. Run the handler, and pick the status code deliberately

```ts
try {
  await handleStripeEvent(db, event);
  await db.update(webhookEvents).set({ status: 'processed', processedAt: new Date(), error: null })…
  return new Response('ok', { status: 200 });
} catch (err) {
  console.error(`Stripe webhook ${event.id} (${event.type}) failed`, err);
  await db.update(webhookEvents).set({ status: 'failed', error: … })…
  return new Response('Handler failed', { status: 500 });   // ← "please retry"
}
```

On a webhook endpoint a status code is **an instruction to the sender**, not a status report:

- **200** = done, forget it.
- **500** = try me again.

Two failure modes follow from getting this backwards, and both are real:

- Returning **200 in the catch** "to stop the retries" **silently loses payments**. The customer
  is charged, your database never learns, and nobody finds out until they arrive for an
  appointment that doesn't exist.
- Returning **500 for event types you don't handle** makes Stripe retry them for three days and
  eventually **disable your endpoint** — taking your real events down with it. Hence the
  `default: return;` in the handler and the 200 that follows.

## The handler: what an event *means*

The route owns verification and deduplication. `stripe-handler.ts` only decides meaning, and it
is written so that order does not matter:

```ts
case 'checkout.session.completed': {
  const session = event.data.object;                    // narrowed by event.type
  if (session.payment_status !== 'paid') return;        // delayed payment methods
  const metadata = SessionMetadata.safeParse(session.metadata);
  if (!metadata.success) throw new Error(`Checkout session ${session.id} has no appointmentId`);
  await confirmPayment(db, metadata.data.appointmentId);        // idempotent
  await syncToGoogleCalendar(db, metadata.data.appointmentId);  // idempotent
  return;
}
```

Three deliberate choices:

**`payment_status !== 'paid'` → return.** `checkout.session.completed` does not mean "money
arrived". With delayed payment methods the session completes and settles later. Confirming here
would give away appointments for free.

**`metadata` is parsed with Zod, not trusted.** The Stripe SDK types `metadata` as
`Record<string, string> | null` — it cannot know that *we* put an `appointmentId` there. A
session created by another integration, or a forged-but-validly-signed event from a compromised
key, would not have one. Zod at the boundary, as everywhere else.

**A missing `appointmentId` throws; an expired session with no metadata does not.** Asymmetric on
purpose: a *paid* session we can't match is a lost payment and must become a loud, retried
failure. An *expired* session we can't match has nothing to release, so skipping is correct.

## Two layers of idempotency, on purpose

The `webhook_events` table stops most duplicates. The handlers are *also* safe to run twice.
This is not belt-and-braces paranoia — each layer covers a gap the other has:

- The table can be bypassed by the stale-reclaim path (deliberately) or by a bug.
- The handlers can be bypassed by an event that never arrives at all.

So `confirmPayment` uses `WHERE status = 'pending_payment'` and the calendar sync supplies its
own event id. Either layer alone is enough for the common case; both are needed for the tails.

## Testing it against the real thing

Automated tests prove the shape. The Stripe CLI proves the vendor accepts it — and the job
description explicitly rejects *"claiming done on offline evidence when a live check was
available"*.

```bash
stripe login
stripe listen --forward-to localhost:3000/api/webhooks/stripe
# prints:  Ready! Your webhook signing secret is whsec_...
#          → put that in .env.local and restart `pnpm dev`

# book the HydraFacial at /book, pay with 4242 4242 4242 4242, any future expiry, any CVC
# the listen terminal should show 200s

stripe events resend evt_XXXX      # → 200 "Duplicate, already handled"
stripe trigger checkout.session.expired
```

Then check in `pnpm db:studio`: the appointment is `confirmed`, and `webhook_events` has exactly
**one** row with `status = 'processed'`.

Two production traps the CLI teaches you:
- The `whsec_` the CLI prints is **not** the dashboard endpoint's secret. Shipping the CLI's
  secret to production means every real webhook 400s.
- Stripe times out slow handlers and retries them. Heavy work (emails, PDFs, calendar sync at
  scale) belongs on a queue — enqueue and return 200 fast. Chapter 10.

## Vendors with no SDK

Half of the connector-platform job is vendors who just send an HMAC header and no library.
The pattern never changes:

```ts
export function verifyHmacSha256(rawBody: string, signatureHex: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(signatureHex, 'hex');
  // Length check FIRST: timingSafeEqual throws on a length mismatch, and a crash here
  // would be a 500 — i.e. an infinite retry loop — instead of a clean rejection.
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

`timingSafeEqual` rather than `===`: a normal comparison short-circuits on the first differing
byte, and the timing difference leaks how many leading bytes matched, which is enough to forge a
signature byte by byte. The length guard is not decoration either — that line is the difference
between "rejected" and "crashed", and `tests/verify-hmac.test.ts` pins it.

## The interview answer

> "I verify the HMAC over the raw body before parsing anything, which also covers replay because
> Stripe's signature includes a timestamp with a five-minute tolerance. I record each event id
> with an insert-on-conflict so a duplicate delivery is acknowledged without reprocessing, with a
> reclaim path for events that failed or got stuck in processing when a server died. The handlers
> are independently idempotent using conditional updates, so order doesn't matter — an `expired`
> event arriving after payment can't cancel a confirmed booking. I return 500 only when I want a
> retry, and 200 for event types I ignore, because a 500 there gets your endpoint disabled after
> three days of retries. And I tested it with `stripe listen` including resending the same event,
> because a mocked verifier will pass while real Stripe returns 400."
