// Stripe webhook endpoint. Order of operations matters:
//   1. Read the RAW body and verify its signature before touching it as JSON.
//   2. Claim the event id (webhook_events) so a duplicate delivery is a no-op.
//   3. Run the business logic (stripe-handler.ts) and record the outcome.
//
// This is a public endpoint -- anyone on the internet can POST to it, and the real
// sender (Stripe) WILL deliver the same event more than once. Every step below exists
// because of one of those two facts.
//
// What a webhook IS, in one line: instead of us polling Stripe ("has anyone paid yet?"),
// Stripe calls US with an HTTP POST when something happens. "Don't call us, we'll call you."
//
// The status code we return is an INSTRUCTION to Stripe, not a report:
//   2xx  -> "got it, stop sending"      4xx/5xx -> "failed, send it again later" (with backoff)
// So we return 500 only when we genuinely want a retry. See docs/08-stripe-and-webhooks.md.

import { and, eq, lt, or, sql } from "drizzle-orm";
// `import type` pulls in TypeScript types only (Stripe.Event); it's erased at build time.
import type Stripe from "stripe";
import { env } from "@/env";
import { db } from "@/server/db";
import { webhookEvents } from "@/server/db/schema";
import { stripe } from "@/server/stripe";
import { handleStripeEvent } from "@/server/webhooks/stripe-handler";

// Next.js "route segment config": a special named export Next reads to decide HOW to run this file.
export const runtime = "nodejs"; // needs node:crypto (via the Stripe SDK), not the edge runtime

/** Returns true if THIS request should process the event (it now "owns" the row). */
async function claimEvent(event: Stripe.Event): Promise<boolean> {
  // First time we see this id: the insert succeeds and we own it outright.
  // `onConflictDoNothing()` = SQL `ON CONFLICT DO NOTHING`: if a row with this primary key
  // (Stripe's evt_... id) already exists, skip silently instead of erroring. `.returning()`
  // then gives back [] for a duplicate and [row] for a fresh insert -- one atomic statement,
  // no "SELECT first, then INSERT" race window.
  const inserted = await db
    .insert(webhookEvents)
    .values({ id: event.id, type: event.type, status: "processing" })
    .onConflictDoNothing()
    .returning({ id: webhookEvents.id });
  if (inserted.length > 0) return true;

  // Seen before. Re-claim only if the last attempt failed, or got stuck in "processing" for
  // 5+ minutes (the server crashed mid-handler). The UPDATE's WHERE is the whole safety
  // property: it's atomic, so two concurrent retries can't both return a claimed row.
  const staleBefore = new Date(Date.now() - 5 * 60_000);
  const reclaimed = await db
    .update(webhookEvents)
    // sql`...` is a tagged template: Drizzle turns it into raw SQL `attempts + 1`, so the
    // increment happens INSIDE the database (safe under concurrency), not in JavaScript.
    .set({ status: "processing", lastAttemptAt: new Date(), attempts: sql`${webhookEvents.attempts} + 1` })
    .where(
      and(
        eq(webhookEvents.id, event.id),
        or(
          eq(webhookEvents.status, "failed"),
          and(eq(webhookEvents.status, "processing"), lt(webhookEvents.lastAttemptAt, staleBefore)),
        ),
      ),
    )
    .returning({ id: webhookEvents.id });
  return reclaimed.length > 0;
}

export async function POST(req: Request) {
  // Header looks like `t=1727000000,v1=5257a869...`: a timestamp plus an HMAC-SHA256 of
  // `${t}.${rawBody}` computed with the shared secret (STRIPE_WEBHOOK_SECRET, "whsec_...").
  const signature = req.headers.get("stripe-signature");
  // 400 = "your request is bad". Stripe will retry, but a forger gets nothing.
  if (!signature) return new Response("Missing signature", { status: 400 });

  // The RAW body. The signature covers the exact bytes Stripe sent -- req.json() then
  // JSON.stringify() would re-serialize with different whitespace/key order and fail
  // verification every time.
  const rawBody = await req.text();

  // Declared with `let` outside the try so it's usable after it. TypeScript's definite-assignment
  // analysis knows the catch always returns, so `event` is guaranteed set below.
  let event: Stripe.Event;
  try {
    // Checks the HMAC AND that the timestamp is recent (replay protection, default 300s).
    // Only AFTER this succeeds do we trust (and JSON-parse) the body -- constructEvent does both.
    event = stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch {
    // `catch {` with no variable: we don't need the error, just the fact that it failed.
    return new Response("Invalid signature", { status: 400 });
  }

  if (!(await claimEvent(event))) {
    // 200, not an error: we already handled (or are handling) it, so Stripe should stop asking.
    return new Response("Duplicate, already handled", { status: 200 });
  }

  try {
    await handleStripeEvent(db, event);
    await db
      .update(webhookEvents)
      .set({ status: "processed", processedAt: new Date(), error: null })
      .where(eq(webhookEvents.id, event.id));
    return new Response("ok", { status: 200 });
  } catch (err) {
    // Never answer 200 here "to make the retries stop": that would silently lose a payment.
    console.error(`Stripe webhook ${event.id} (${event.type}) failed`, err);
    await db
      .update(webhookEvents)
      // `catch (err)` gives `unknown` in strict TS (anything can be thrown), so narrow first.
      .set({ status: "failed", error: err instanceof Error ? err.message : String(err) })
      .where(eq(webhookEvents.id, event.id));
    return new Response("Handler failed", { status: 500 }); // ask Stripe to retry
  }
}
