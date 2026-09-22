// Booking + deposit, in one place.
//
// This is the only function in the codebase that writes to TWO systems in one
// operation: our database and Stripe. Every two-system write has the same
// question hanging over it — "what if the second one fails?" — and the answer
// has to be written down, not assumed. See the catch block at the bottom.

import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import { env } from '@/env';
import type { Db } from '@/server/db';
import { appointments } from '@/server/db/schema';
import { bookAppointment, releaseUnpaidHold, type BookInput } from './bookings';

/** Dependencies passed in, never imported — that is what makes this testable. */
export type Deps = { db: Db; stripe: Stripe };

/** How long we hold a slot for an unpaid deposit before Stripe expires the session. */
export const DEPOSIT_HOLD_MINUTES = 35;

export async function bookWithDeposit(deps: Deps, input: BookInput) {
  // All the booking RULES live in bookAppointment. This function only adds money.
  const { appointment, service } = await bookAppointment(deps.db, input);

  const summary = {
    appointmentId: appointment.id,
    status: appointment.status,
    startsAt: appointment.startsAt,
  };

  // No deposit required: bookAppointment already marked it confirmed.
  if (service.depositCents === 0) return { ...summary, checkoutUrl: null };

  try {
    const session = await deps.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: service.depositCents, // integer cents, never a float
              product_data: { name: `Deposit: ${service.name}` },
            },
          },
        ],
        // The ONLY link between a Stripe session and our row. The webhook reads
        // this back — see src/server/webhooks/stripe-handler.ts.
        metadata: { appointmentId: appointment.id },
        success_url: `${env.APP_URL}/book?paid=${appointment.id}`,
        cancel_url: `${env.APP_URL}/book`,
        // Stripe expires the session, which fires checkout.session.expired and
        // releases the hold. The jobs runner sweeps up anything that webhook
        // never delivered (see src/server/jobs/handlers.ts).
        expires_at: Math.floor(Date.now() / 1000) + DEPOSIT_HOLD_MINUTES * 60,
      },
      {
        // If OUR request times out and the caller retries, Stripe returns the
        // SAME session rather than creating a second one and charging twice.
        // Idempotency on the way OUT, mirroring what we do on the way IN.
        idempotencyKey: `deposit-${appointment.id}`,
      },
    );

    await deps.db
      .update(appointments)
      .set({ stripeCheckoutSessionId: session.id })
      .where(eq(appointments.id, appointment.id));

    return { ...summary, checkoutUrl: session.url };
  } catch (e) {
    // Stripe failed AFTER we inserted the appointment. Without this, the slot
    // stays blocked in pending_payment forever and nobody can book it — an
    // invisible failure that only shows up as "why is Tuesday always full?".
    await releaseUnpaidHold(deps.db, appointment.id);

    // Known asymmetry, accepted deliberately: if the failure was the db.update
    // above rather than the Stripe call, a Checkout session now exists that we
    // are not tracking. We do NOT call stripe.checkout.sessions.expire() here,
    // because (a) `session.url` was never returned to the caller, so nobody can
    // reach it, and (b) it expires by itself at `expires_at`, ~35 minutes out.
    // Adding a second network call inside an error path buys a little tidiness
    // and risks throwing over the top of the original error, which is the one
    // worth seeing. Flagged in review; this comment is the decision.
    throw e;
  }
}
