// Business logic for Stripe webhook events. The route (src/app/api/webhooks/stripe/route.ts)
// owns verification and deduplication; this file only decides what an event MEANS.
//
// Two rules make this safe to call more than once, in any order:
//  1. Every handler ends in an idempotent service call (confirmPayment / releaseUnpaidHold /
//     syncToGoogleCalendar all use conditional WHERE clauses or our own deterministic ids).
//  2. Nothing here assumes event ORDER. `checkout.session.expired` only cancels a booking that
//     is still `pending_payment` -- if `checkout.session.completed` already confirmed it, the
//     conditional update in releaseUnpaidHold matches zero rows and does nothing.

import { z } from "zod";
import type Stripe from "stripe";
import type { Db } from "@/server/db";
import { confirmPayment, releaseUnpaidHold } from "@/server/services/bookings";
import { syncToGoogleCalendar } from "@/server/services/calendar";

// `session.metadata` is `Record<string, string> | null` on the wire -- Stripe never guarantees
// WE put an appointmentId there (a hand-crafted event, or a session created by other code,
// wouldn't have one). Validate it at this boundary rather than trusting the SDK's typing.
const SessionMetadata = z.object({ appointmentId: z.uuid() });

export async function handleStripeEvent(db: Db, event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object; // narrowed to Stripe.Checkout.Session by event.type

      // Checkout can complete with an unpaid session for delayed payment methods
      // (e.g. bank debits); only a "paid" session should confirm the booking.
      if (session.payment_status !== "paid") return;

      const metadata = SessionMetadata.safeParse(session.metadata);
      if (!metadata.success) {
        // Unexpected: every session we create sets this. Throwing marks the webhook_events
        // row "failed" so it's retried and shows up in logs instead of silently dropping
        // a paid booking.
        throw new Error(`Checkout session ${session.id} has no appointmentId in metadata`);
      }

      await confirmPayment(db, metadata.data.appointmentId); // idempotent
      await syncToGoogleCalendar(db, metadata.data.appointmentId); // idempotent (our own event id)
      return;
    }

    case "checkout.session.expired": {
      const session = event.data.object;
      const metadata = SessionMetadata.safeParse(session.metadata);
      // Unlike `completed`, a missing/invalid appointmentId here isn't our problem to fix --
      // there's nothing to release -- so skip instead of failing the webhook.
      if (metadata.success) await releaseUnpaidHold(db, metadata.data.appointmentId); // only if still pending
      return;
    }

    default:
      // Events we don't act on: acknowledge with 200 (via the route) so Stripe stops sending
      // them. Returning 500 here would make Stripe retry for up to 3 days and eventually
      // disable the endpoint.
      return;
  }
}
