// Stripe webhook endpoint. Order of operations matters:
//   1. Read the RAW body and verify its signature before touching it as JSON.
//   2. Claim the event id (webhook_events) so a duplicate delivery is a no-op.
//   3. Run the business logic (stripe-handler.ts) and record the outcome.
//
// This is a public endpoint -- anyone on the internet can POST to it, and the real
// sender (Stripe) WILL deliver the same event more than once. Every step below exists
// because of one of those two facts.

import { and, eq, lt, or, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { env } from "@/env";
import { db } from "@/server/db";
import { webhookEvents } from "@/server/db/schema";
import { stripe } from "@/server/stripe";
import { handleStripeEvent } from "@/server/webhooks/stripe-handler";

export const runtime = "nodejs"; // needs node:crypto (via the Stripe SDK), not the edge runtime

/** Returns true if THIS request should process the event (it now "owns" the row). */
async function claimEvent(event: Stripe.Event): Promise<boolean> {
  // First time we see this id: the insert succeeds and we own it outright.
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
  const signature = req.headers.get("stripe-signature");
  if (!signature) return new Response("Missing signature", { status: 400 });

  // The RAW body. The signature covers the exact bytes Stripe sent -- req.json() then
  // JSON.stringify() would re-serialize with different whitespace/key order and fail
  // verification every time.
  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    // Checks the HMAC AND that the timestamp is recent (replay protection, default 300s).
    event = stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch {
    return new Response("Invalid signature", { status: 400 });
  }

  if (!(await claimEvent(event))) {
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
    console.error(`Stripe webhook ${event.id} (${event.type}) failed`, err);
    await db
      .update(webhookEvents)
      .set({ status: "failed", error: err instanceof Error ? err.message : String(err) })
      .where(eq(webhookEvents.id, event.id));
    return new Response("Handler failed", { status: 500 }); // ask Stripe to retry
  }
}
