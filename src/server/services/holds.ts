// Safety net for deposit holds that never got released.
//
// bookWithDeposit (checkout.ts) puts a slot in pending_payment and asks Stripe
// to expire the Checkout session after DEPOSIT_HOLD_MINUTES. When it expires,
// Stripe sends checkout.session.expired and the webhook calls
// releaseUnpaidHold. Webhooks are not guaranteed to arrive -- if that
// delivery is lost, the slot stays blocked forever. This sweep is the
// guarantee behind that fast path: a periodic job (see src/server/jobs/*)
// calls releaseExpiredHolds to catch anything the webhook missed.

import { and, eq, lt } from "drizzle-orm";
import type { Db } from "@/server/db";
import { appointments } from "@/server/db/schema";
import { DEPOSIT_HOLD_MINUTES } from "./checkout";

// Grace margin past Stripe's own expiry (DEPOSIT_HOLD_MINUTES), so the sweep
// never races the checkout.session.expired webhook -- it only cleans up
// holds the webhook has already had a fair chance to release.
const DEFAULT_GRACE_MINUTES = 5;

/**
 * Release any appointment still `pending_payment` after its deposit hold has
 * expired. One conditional UPDATE, not select-then-update -- the same
 * pattern as releaseUnpaidHold in bookings.ts, so it's race-safe and safe to
 * call repeatedly (a second sweep releases nothing new).
 */
export async function releaseExpiredHolds(
  db: Db,
  // `opts?` = the whole argument may be omitted; `now?` = each field is optional too.
  opts?: { now?: Date; olderThanMinutes?: number },
  // Explicit return type: an async function always returns a Promise of its value.
): Promise<{ released: string[] }> {
  // `?.` (optional chaining): if opts is undefined, `opts?.now` is undefined instead of crashing.
  // `??` (nullish coalescing): use the right side only when the left is null/undefined
  // (unlike `||`, a legitimate 0 would be kept).
  const now = opts?.now ?? new Date();
  const olderThanMinutes = opts?.olderThanMinutes ?? DEPOSIT_HOLD_MINUTES + DEFAULT_GRACE_MINUTES;
  const cutoff = new Date(now.getTime() - olderThanMinutes * 60_000);

  const rows = await db
    .update(appointments)
    .set({ status: "cancelled" })
    .where(and(eq(appointments.status, "pending_payment"), lt(appointments.createdAt, cutoff)))
    .returning({ id: appointments.id });

  return { released: rows.map((r) => r.id) }; // arrow function with an implicit return
}
