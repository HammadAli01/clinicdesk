---
name: stripe
description: How ClinicDesk integrates Stripe — creating Checkout sessions for deposits, handling webhooks idempotently, and testing with the Stripe CLI. Use for any payment, refund or webhook work.
---

# Stripe in ClinicDesk

## Files
- `src/server/stripe.ts`: the Stripe client.
- `src/server/services/checkout.ts`: `bookWithDeposit` (creates the Checkout session).
- `src/app/api/webhooks/stripe/route.ts`: verify → claim event → handle → record.
- `src/server/webhooks/stripe-handler.ts`: `switch (event.type)` business logic.
- Table `webhook_events`: one row per Stripe event id (status processing / processed / failed).

## Outgoing calls (we call Stripe)
- Always pass an `idempotencyKey` derived from OUR ids (e.g. `deposit-${appointment.id}`,
  `refund-${session.id}`), so retries never create duplicates.
- Put our ids in `metadata` (e.g. `appointmentId`); that's how webhooks find our records.
- If our DB write succeeded and the Stripe call fails, undo or compensate (see `releaseUnpaidHold`).
- Amounts are integer cents.

## Incoming webhooks (Stripe calls us)
1. `const raw = await req.text()`. NEVER `req.json()` before verifying.
2. `stripe.webhooks.constructEvent(raw, signature, env.STRIPE_WEBHOOK_SECRET)`. It also rejects old
   timestamps (replay protection). Invalid → 400.
3. `claimEvent`: insert on conflict do nothing; reclaim only `failed` or stale `processing` with a
   conditional UPDATE. Not claimed → 200 "Duplicate".
4. Handler must be idempotent on its own: conditional updates like
   `WHERE status = 'pending_payment'`. Don't assume event order.
5. Success → mark processed, 200. Failure → mark failed, 500 (Stripe retries for up to 3 days).
6. Unhandled event types → 200 (otherwise Stripe retries them).
7. Keep the handler fast. Slow side effects belong in a queue in production.

## Adding a new event type
1. Add a `case` in `stripe-handler.ts`, narrowing via `event.type` (no casts).
2. Make it idempotent and order-independent.
3. Add a test in `tests/stripe-webhook.test.ts`: signed payload, delivered twice, asserting one effect.
4. Subscribe to it: locally `stripe listen` forwards all events; in production add it to the
   Dashboard endpoint.

## Verify against the real thing (required before "done")
```
stripe listen --forward-to localhost:3000/api/webhooks/stripe   # copy whsec_ into .env.local (the user does this)
stripe trigger checkout.session.completed                        # or pay on /book with 4242 4242 4242 4242
```
Then check the terminal shows 200s, and in `pnpm db:studio` that the appointment and `webhook_events`
rows are right. Re-send the same event and confirm "Duplicate". Mock tests alone are NOT enough.
